/**
 * Host git face (0.3.0): the ONLY place dsh-taskboard shells out to git.
 * 0.3.1: per-repo serialization of structural operations, binary probing,
 * no-op merge detection, worktree REUSE mode, and evidence size caps.
 * 0.10.1 本地改造：worktree 的建立与删除整体移交官方
 * @deepseek-ai/dsh-experimental-worktree 服务（见 src/local/official-worktree.ts
 * 与 host/isolation.ts）——本面不再有自建 prepareWorktree / removeWorktree；
 * 这里只剩 git 收尾与只读面（证据采集 / merge / 删分支 / diff）。
 *
 * Design invariants (plan §3.4/§3.5):
 * - NARROW interface: detect / binaryAvailable / headOf / collect /
 *   dirtyLines / merge / isAncestor / deleteBranch / showCommit / showPathDiff
 *   — nothing else leaks into the plugin.
 * - FAIL-SOFT: every call has a timeout and resolves to a benign result
 *   (false / undefined / empty facts) on ANY git failure — a missing git,
 *   a locked worktree, or a damaged repo degrades execution to the original
 *   directory and NEVER fails the ledger or the run pipeline. Only the
 *   explicit user actions (merge / deleteBranch) throw, with a
 *   readable message the GUI surfaces as-is.
 * - SERIALIZED structural ops: concurrent merges on the SAME repository
 *   would race on git's index locks, so every structural operation
 *   (merge / deleteBranch) runs inside a per-root in-process mutex.
 *   Read-only collects stay concurrent.
 * - INJECTABLE runner: the exec layer is a single function so unit tests
 *   script every path without a real git.
 *
 * @module dsh-taskboard/host/git
 */
import { resolve } from 'node:path'
import { OFFICIAL_POOL_ROOT_DIR } from '../local/official-worktree.ts'
import { buildBranchName, DEFAULT_BRANCH_NAME_MODE, DEFAULT_BRANCH_NAME_PREFIX, type CommitInfo } from '../shared/protocol.ts'

/** Timeout for quick read-only queries (rev-parse / status / log / diff). */
const QUICK_TIMEOUT_MS = 2_000

/** Timeout for structural operations (merge, branch -D). */
const HEAVY_TIMEOUT_MS = 15_000

/**
 * The path segment of one `status --porcelain` line. Shape-aware: the RAW
 * line is `XY path` (path at index 3) while the plugin's trimmed evidence
 * lines collapse a leading-space status to `X path` (path at index 2) —
 * slicing a fixed 3 misparses exactly the gitlink/unstaged shapes a
 * multi-repo mirror produces (` M sub-repo`), 0.6.3 review fix.
 */
export function statusLinePath(line: string): string {
  if (line.length >= 3 && line[2] === ' ') return line.slice(3)
  if (line.length >= 2 && line[1] === ' ') return line.slice(2)
  return line
}

/**
 * Whether a `status --porcelain` line targets one of `rels` (a repo-relative
 * path) or anything under it. Porcelain prints untracked directories with a
 * trailing slash (`?? sub/`), so all three shapes match. Empty rels never
 * match (0.6.3 review fix).
 */
export function statusLineUnder(line: string, rels: readonly string[]): boolean {
  const p = statusLinePath(line)
  return rels.some(rel => rel.length > 0 && (p === rel || p === rel + '/' || p.startsWith(rel + '/')))
}

/** Evidence caps: commits kept per execution record (newest first). */
export const MAX_COMMIT_EVIDENCE = 50

/** Evidence caps: uncommitted-change lines kept per execution record. */
export const MAX_DIRTY_EVIDENCE = 100

/** Diff viewer caps (0.4.0): raw text kept per view. */
export const MAX_DIFF_BYTES = 128 * 1024

/** Diff viewer caps: lines kept per view. */
export const MAX_DIFF_LINES = 2_000

/** One capped, read-only diff view (diff viewer, 0.4.0). */
export interface DiffResult {
  text: string
  truncated: boolean
}

/** Cap one diff payload by bytes and lines (in order, marking truncation). */
function capDiff(out: string): DiffResult {
  let text = out
  let truncated = false
  if (text.length > MAX_DIFF_BYTES) {
    text = text.slice(0, MAX_DIFF_BYTES)
    truncated = true
  }
  const lines = text.split('\n')
  if (lines.length > MAX_DIFF_LINES) {
    text = lines.slice(0, MAX_DIFF_LINES).join('\n')
    truncated = true
  }
  return { text, truncated }
}

/** A plausible git object hash (defense against option injection). */
function isHash(hash: string): boolean {
  return /^[0-9a-f]{4,64}$/i.test(hash)
}

/** Result of one underlying exec: `ok` is exit-0, output never null. */
export interface ExecResult { ok: boolean; stdout: string; stderr: string }

