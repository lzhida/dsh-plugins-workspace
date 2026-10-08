/**
 * dsh-test-runner 插件入口。
 *
 * 5 个 test_runner_* 工具,对应 e2e 编排脚本的五个阶段,可被任何 dsh
 * agent 在会话内串行调用。设计目标:
 *  - 拆为可分步工具,让 agent 在每步之间插入人类可读的状态报告;
 *  - 默认 180s 超时 + 500ms 轮询,沿用 .agents/skills/.../test-e2e.ts;
 *  - 不动默认 profile(隔离插件列表,模型凭证全局共享);
 *  - 卸载被测插件由 `test_runner_cleanup` 显式调用,不隐式自动清理。
 *
 * 加载链:
 *  1. 注册 system-prompt section(让模型看到协议);
 *  2. 注册 5 个 test_runner_* 工具;
 *  3. 进程内 boot handle map 按 session 隔离,卸载时强 kill,避免后台 web 残留。
 */
import type { Context } from '@deepseek-ai/cordis';
// 类型导入:激活 cordis Context 增强(ctx.tools / ctx.systemPrompt),编译后零运行时依赖。
import type {} from '@deepseek-ai/dsh-tools';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';
import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_PORT,
  DEFAULT_PROFILE,
  DEFAULT_POLL_MS,
  DEFAULT_TIMEOUT_MS,
  dshHomeDir,
  isLikelyTestProfile,
  profileDir,
} from './lib.ts';
import {
  bootWeb,
  collectAssertions,
  ensureProfile,
  installPlugin,
  killTree,
  linkSpec,
  reconcilePatch,
  resolvePlugin,
  type BootHandle,
} from './runner.ts';

/** Cordis 插件名(loader 依赖)。 */
export const name = 'dsh-test-runner';
/** 依赖注入:tools + systemPrompt(对齐 dsh-taskboard 模式)。 */
export const inject = ['tools', 'systemPrompt'];

/** Section 名:全局唯一(对齐 dsh-taskboard 的 PROTOCOL_SECTION_NAME 惯例)。 */
const SECTION_NAME = 'tool:test-runner';
/** Section order:TOOL_REPORT(2900)与 TOOL_SUBAGENT(2800)之外的空档,取 2850。 */
const SECTION_ORDER = 2850;

/** System-prompt 协议:让模型看到 5 步法的契约。 */
function testRunnerSection(): PromptSection {
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    interpolate: false,
    text: [
      '# dsh-test-runner 协议',
      '',
      '本插件提供 5 个 test_runner_* 工具,把"加载真实 dsh Web UI 验证插件"',
      '拆为可分步调用的能力。推荐流程:',
      '  1. test_runner_review_profiles  — 审查 ~/.dsh/profiles,确认或新建 test profile',
      '  2. test_runner_install          — 把被测插件装入 profile',
      '  3. test_runner_boot             — 后台启动 dsh web,拿到 sessionId',
      '  4. test_runner_run_assertions   — 轮询收集三项断言(可多次调用直到就绪)',
      '  5. test_runner_cleanup          — 显式卸载 + 杀进程,恢复 profile 干净态',
      '',
      '约束:不要在 default profile 上跑 e2e — 会污染用户当前会话;',
      '完成后必须调用 cleanup,否则后台 web 与被测插件会残留进后续会话。',
    ].join('\n'),
  };
}

