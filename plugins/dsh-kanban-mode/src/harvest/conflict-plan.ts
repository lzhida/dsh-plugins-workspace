/**
 * 冲突文件结构化建议:把进行中的冲突现场(`git ls-files -u`)解析为
 * 「每文件的冲突类型 + 两侧内容摘要 + 可操作建议清单」。
 *
 * 设计依据 docs/harvest-design.md §7(冲突分叉)/§5(输出契约 conflict 字段):
 * - 工具返回结构化冲突 → agent 用 ask_user_question 问人 → AI 解决或交人;
 * - 冲突类型经未合并索引项的 stage 判定(1=base,2=ours,3=theirs),
 *   比 porcelain 的 XY 码更权威(rebase/merge 两种现场通用);
 * - 两侧内容摘要经 `git show :<stage>:<path>` 读取(前 N 行预览 + 行数),
 *   供问询时直接展示「两边各改了什么」。
 *
 * 语义注意:rebase 现场下 ours/theirs 与直觉相反——ours=新基线(target),
 * theirs=任务分支正在重放的提交;本面在检测结果上如实附注该提示。
 *
 * @module dsh-kanban-mode/harvest/conflict-plan
 */
import { toPosixPath } from './git-runner.ts';
import type { GitRunner } from './git-runner.ts';
import { detectInProgressState } from './resolve.ts';

/** 冲突类型(按 stage 组合判定)。 */
export type ConflictFlavor =
  | 'both-modified'
  | 'both-added'
  | 'deleted-by-us'
  | 'deleted-by-them'
  | 'both-deleted';

/** 一条未合并索引项(`git ls-files -u` 的单条解析结果)。 */
export interface UnmergedEntry {
  readonly mode: string;
  readonly blob: string;
  /** 索引 stage:1=base,2=ours,3=theirs。 */
  readonly stage: 1 | 2 | 3;
  /** 仓库相对路径(POSIX 归一)。 */
  readonly path: string;
}

/** 冲突某一侧(base/ours/theirs)的内容摘要。 */
export interface ConflictSide {
  /** 该 stage 是否存在(false = 该侧在冲突中缺席,如删除/新增)。 */
  readonly present: boolean;
  /** 该侧 blob 的行数(缺席或空内容为 0)。 */
  readonly lineCount: number;
  /** 该侧内容的前几行预览(≤ previewLines)。 */
  readonly preview: readonly string[];
}

/** 单个冲突文件的结构化建议。 */
export interface ConflictFilePlan {
  /** 仓库相对路径(POSIX 归一)。 */
  readonly path: string;
  readonly flavor: ConflictFlavor;
  /** base 侧(stage 1)。 */
  readonly base: ConflictSide;
  /** ours 侧(stage 2;rebase 现场下=新基线 target)。 */
  readonly ours: ConflictSide;
  /** theirs 侧(stage 3;rebase 现场下=任务分支)。 */
  readonly theirs: ConflictSide;
  /** 该文件的可操作解决建议(中文,供 agent 问询直接引用)。 */
  readonly suggestions: readonly string[];
}

/** 一份完整冲突建议。 */
export interface ConflictPlan {
  readonly files: readonly ConflictFilePlan[];
  /** 过程说明(如 rebase 现场的 ours/theirs 语义提示)。 */
  readonly notes: readonly string[];
}

/** buildConflictPlan 的可选项。 */
export interface BuildConflictPlanOptions {
  /** 每侧内容预览行数(默认 5)。 */
  readonly previewLines?: number;
}

/**
 * 解析 `git ls-files -u -z` 的输出(NUL 分隔,条目内首制表符分隔元信息与
 * 路径,元信息按空格切 mode/blob/stage;路径含空格与中文时仍可完整还原)。
 */
export function parseLsFilesUnmerged(stdout: string): UnmergedEntry[] {
  const entries: UnmergedEntry[] = [];
  for (const record of stdout.split('\u0000')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const meta = record.slice(0, tab).trim();
    const filePath = record.slice(tab + 1);
    const parts = meta.split(' ');
    if (parts.length < 3) continue;
    const stage = Number(parts[2]);
    if (stage !== 1 && stage !== 2 && stage !== 3) continue;
    entries.push({
      mode: parts[0] ?? '',
      blob: parts[1] ?? '',
      stage,
      path: toPosixPath(filePath),
    });
  }
  return entries;
}

/** 按 stage 组合判定冲突类型(纯函数)。 */
export function flavorFromStages(stages: readonly number[]): ConflictFlavor {
  const has = (n: number): boolean => stages.includes(n);
  if (has(1) && has(2) && has(3)) return 'both-modified';
  if (has(2) && has(3)) return 'both-added';
  if (has(1) && !has(2) && !has(3)) return 'both-deleted';
  if (has(1) && has(2)) return 'deleted-by-them';
  if (has(1) && has(3)) return 'deleted-by-us';
  // 理论不可达(未合并项至少含两个 stage 或 base stage):按双侧修改兜底。
  return 'both-modified';
}