/** The injectable exec layer: run `git <args>` under a cwd with a timeout. */
export type ExecFn = (args: string[], options: { cwd?: string; timeout?: number }) => Promise<ExecResult>

/** Settlement facts collected from a worktree (partial on best-effort basis). */
export interface SettlementFacts {
  headCommit?: string
  commits: CommitInfo[]
  /** Total commits before capping (equals commits.length when under the cap). */
  commitsTotal: number
  dirtyFiles: string[]
  /** Total uncommitted lines before capping. */
  dirtyFilesTotal: number
  diffStat?: string
  changedFiles: number
}

/** The narrow git face the rest of the plugin depends on. */
export interface GitFace {
  /** Whether `root` sits inside a usable git work tree (fail-soft → false). */
  detect(root: string): Promise<boolean>
  /** Whether a usable git binary answers at all (distinguishes 未装 git vs 非 git 仓库). */
  binaryAvailable(): Promise<boolean>
  /**
   * HEAD of a working tree (`rev-parse HEAD`), or undefined on any failure —
   * the liveness probe and evidence baseline for a REUSED official checkout
   * (0.10.1): a readable HEAD proves the checkout is alive.
   */
  headOf(cwd: string): Promise<string | undefined>
  /**
   * Collect settlement facts (never throws; missing pieces stay unset).
   * `excludeRelPaths` drops `status --porcelain` lines targeting those
   * repo-relative paths (or anything under them) — legacy-mirror leftovers
   * read as untracked noise in the root worktree's status and are not this
   * repo's uncommitted changes (0.6.3 review fix).
   */
  collect(worktreePath: string, baseCommit: string, excludeRelPaths?: readonly string[]): Promise<SettlementFacts>
  /**
   * Uncommitted-change lines of a working tree ([] = clean; undefined on git
   * failure or when cwd is not the worktree root). Undefined is UNKNOWN,
   * never clean: destructive callers must refuse it.
   */
  dirtyLines(cwd: string): Promise<string[] | undefined>
  /**
   * Merge `branch` into the main worktree (`--no-ff`); THROWS with a readable
   * reason. `exemptRelPaths` extends the main-clean exemption beyond the
   * official worktree pool (`.agents/`): uncommitted-shape noise under those
   * repo-relative paths (legacy mirror leftovers / agent scratch) doesn't
   * gate the merge (0.6.3 review fix).
   */
  merge(root: string, branch: string, exemptRelPaths?: readonly string[]): Promise<void>
  /** Whether `branch` is already an ancestor of HEAD (a merge would be a no-op). */
  isAncestor(root: string, branch: string): Promise<boolean>
  /** Delete a branch; THROWS (e.g. still checked out in a worktree). */
  deleteBranch(root: string, branch: string): Promise<void>
  /**
   * Remove one official checkout (`git worktree remove` + prune) — the git
   * cleanup helper behind USER-driven removals (task detail button / orphan
   * cleanup), distinct from the official service's own session-archive
   * reclamation. THROWS with a readable reason; a dirty checkout is refused
   * (unknown state → unknown), never force-deleted.
   */
  removeCheckout(root: string, worktreePath: string): Promise<void>
  /**
   * Show one commit (message + patch) — diff viewer (0.4.0). Fail-soft:
   * undefined on any git failure; the payload is capped.
   */
  showCommit(cwd: string, hash: string): Promise<DiffResult | undefined>
  /**
   * Show the diff of one path — diff viewer (0.4.0). Without `baseCommit`:
   * the working-tree view (staged + unstaged vs HEAD, e.g. uncommitted
   * changes in a live worktree); with `baseCommit`: the range
   * base..HEAD restricted to the path. Fail-soft: undefined on failure.
   */
  showPathDiff(cwd: string, path: string, baseCommit?: string): Promise<DiffResult | undefined>
}

/**
 * Build the task branch name `task/<标题>+<taskId>` (plan §9 拍板).
 *
 * Title sanitizing: whitespace runs collapse to `-`; git-illegal characters
 * (`~ ^ : ? * [ \ / @ { }` and friends) are stripped; `..` collapses; the
 * segment is trimmed of leading/trailing `.-` and truncated to ~20 code
 * points; an empty result falls back to the bare `task/<taskId>`.
 *
 * Since issue #98 this delegates to the shared {@link buildBranchName} under
 * the factory-default preset, which reproduces the legacy output byte for
 * byte; the board may pick another preset instead.
 * @param title - the task title (already normalized 1..200 chars).
 * @param taskId - the task id (stable suffix).
 * @returns the branch name.
 */
export function sanitizeBranchName(title: string, taskId: string): string {
  return buildBranchName(title, taskId, DEFAULT_BRANCH_NAME_MODE, DEFAULT_BRANCH_NAME_PREFIX)
}