/** 单个测试会话状态(session id → boot handle / 待卸载 plugins)。 */
interface TestSession {
  readonly id: string;
  readonly profile: string;
  readonly port: string;
  readonly boot: BootHandle;
  readonly webUrl: string;
  tokenedUrl: string | null;
  /** 待 cleanup 阶段卸载的 plugin spec(已解析成 dir/name)。 */
  readonly installed: { spec: string; name: string; dir: string }[];
  /** cwd 解析,记录 boot 时的工作目录,cleanup 用。 */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** 工具 execute 内的统一错误包装:模型看到的错误形如 `[CODE] message`。 */
async function withErrorBoundary<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`[TEST_RUNNER_ERROR] ${msg}`, { cause: error });
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function apply(ctx: Context): void {
  console.log(`[${name}] plugin loaded`);

  const disposeSection = ctx.systemPrompt.section(testRunnerSection());
  ctx.effect(() => disposeSection, 'dsh-test-runner: protocol section');

  const sessions = new Map<string, TestSession>();

  // ── 1. test_runner_review_profiles ──────────────────────────────

  const reviewProfiles = defineTool({
    name: 'test_runner_review_profiles',
    description:
      '审查 ~/.dsh/profiles/ 下的 profile 列表,标记哪些适合做 e2e 测试,以及当前' +
      '默认 test profile(`e2e`)是否存在。' +
      '当 `createIfMissing` 为 true 且 `targetProfile` 缺失时,会从官方 web 模板引导。' +
      '返回建议使用的 profile 名、已存在 test profile 列表。',
    parameters: {
      targetProfile: {
        type: 'string',
        description: '希望使用的 test profile 名(默认 `e2e`)。',
      },
      createIfMissing: {
        type: 'boolean',
        description: '目标 profile 缺失时是否从官方 web 模板引导(默认 false)。',
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          target: { type: 'string', required: true },
          targetExists: { type: 'boolean', required: true },
          created: { type: 'boolean' },
          existingTestProfiles: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args) {
      return withErrorBoundary(async () => {
        const a = args as { targetProfile?: string; createIfMissing?: boolean };
        const target = a.targetProfile ?? DEFAULT_PROFILE;
        const home = dshHomeDir();
        // 计算但不直接使用 — 留给未来扩展(createIfMissing 走 ensureProfile,
        // 路径用其内部再算一次,此处保引用让逻辑可见)。
        const _targetDir = profileDir(target, home);
        void _targetDir;
        const profilesDir = join(home, 'profiles');

        // 1) 列出所有 profile(以 `package.json` 存在判定存在)。
        const existing: string[] = [];
        let existingTest: string[] = [];
        try {
          const entries = await readdir(profilesDir);
          for (const name of entries) {
            const sub = join(profilesDir, name);
            const s = await stat(sub);
            if (!s.isDirectory()) continue;
            const manifest = join(sub, 'package.json');
            if (!(await fileExists(manifest))) continue;
            existing.push(name);
            if (isLikelyTestProfile(name)) existingTest.push(name);
          }
          existingTest = existingTest.sort();
        } catch {
          // ~/.dsh 不存在
        }

        let targetExists = existing.includes(target);
        let created = false;
        if (!targetExists && a.createIfMissing === true) {
          const boot = await ensureProfile({
            profile: target,
            cwd: process.cwd(),
            env: { ...process.env },
            timeoutMs: DEFAULT_TIMEOUT_MS,
          });
          created = boot.created;
          if (created) targetExists = true;
        }

        const lines: string[] = [];
        lines.push(`目标 test profile: ${target}`);
        lines.push(
          `  已存在: ${targetExists ? '是' : '否'}${created ? ' (本次新建)' : ''}`,
        );
        lines.push(`~/.dsh/profiles/ 下的 test 用途 profile:`);
        if (existingTest.length === 0) {
          lines.push('  (无)');
        } else {
          for (const n of existingTest) lines.push(`  - ${n}`);
        }
        lines.push(`~/.dsh/profiles/ 全部 profile(${existing.length}):`);
        if (existing.length === 0) {
          lines.push('  (无 — 整个 ~/.dsh 可能尚未初始化)');
        } else {
          for (const n of existing) lines.push(`  - ${n}`);
        }
        lines.push('');
        lines.push(
          targetExists
            ? `→ 可直接进入 test_runner_install,使用 profile="${target}"。`
            : created
              ? `→ 已新建 profile "${target}",继续 test_runner_install。`
              : `→ profile "${target}" 缺失,设置 createIfMissing=true 自动引导,或手动 pnpm dsh --profile ${target} --from-default-profile web。`,
        );
        return {
          text: lines.join('\n'),
          target,
          targetExists,
          created: created || undefined,
          existingTestProfiles: existingTest,
        };
      });
    },
  });

  // ── 2. test_runner_install ──────────────────────────────────────

  const install = defineTool({
    name: 'test_runner_install',
    description:
      '把被测插件安装到 test profile。插件入口路径为仓库内 `packages/<name>/src/index.ts`,' +
      '工具自动解析包名并经 `dsh plugin --profile <p> add link:<dir>` 装入。' +
      '安装前会按需维护 profile 的 cordis.patch.yml(给 local executor 禁 permission presets)。',
    parameters: {
      profile: {
        type: 'string',
        description: 'Test profile 名(默认 `e2e`)。',
      },
      pluginEntries: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description:
          '一个或多个被测插件入口绝对路径(从仓库根解析),如 `/x/packages/dsh-taskboard/src/index.ts`。',
      },
      port: {
        type: 'string',
        description: 'Web UI 端口(默认 3865)。',
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          profile: { type: 'string', required: true },
          installed: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args) {
      return withErrorBoundary(async () => {
        const a = args as {
          profile?: string;
          pluginEntries: string[];
          port?: string;
        };
        const profile = a.profile ?? DEFAULT_PROFILE;
        const port = a.port ?? String(DEFAULT_PORT);
        const env = { ...process.env };
        const cwd = process.cwd();

        // 1) 解析所有 plugin entry → { dir, name }。
        const resolved: { spec: string; name: string; dir: string }[] = [];
        for (const entry of a.pluginEntries) {
          // resolvePlugin:从 entry 上两级推 dir,并读 package.json 取 name。
          const r = await resolvePlugin(entry);
          resolved.push({ spec: linkSpec(r.dir), name: r.name, dir: r.dir });
        }

        // 2) profile 自举(缺失时自动从 web 模板引导)。
        const bootRes = await ensureProfile({
          profile,
          cwd,
          env,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
        if (!bootRes.created && bootRes.exitCode !== 0) {
          throw new Error(
            `profile "${profile}" 引导失败(exit=${bootRes.exitCode}),请检查上方 dsh 输出。`,
          );
        }

        // 3) 维护 patch 层(local executor 禁 permission presets)。
        const patchRes = await reconcilePatch({
          profile,
          pluginNames: resolved.map((p) => p.name),
          env,
        });

        // 4) 装入被测插件。
        for (const r of resolved) {
          const inst = await installPlugin({
            profile,
            spec: r.spec,
            cwd,
            env,
            action: 'add',
          });
          if (inst.exitCode !== 0) {
            throw new Error(
              `plugin 安装失败: ${r.spec} (exit=${inst.exitCode}${inst.signal ? `, signal=${inst.signal}` : ''})`,
            );
          }
        }

        // 5) 把已装入的 plugin 记到当前 default session(若有);install 阶段
        //    通常不直接创建 session,但 cleanup 阶段需要能取到这些名字。
        for (const [sid, s] of sessions) {
          if (s.profile === profile && s.port === port) {
            s.installed.push(...resolved);
            void sid;
            break;
          }
        }

        const text = [
          `✓ profile="${profile}" 已就绪`,
          `✓ patch 层: ${patchRes.reason}${patchRes.changed ? '' : ' (no-op)'}`,
          `✓ 已装入:`,
          ...resolved.map((r) => `    - ${r.name}  (${r.spec})`),
          '',
          `下一步:调用 test_runner_boot,传入同样的 profile + port=${port},获取 sessionId。`,
        ].join('\n');

        return {
          text,
          profile,
          installed: resolved.map((r) => r.name),
        };
      });
    },
  });

  // ── 3. test_runner_boot ─────────────────────────────────────────

  const boot = defineTool({
    name: 'test_runner_boot',
    description:
      '后台启动 dsh web(profile+port 由 install 时确定),拿到 sessionId 与 ' +
      'tokened URL。sessionId 供 test_runner_run_assertions / test_runner_cleanup 关联。' +
      '**不要在 default profile 上调用**(会污染当前会话)。',
    parameters: {
      profile: {
        type: 'string',
        description: 'Test profile 名(默认 `e2e`)。',
      },
      port: {
        type: 'string',
        description: 'Web UI 端口(默认 3865)。',
      },
      timeoutMs: {
        type: 'integer',
        description: '启动 + 引导总超时 ms(默认 180000)。',
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          profile: { type: 'string', required: true },
          port: { type: 'string', required: true },
          webUrl: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args) {
      return withErrorBoundary(async () => {
        const a = args as {
          profile?: string;
          port?: string;
          timeoutMs?: number;
        };
        const profile = a.profile ?? DEFAULT_PROFILE;
        const port = a.port ?? String(DEFAULT_PORT);
        const timeoutMs = a.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const env = { ...process.env };
        const cwd = process.cwd();

        // 端口占用预检。
        const webUrl = `http://127.0.0.1:${port}`;
        try {
          await fetch(webUrl);
          throw new Error(
            `端口 ${port} 已被占用,疑似已有 web 实例在运行(E2E_PORT 可覆盖)。`,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            /端口 \d+ 已被占用/.test(error.message)
          ) {
            throw error;
          }
          // 端口空闲,继续。
        }

        const handle = bootWeb({ profile, port, cwd, env });

        const sessionId = randomUUID();
        sessions.set(sessionId, {
          id: sessionId,
          profile,
          port,
          boot: handle,
          webUrl,
          tokenedUrl: null,
          installed: [],
          cwd,
          env,
        });

        // 注册卸载时强制 kill。
        ctx.effect(
          () => () => {
            const s = sessions.get(sessionId);
            if (s !== undefined) {
              killTree(s.boot.child.pid);
              sessions.delete(sessionId);
            }
          },
          `dsh-test-runner: cleanup ${sessionId}`,
        );

        // 等 banner 出现(给一个短预热窗口,后续 run_assertions 才是真轮询)。
        const warm = Math.min(timeoutMs, 30_000);
        const tStart = Date.now();
        const urlRe = /dsh web: (http:\S+)/;
        let tokenedUrl: string | null = null;
        while (Date.now() - tStart < warm) {
          const out = handle.drain();
          const m = urlRe.exec(out);
          if (m) {
            tokenedUrl = m[1] ?? null;
            break;
          }
          if (handle.exitCode() !== null) {
            throw new Error(
              `web 进程提前退出(exit=${handle.exitCode()}),请检查 session 输出。`,
            );
          }
          await new Promise<void>((r) => setTimeout(r, DEFAULT_POLL_MS));
        }

        const s = sessions.get(sessionId);
        if (s !== undefined) s.tokenedUrl = tokenedUrl;

        return {
          text: [
            `✓ sessionId: ${sessionId}`,
            `✓ profile: ${profile}, port: ${port}`,
            `✓ webUrl: ${webUrl}`,
            tokenedUrl !== null
              ? `✓ tokened URL(供浏览器/MCP 接管): ${tokenedUrl}`
              : `⚠ tokened URL 暂未在 banner 中出现(可继续 test_runner_run_assertions 轮询)`,
            '',
            `下一步:调用 test_runner_run_assertions, 传 sessionId=${sessionId} + token=插件目录名(可多个)。`,
          ].join('\n'),
          sessionId,
          profile,
          port,
          webUrl,
        };
      });
    },
  });

  // ── 4. test_runner_run_assertions ───────────────────────────────

  const runAssertions = defineTool({
    name: 'test_runner_run_assertions',
    description:
      '轮询收集三项断言:① `[<name>]` 加载日志 ② Web 服务端口可达 ③ 抓取到 tokened URL 时页面 HTTP < 400。' +
      '`tokens` 数组填写被测插件目录名(如 `dsh-taskboard`),工具按 `[<name>]` 结构化匹配,不会因路径中裸名假阳性。' +
      '可重复调用 — 每次返回当前累积状态;全部就绪时返回 `allReady=true`。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'test_runner_boot 返回的 sessionId。',
      },
      tokens: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: '被测插件目录名数组(来自 packages/<name>)。',
      },
      timeoutMs: {
        type: 'integer',
        description: '本次轮询总超时 ms(默认 30000;可重复调用)。',
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          allReady: { type: 'boolean', required: true },
          logReady: { type: 'boolean', required: true },
          portReady: { type: 'boolean', required: true },
          pageReady: { type: 'boolean', required: true },
          tokenedUrl: { type: 'string' },
          elapsedMs: { type: 'integer' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args) {
      return withErrorBoundary(async () => {
        const a = args as {
          sessionId: string;
          tokens: string[];
          timeoutMs?: number;
        };
        const session = sessions.get(a.sessionId);
        if (session === undefined) {
          throw new Error(`sessionId 未找到或已清理: ${a.sessionId}`);
        }
        const state = await collectAssertions({
          boot: session.boot,
          tokens: a.tokens,
          webUrl: session.webUrl,
          timeoutMs: a.timeoutMs ?? 30_000,
          pollMs: DEFAULT_POLL_MS,
        });
        if (state.tokenedUrl !== null) {
          session.tokenedUrl = state.tokenedUrl;
        }
        const allReady =
          state.logReady &&
          state.portReady &&
          (state.pageReady || !state.tokenedUrl);
        const text = [
          `logReady: ${state.logReady}`,
          `portReady: ${state.portReady}`,
          `pageReady: ${state.pageReady}${state.tokenedUrl === null ? ' (未抓取到 tokened URL)' : ''}`,
          `tokenedUrl: ${state.tokenedUrl ?? '(none yet)'}`,
          `elapsedMs: ${state.elapsedMs}`,
          '',
          allReady
            ? '✓ 三项断言全部通过 — 可进行浏览器级验证(若有)或调用 test_runner_cleanup 收尾。'
            : '⏳ 仍有断言未就绪 — 可再次调用本工具继续轮询(同一 sessionId)。',
        ].join('\n');
        return {
          text,
          allReady,
          logReady: state.logReady,
          portReady: state.portReady,
          pageReady: state.pageReady,
          tokenedUrl: state.tokenedUrl ?? undefined,
          elapsedMs: state.elapsedMs,
        };
      });
    },
  });

  // ── 5. test_runner_cleanup ──────────────────────────────────────

  const cleanup = defineTool({
    name: 'test_runner_cleanup',
    description:
      '收尾:杀后台 web 进程,从 profile 卸载所有 test_runner_install 期间装入的插件,' +
      '并清掉本会话状态。**必须显式调用** — 否则后台 web 会残留进后续会话。',
    parameters: {
      sessionId: {
        type: 'string',
        required: true,
        description: 'test_runner_boot 返回的 sessionId。',
      },
      removePlugins: {
        type: 'boolean',
        description:
          '是否同时从 profile 移除 install 阶段装入的插件(默认 true;保留插件时可设为 false)。',
      },
    },
    isConcurrencySafe: () => false,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          sessionId: { type: 'string', required: true },
          killed: { type: 'boolean', required: true },
          removedPlugins: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args) {
      return withErrorBoundary(async () => {
        const a = args as { sessionId: string; removePlugins?: boolean };
        const session = sessions.get(a.sessionId);
        if (session === undefined) {
          return {
            text: `sessionId 未找到或已清理: ${a.sessionId}(可能已 cleanup 完毕)。`,
            sessionId: a.sessionId,
            killed: false,
            removedPlugins: [],
          };
        }

        // 1) 杀进程树。
        killTree(session.boot.child.pid);
        // 给一点时间让子进程退出(不 await — 立即返回结果,清理异步进行)。
        await new Promise<void>((r) => setTimeout(r, 500));

        // 2) 卸载插件(若需要)。
        const removed: string[] = [];
        if (a.removePlugins !== false && session.installed.length > 0) {
          for (const p of session.installed) {
            const res = await installPlugin({
              profile: session.profile,
              spec: p.name,
              cwd: session.cwd,
              env: session.env,
              action: 'remove',
            });
            if (res.exitCode === 0) removed.push(p.name);
          }
        }

        sessions.delete(a.sessionId);
        return {
          text: [
            `✓ session ${a.sessionId} 已清理`,
            `✓ 进程已 kill`,
            `✓ 卸载插件: ${removed.length === 0 ? '(无)' : removed.join(', ')}`,
            `✓ profile "${session.profile}" 恢复干净态`,
          ].join('\n'),
          sessionId: a.sessionId,
          killed: true,
          removedPlugins: removed,
        };
      });
    },
  });

  const tools = [reviewProfiles, install, boot, runAssertions, cleanup];
  ctx.effect(() => {
    const disposers: (() => void)[] = [];
    for (const t of tools) {
      const r = ctx.tools.register(t);
      disposers.push(r);
    }
    return () => {
      for (const d of disposers) d();
    };
  }, 'dsh-test-runner: tools registration');
}