/** 各冲突类型对应的可操作建议(纯函数,中文,含 rebase/merge 场景差异提示)。 */
export function flavorSuggestions(
  flavor: ConflictFlavor,
  filePath: string,
): readonly string[] {
  switch (flavor) {
    case 'both-modified':
      return [
        `两侧都修改了 ${filePath}:在检出内编辑该文件,合并保留需要的行,删除 <<<<<<< / ======= / >>>>>>> 冲突标记`,
        `完成后 git add ${filePath} 标记已解决,再调用收割 apply 续跑(工具自动 rebase/merge 收尾)`,
      ];
    case 'both-added':
      return [
        `两侧各自新增了 ${filePath}:对照两侧内容确认保留哪一侧,或手工合并成最终版`,
        `完成后 git add ${filePath} 标记已解决`,
      ];
    case 'deleted-by-us':
      return [
        `我方(ours 侧)删除了 ${filePath} 而对方(theirs 侧)有修改:取舍保留删除还是恢复文件`,
        `保留删除 → git rm ${filePath};恢复并保留对方修改 → git checkout --theirs -- ${filePath} 后 git add ${filePath}`,
      ];
    case 'deleted-by-them':
      return [
        `对方(theirs 侧)删除了 ${filePath} 而我方(ours 侧)有修改:取舍接受删除还是保留修改`,
        `接受删除 → git rm ${filePath};保留我方修改 → git add ${filePath}`,
      ];
    case 'both-deleted':
      return [
        `两侧都删除了 ${filePath}:确认删除 → git rm ${filePath} 完成解决`,
      ];
  }
}

/** 把单文件建议压成一行摘要(供问询清单/输出 suggestions 字段直接引用)。 */
export function formatConflictSuggestion(plan: ConflictFilePlan): string {
  return `[${plan.flavor}] ${plan.path}:${plan.suggestions[0] ?? ''}`;
}

/** 读取某一 stage 的内容摘要;stage 缺席(show 失败)返回 present:false。 */
async function readStageSide(
  runner: GitRunner,
  cwd: string,
  stage: 1 | 2 | 3,
  filePath: string,
  previewLines: number,
): Promise<ConflictSide> {
  const show = await runner.capture(['show', `:${stage}:${filePath}`], { cwd });
  if (!show.ok) {
    return { present: false, lineCount: 0, preview: [] };
  }
  const text = show.stdout;
  if (text.length === 0) {
    return { present: true, lineCount: 0, preview: [] };
  }
  const lines = text.split('\n');
  // 结尾换行会产生一个空的末元素:计入行数但截掉预览。
  const lineCount = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  const preview = (
    lineCount === lines.length ? lines : lines.slice(0, -1)
  ).slice(0, Math.max(0, previewLines));
  return { present: true, lineCount, preview };
}

/**
 * 读取当前检出的冲突现场并产出结构化建议。
 * cwd 必须处于冲突现场(未合并索引项非空,即 rebase/merge 冲突停驻态);
 * 干净检出返回 files:[](不报错,便于续跑前复查)。
 * 现场非检出目录(rev-parse 失败)时抛 GitRunnerError。
 */
export async function buildConflictPlan(
  runner: GitRunner,
  cwd: string,
  options: BuildConflictPlanOptions = {},
): Promise<ConflictPlan> {
  const previewLines = options.previewLines ?? 5;
  const raw = await runner.captureOrThrow(['ls-files', '-u', '-z'], { cwd });
  const entries = parseLsFilesUnmerged(raw.stdout);
  if (entries.length === 0) {
    return { files: [], notes: [] };
  }
  const notes: string[] = [];
  try {
    const state = await detectInProgressState(runner, cwd);
    if (state.kind === 'rebase') {
      notes.push(
        '当前为 rebase 冲突现场:ours=新基线(target),theirs=任务分支,方向与 merge 时相反,取舍前先 git log 确认',
      );
    }
  } catch {
    // 状态探测失败不影响建议本身(现场已由未合并索引项证实)。
  }
  // 保序分组:同一文件的多 stage 条目聚合为一个冲突文件。
  const order: string[] = [];
  const byPath = new Map<string, UnmergedEntry[]>();
  for (const entry of entries) {
    const bucket = byPath.get(entry.path);
    if (bucket === undefined) {
      byPath.set(entry.path, [entry]);
      order.push(entry.path);
    } else {
      bucket.push(entry);
    }
  }
  const files: ConflictFilePlan[] = [];
  for (const filePath of order) {
    const bucket = byPath.get(filePath) ?? [];
    const stages = bucket.map((entry) => entry.stage);
    const flavor = flavorFromStages(stages);
    files.push({
      path: filePath,
      flavor,
      base: await readStageSide(runner, cwd, 1, filePath, previewLines),
      ours: await readStageSide(runner, cwd, 2, filePath, previewLines),
      theirs: await readStageSide(runner, cwd, 3, filePath, previewLines),
      suggestions: flavorSuggestions(flavor, filePath),
    });
  }
  return { files, notes };
}