/** Real exec layer over child_process.execFile (windowsHide, timeout, maxBuffer). */
const realExec: ExecFn = (args, options) => new Promise(resolve => {
  void (async () => {
    const { execFile } = await import('node:child_process')
    execFile('git', args, {
      cwd: options.cwd,
      timeout: options.timeout ?? QUICK_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      resolve({ ok: error === null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
    })
  })().catch(() => resolve({ ok: false, stdout: '', stderr: 'exec unavailable' }))
})

/**
 * Build a {@link GitFace} over an injectable exec layer.
 * @param exec - the exec function (real `git` when omitted).
 */
export function createGitFace(exec: ExecFn = realExec): GitFace {
  const quick = (args: string[], cwd?: string): Promise<ExecResult> => exec(args, { cwd, timeout: QUICK_TIMEOUT_MS })
  const heavy = (args: string[], cwd?: string): Promise<ExecResult> => exec(args, { cwd, timeout: HEAVY_TIMEOUT_MS })

  const dirtyLines = async (cwd: string): Promise<string[] | undefined> => {
    try {
      const status = await quick(['status', '--porcelain'], cwd)
      if (!status.ok) return undefined
      // A leftover with no .git can inherit the MAIN repo's clean status.
      // Only the requested worktree's own status can authorize its removal.
      const top = await quick(['rev-parse', '--show-toplevel'], cwd)
      const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
      if (!top.ok || top.stdout.trim().length === 0 || normalize(top.stdout.trim()) !== normalize(cwd)) return undefined
      return status.stdout.split('\n').map(l => l.trim()).filter(l => l.length > 0)
    } catch { return undefined }
  }

  // Per-root mutex (0.3.1): structural git ops on the SAME repository run one
  // at a time — concurrent isolated executions must not race on git's locks.
  const locks = new Map<string, Promise<unknown>>()
  const withRootLock = <T>(root: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(root) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    locks.set(root, next.catch(() => { /* the chain never blocks later ops */ }))
    return next
  }

  return {
    async detect(root) {
      const r = await quick(['rev-parse', '--is-inside-work-tree'], root)
      return r.ok && r.stdout.trim() === 'true'
    },

    async binaryAvailable() {
      const r = await quick(['--version'])
      return r.ok && r.stdout.startsWith('git version')
    },

    async headOf(cwd) {
      try {
        const r = await quick(['rev-parse', 'HEAD'], cwd)
        if (!r.ok) return undefined
        const head = r.stdout.trim()
        return head.length > 0 ? head : undefined
      } catch {
        return undefined
      }
    },

    async collect(worktreePath, baseCommit, excludeRelPaths) {
      const facts: SettlementFacts = { commits: [], commitsTotal: 0, dirtyFiles: [], dirtyFilesTotal: 0, changedFiles: 0 }
      const range = `${baseCommit}..HEAD`

      const head = await quick(['rev-parse', 'HEAD'], worktreePath)
      if (head.ok) facts.headCommit = head.stdout.trim()

      const log = await quick(['log', '--pretty=format:%h %s', range], worktreePath)
      if (log.ok) {
        const commits = log.stdout.split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .map(line => {
            const space = line.indexOf(' ')
            return space === -1
              ? { hash: line, subject: '' }
              : { hash: line.slice(0, space), subject: line.slice(space + 1) }
          })
        // Evidence caps (0.3.1): the ledger is rewritten whole on every
        // mutation — cap what a huge branch/status dump can add to it.
        facts.commitsTotal = commits.length
        facts.commits = commits.slice(0, MAX_COMMIT_EVIDENCE)
      }

      const status = await quick(['status', '--porcelain'], worktreePath)
      if (status.ok) {
        // excludeRelPaths drops the mirror's nested repo worktrees — they
        // read as untracked noise / gitlink drift here, not as this repo's
        // uncommitted changes. Excluded on the RAW line (path extraction is
        // shape-aware); the stored evidence keeps its trimmed 0.3.x shape.
        const dirty = status.stdout.split('\n')
          .filter(l => l.trim().length > 0)
          .filter(l => !statusLineUnder(l, excludeRelPaths ?? []))
          .map(l => l.trim())
        facts.dirtyFilesTotal = dirty.length
        facts.dirtyFiles = dirty.slice(0, MAX_DIRTY_EVIDENCE)
      }

      const shortstat = await quick(['diff', '--shortstat', range], worktreePath)
      if (shortstat.ok && shortstat.stdout.trim().length > 0) facts.diffStat = shortstat.stdout.trim()

      const names = await quick(['diff', '--name-only', range], worktreePath)
      if (names.ok) facts.changedFiles = names.stdout.split('\n').filter(l => l.trim().length > 0).length

      return facts
    },

    dirtyLines,

    merge: (root, branch, exemptRelPaths) => withRootLock(root, async () => {
      // Main-clean check. The official worktree pool (<root>/.agents) shows up
      // as untracked noise and is EXEMPT — the pool carries its own .gitignore
      // but the parent directory can still surface when the pool is absent or
      // freshly created, and git noise must never gate a merge.
      const status = await quick(['status', '--porcelain'], root)
      if (status.ok) {
        const dirtyLines = status.stdout.split('\n')
          .filter(l => l.trim().length > 0)
          .filter(l => !statusLineUnder(l, [OFFICIAL_POOL_ROOT_DIR, ...(exemptRelPaths ?? [])]))
          .map(l => l.trim())
        if (dirtyLines.length > 0) {
          // Machine-readable tag: callers classify without parsing zh-CN text.
          throw Object.assign(new Error(`主工作区有 ${dirtyLines.length} 处未提交修改，请先提交或暂存后再合并`), { code: 'dirty-tree' })
        }
      }
      const merged = await heavy(['merge', '--no-ff', '--no-edit', branch], root)
      if (!merged.ok) {
        // Roll the half-finished merge back so the main worktree stays usable;
        // report the ORIGINAL failure verbatim (不自动解决冲突).
        await heavy(['merge', '--abort'], root)
        throw new Error(`合并失败：${merged.stderr.trim().slice(0, 300)}`)
      }
    }),

    async isAncestor(root, branch) {
      // exit 0 = branch is an ancestor of (or equal to) HEAD → merge no-op.
      const r = await quick(['merge-base', '--is-ancestor', branch, 'HEAD'], root)
      return r.ok
    },

    deleteBranch: (root, branch) => withRootLock(root, async () => {
      const deleted = await heavy(['branch', '-D', branch], root)
      if (!deleted.ok) throw new Error(`删除分支失败：${deleted.stderr.trim().slice(0, 300)}`)
    }),

    removeCheckout: (root, worktreePath) => withRootLock(root, async () => {
      // Unknown state is NEVER clean: refuse instead of force-removing (0.3.0 rule).
      const dirty = await dirtyLines(worktreePath)
      if (dirty === undefined) {
        throw Object.assign(new Error('无法确认该检出目录的状态（git 不可用或目录缺失），拒绝删除'), { code: 'worktree-status-unavailable' })
      }
      if (dirty.length > 0) {
        throw Object.assign(new Error(`检出目录有 ${dirty.length} 处未提交修改，请先提交或手动处理后再删除`), { code: 'dirty-worktree' })
      }
      const removed = await heavy(['worktree', 'remove', '--', worktreePath], root)
      if (!removed.ok) throw new Error(`删除 worktree 失败：${removed.stderr.trim().slice(0, 300)}`)
      // Drop stale admin metadata (e.g. a manually deleted checkout dir).
      await heavy(['worktree', 'prune'], root)
    }),

    async showCommit(cwd, hash) {
      if (!isHash(hash)) return undefined
      const r = await quick(['show', '--no-color', '--format=medium', hash], cwd)
      if (!r.ok || r.stdout.trim().length === 0) return undefined
      return capDiff(r.stdout)
    },

    async showPathDiff(cwd, path, baseCommit) {
      const target = path.trim()
      if (target.length === 0) return undefined
      if (baseCommit !== undefined && isHash(baseCommit)) {
        const r = await quick(['diff', '--no-color', `${baseCommit}..HEAD`, '--', target], cwd)
        if (!r.ok) return undefined
        if (r.stdout.trim().length === 0) return { text: '（该文件无差异）', truncated: false }
        return capDiff(r.stdout)
      }
      // Working-tree view: staged + unstaged vs HEAD.
      const r = await quick(['diff', '--no-color', 'HEAD', '--', target], cwd)
      if (r.ok && r.stdout.trim().length > 0) return capDiff(r.stdout)
      // Untracked files never appear in `git diff` — detect one and synthesize
      // its new-file patch via --no-index (which exits 1 on differences, so
      // its stdout is trusted whenever it carries a diff header).
      const st = await quick(['status', '--porcelain', '--', target], cwd)
      if (r.ok && st.ok && st.stdout.trim().startsWith('??')) {
        const ni = await exec(['diff', '--no-color', '--no-index', '--', '/dev/null', target], { cwd, timeout: QUICK_TIMEOUT_MS })
        if (ni.stdout.includes('diff --git')) return capDiff(ni.stdout)
        return { text: `（未跟踪新文件：${target}）`, truncated: false }
      }
      if (!r.ok) return undefined
      return { text: '（该文件无差异）', truncated: false }
    },
  }
}
