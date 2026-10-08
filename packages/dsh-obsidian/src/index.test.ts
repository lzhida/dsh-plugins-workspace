/**
 * dsh-obsidian 行为契约测试。
 *
 * 覆盖:
 * - 插件契约(name / inject / 加载日志);
 * - 工具注册的最小 stub(cordis 假体);
 * - buildArgv 边界(必填/可选/布尔/vault);
 * - runObsidian 错误归一(ENOENT / stdout Error: / 非 0 退出码);
 * - protocol section 完整性(无 {{var}} 占位 + 命令表覆盖 commands.ts 全集);
 * - 9 个 obsidian_* 工具的 schema 与 execute 路径(用假 RunnerSpawner)。
 *
 * 风格沿用 dsh-taskboard 的 stubCtx 模式。
 */

import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';

import { apply, inject, name } from './index.ts';
import {
  OBSIDIAN_COMMANDS,
  commandsByFamily,
  findCommand,
} from './commands.ts';
import {
  PROTOCOL_SECTION_NAME,
  PROTOCOL_SECTION_ORDER,
  obsidianSection,
} from './protocol.ts';
import {
  type RunnerChild,
  type RunnerSpawner,
  buildArgv,
  clampTimeout,
  runObsidian,
} from './runner.ts';
import { createObsidianTools } from './tools.ts';
import {
  OBSIDIAN_DEFAULT_TIMEOUT_MS,
  OBSIDIAN_ERROR_MESSAGES,
  OBSIDIAN_ERROR_PREFIX,
  OBSIDIAN_MAX_TIMEOUT_MS,
  ObsidianError,
} from './types.ts';

// ── 测试工具 ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** cordis Context 最小假体:effect 立即执行,systemPrompt.section / tools.register 记录。 */
function stubCtx(): {
  ctx: Context;
  sections: Array<{ name: string; order: number; text: string }>;
  registered: Array<{ name: string }>;
  cleanups: Array<() => void>;
} {
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const registered: Array<{ name: string }> = [];
  const cleanups: Array<() => void> = [];
  const ctx = {
    effect(fn: () => (() => void) | void): void {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    systemPrompt: {
      section(s: { name: string; order: number; text: string }): () => void {
        sections.push(s);
        return () => {};
      },
    },
    tools: {
      register(def: { name: string }): () => void {
        registered.push({ name: def.name });
        return () => {};
      },
    },
  } as unknown as Context;
  return { ctx, sections, registered, cleanups };
}

/** 构造一个 mock RunnerChild(给定 stdout/stderr/exit)。 */
function mockChild(opts: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly exitError?: Error;
  readonly pid?: number;
}): RunnerChild {
  const stdoutStream = Readable.from(
    opts.stdout === undefined ? [] : [Buffer.from(opts.stdout, 'utf8')],
    { objectMode: false },
  );
  const stderrStream = Readable.from(
    opts.stderr === undefined ? [] : [Buffer.from(opts.stderr, 'utf8')],
    { objectMode: false },
  );
  // 用 EventEmitter 模式同时支持 'exit' 和 'error';cordis 的 child_process
  // 子类的 on() 是方法重载(同一方法名,事件名区分),但我们用 EventEmitter
  // 的统一签名即可。
  const ee = new EventEmitter();
  const child: RunnerChild = {
    pid: opts.pid ?? 1,
    stdout: stdoutStream,
    stderr: stderrStream,
    on(event, listener) {
      ee.on(event, listener as (...a: unknown[]) => void);
    },
    kill: () => true,
  };
  // 下一个 tick 触发 exit / error,模拟真实子进程。
  setImmediate(() => {
    if (opts.exitError) {
      ee.emit('error', opts.exitError);
    } else {
      ee.emit('exit', opts.exitCode ?? 0, null);
    }
  });
  return child;
}

/** 构造一个 mock spawner,接收单次 spawn 调用。 */
function mockSpawner(
  child: RunnerChild,
  captured: { argv: string[] | null } = { argv: null },
): RunnerSpawner {
  return {
    spawn({ command, argv }) {
      captured.argv = [command, ...argv];
      return child;
    },
  };
}

// ── 1. 插件契约 ─────────────────────────────────────────────────────

describe('dsh-obsidian plugin contract', () => {
  it('name 与 cordis id 约定一致', () => {
    expect(name).toBe('dsh-obsidian');
  });

  it('inject 包含 tools + systemPrompt', () => {
    expect(inject).toEqual(expect.arrayContaining(['tools', 'systemPrompt']));
  });

  it('apply 打印 `[dsh-obsidian] plugin loaded` 装载日志(e2e 契约)', () => {
    const { ctx, sections, registered, cleanups } = stubCtx();
    apply(ctx);
    // 装载日志
    expect(console.log).toHaveBeenCalledWith('[dsh-obsidian] plugin loaded');
    // section 注册
    expect(sections).toHaveLength(1);
    expect(sections[0]?.name).toBe('tool:obsidian');
    expect(sections[0]?.order).toBe(2960);
    // tools 注册(9 个)
    expect(registered.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'obsidian_read',
        'obsidian_create',
        'obsidian_append',
        'obsidian_search',
        'obsidian_daily',
        'obsidian_daily_append',
        'obsidian_properties',
        'obsidian_vault',
        'obsidian_run',
      ]),
    );
    // 清理函数被 effect 收集
    expect(cleanups.length).toBeGreaterThanOrEqual(2);
  });
});

// ── 2. commands.ts 单一真源 ─────────────────────────────────────────

describe('dsh-obsidian commands catalogue', () => {
  it('commands 清单覆盖七大族', () => {
    const families = new Set(OBSIDIAN_COMMANDS.map((c) => c.family));
    expect(families).toEqual(
      new Set([
        'file',
        'daily',
        'search',
        'property',
        'plugin-snippet',
        'command',
        'vault',
      ]),
    );
  });

  it('每条命令的 name 唯一', () => {
    const names = OBSIDIAN_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('每条命令至少有一个 param(允许空列表仅对 daily:read / vault 等纯查询)', () => {
    for (const c of OBSIDIAN_COMMANDS) {
      // 至少有非空 description
      expect(c.description.length).toBeGreaterThan(0);
      // danger 取值在枚举内
      expect(['read', 'write', 'destructive', 'execute']).toContain(c.danger);
    }
  });

  it('findCommand 与 commandsByFamily 一致', () => {
    expect(findCommand('read')?.family).toBe('file');
    expect(commandsByFamily('file').length).toBeGreaterThan(0);
  });

  it('破坏性命令至少包含 delete / plugin:disable / snippet:disable', () => {
    const destructive = OBSIDIAN_COMMANDS.filter(
      (c) => c.danger === 'destructive',
    ).map((c) => c.name);
    expect(destructive).toEqual(
      expect.arrayContaining(['delete', 'plugin:disable', 'snippet:disable']),
    );
  });

  it('obsidian command 命令的危险等级是 execute(走宿主权限闸)', () => {
    expect(findCommand('command')?.danger).toBe('execute');
  });
});

// ── 3. buildArgv 与 clampTimeout 边界 ──────────────────────────────

describe('buildArgv', () => {
  it('必填参数按 spec 顺序拼 key=value', () => {
    const argv = buildArgv(findCommand('read')!, { path: 'notes/hello' });
    expect(argv).toEqual(['read', 'path=notes/hello']);
  });

  it('可选参数未传时不拼', () => {
    const argv = buildArgv(findCommand('create')!, {
      path: 'notes/hello',
      content: '# hi',
    });
    expect(argv).toEqual(['create', 'path=notes/hello', 'content=# hi']);
  });

  it('布尔 true 拼为 name=true,布尔 false 不拼', () => {
    const argv = buildArgv(findCommand('create')!, {
      path: 'notes/hello',
      content: 'x',
      overwrite: true,
    });
    expect(argv).toContain('overwrite=true');

    const argv2 = buildArgv(findCommand('create')!, {
      path: 'notes/hello',
      content: 'x',
      overwrite: false,
    });
    expect(argv2).not.toContain('overwrite=false');
  });

  it('vault 拼在 command 之后', () => {
    const argv = buildArgv(
      findCommand('read')!,
      { path: 'notes/x' },
      'second-brain',
    );
    expect(argv[0]).toBe('read');
    expect(argv[1]).toBe('vault=second-brain');
    expect(argv[2]).toBe('path=notes/x');
  });

  it('空字符串视为未提供', () => {
    const argv = buildArgv(findCommand('read')!, { path: 'x', folder: '' });
    expect(argv).toEqual(['read', 'path=x']);
  });

  it('special: daily:read 没有 params,只输出命令本身', () => {
    const argv = buildArgv(findCommand('daily:read')!, {});
    expect(argv).toEqual(['daily:read']);
  });
});

describe('clampTimeout', () => {
  it('undefined / 0 / 负数回退到默认', () => {
    expect(clampTimeout(undefined)).toBe(OBSIDIAN_DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(0)).toBe(OBSIDIAN_DEFAULT_TIMEOUT_MS);
    expect(clampTimeout(-1)).toBe(OBSIDIAN_DEFAULT_TIMEOUT_MS);
  });

  it('超过硬上限被夹到上限', () => {
    expect(clampTimeout(OBSIDIAN_MAX_TIMEOUT_MS + 1)).toBe(
      OBSIDIAN_MAX_TIMEOUT_MS,
    );
  });

  it('合法值原样返回', () => {
    expect(clampTimeout(1234)).toBe(1234);
  });
});

// ── 4. runObsidian 错误归一 ────────────────────────────────────────

describe('runObsidian error classification', () => {
  it('spawn ENOENT 抛 OBSIDIAN_CLI_NOT_FOUND', async () => {
    const enoent = Object.assign(new Error('spawn obsidian ENOENT'), {
      code: 'ENOENT',
    });
    const spawner: RunnerSpawner = {
      spawn: () => {
        throw enoent;
      },
    };
    await expect(
      runObsidian(
        { spec: findCommand('read')!, args: { path: 'x' } },
        { spawner, executable: 'obsidian' },
      ),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_CLI_NOT_FOUND' });
  });

  it('stdout 以 "Error:" 开头时抛 OBSIDIAN_PROTOCOL_ERROR(退出码 0)', async () => {
    const spawner = mockSpawner(
      mockChild({ stdout: 'Error: file not found: notes/x\n', exitCode: 0 }),
    );
    await expect(
      runObsidian(
        { spec: findCommand('read')!, args: { path: 'notes/x' } },
        { spawner, executable: 'obsidian', now: () => 1000 },
      ),
    ).rejects.toMatchObject({
      code: 'OBSIDIAN_PROTOCOL_ERROR',
      message: expect.stringContaining('Error: file not found: notes/x'),
    });
  });

  it('非 0 退出码抛 OBSIDIAN_NONZERO_EXIT(罕见路径)', async () => {
    const spawner = mockSpawner(mockChild({ exitCode: 1, stderr: 'oops' }));
    await expect(
      runObsidian(
        { spec: findCommand('read')!, args: { path: 'x' } },
        { spawner, executable: 'obsidian', now: () => 1000 },
      ),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_NONZERO_EXIT' });
  });

  it('必填参数缺失抛 OBSIDIAN_INVALID_INPUT(spawn 不发生)', async () => {
    let spawned = false;
    const spawner: RunnerSpawner = {
      spawn: () => {
        spawned = true;
        return mockChild({});
      },
    };
    await expect(
      runObsidian(
        { spec: findCommand('read')!, args: {} },
        { spawner, executable: 'obsidian' },
      ),
    ).rejects.toMatchObject({ code: 'OBSIDIAN_INVALID_INPUT' });
    expect(spawned).toBe(false);
  });

  it('成功路径返回 stdout/stderr/argv/durationMs', async () => {
    const captured: { argv: string[] | null } = { argv: null };
    const spawner = mockSpawner(
      mockChild({ stdout: 'hello world', exitCode: 0 }),
      captured,
    );
    const r = await runObsidian(
      { spec: findCommand('read')!, args: { path: 'notes/x' } },
      { spawner, executable: 'obsidian', now: () => 5000 },
    );
    expect(r.stdout).toBe('hello world');
    expect(r.exitCode).toBe(0);
    expect(r.argv).toEqual(['obsidian', 'read', 'path=notes/x']);
    expect(captured.argv).toEqual(['obsidian', 'read', 'path=notes/x']);
    // duration 不强断言(基于事件循环时序),只断言非负且是数字
    expect(typeof r.durationMs).toBe('number');
  });

  it('stdout 超长截断并加 [truncated to N chars] 标记', async () => {
    // 比 cap 多一个字符,确保能触发截断分支(刚好等于 cap 不触发)。
    const big = 'x'.repeat(OBSIDIAN_MAX_STDOUT_LEN() + 1);
    const spawner = mockSpawner(mockChild({ stdout: big, exitCode: 0 }));
    const r = await runObsidian(
      { spec: findCommand('read')!, args: { path: 'x' } },
      { spawner, executable: 'obsidian', now: () => 1 },
    );
    // 截断标记:cap 内的字符 + 截断提示(~27 字符);总长 < 原 big + 标记
    expect(r.stdout.endsWith('[truncated to 20000 chars]')).toBe(true);
    // 截断后内容长度不应等于原 big 长度
    expect(r.stdout.length).not.toBe(big.length);
  });
});

/** 测试用:返回 stdout 截断阈值(与 types.ts 常量一致;避免 import 私有变量)。 */
function OBSIDIAN_MAX_STDOUT_LEN(): number {
  return 20_000;
}

// ── 5. protocol section 完整性 ─────────────────────────────────────

/** PromptSection.text 可能是 string 或 (ctx=>string);本插件固定为 string。 */
function sectionText(): string {
  const t = obsidianSection().text;
  if (typeof t !== 'string') {
    throw new Error('expected protocol section text to be a static string');
  }
  return t;
}

describe('obsidian protocol section', () => {
  it('section 名为 tool:obsidian,order=2960', () => {
    const s = obsidianSection();
    expect(s.name).toBe(PROTOCOL_SECTION_NAME);
    expect(s.order).toBe(PROTOCOL_SECTION_ORDER);
    expect(s.name).toBe('tool:obsidian');
    expect(s.order).toBe(2960);
  });

  it('text 不含 {{var}} 占位符(避免 rc.2 renderPrompt 严格校验失败)', () => {
    const text = sectionText();
    // 只断言 Mustache 风格占位符;Markdown 表格里的代码块尖括号不算。
    expect(/\{\{[a-zA-Z_]+\}\}/.test(text)).toBe(false);
  });

  it('text 至少提到全部七大族', () => {
    const text = sectionText();
    expect(text).toContain('笔记 (file)');
    expect(text).toContain('日常笔记 (daily)');
    expect(text).toContain('搜索 (search)');
    expect(text).toContain('属性 (property)');
    expect(text).toContain('插件/CSS 片段 (plugin-snippet)');
    expect(text).toContain('命令面板 (command)');
    expect(text).toContain('Vault (vault)');
  });

  it('text 显式提到命令总条数(便于 model 校对)', () => {
    const text = sectionText();
    expect(text).toContain(
      `Total commands exposed: ${OBSIDIAN_COMMANDS.length}`,
    );
  });

  it('text 至少包含破坏性命令的提示', () => {
    const text = sectionText();
    expect(text.toLowerCase()).toContain('destructive');
    expect(text).toContain('delete');
  });

  it('text 提到 Obsidian 协议错误前缀 "Error:"(避免 agent 漏读)', () => {
    const text = sectionText();
    expect(text).toContain('Error:');
    expect(text).toContain(OBSIDIAN_ERROR_PREFIX);
  });
});

// ── 6. 工具层(createObsidianTools) ──────────────────────────────────

describe('createObsidianTools', () => {
  it('registerAll 注册全部 9 个工具', () => {
    const { registerAll } = createObsidianTools();
    const registered: Array<{ name: string }> = [];
    registerAll((t) => registered.push({ name: (t as { name: string }).name }));
    expect(registered.map((r) => r.name).sort()).toEqual(
      [
        'obsidian_append',
        'obsidian_create',
        'obsidian_daily',
        'obsidian_daily_append',
        'obsidian_properties',
        'obsidian_read',
        'obsidian_run',
        'obsidian_search',
        'obsidian_vault',
      ].sort(),
    );
  });

  it('obsidian_read 把 vault 透传到 argv(vault=second)', async () => {
    const captured: { argv: string[] | null } = { argv: null };
    const spawner = mockSpawner(
      mockChild({ stdout: 'body', exitCode: 0 }),
      captured,
    );
    const { registerAll } = createObsidianTools({
      runnerOptions: { spawner, executable: 'obsidian', now: () => 1 },
    });
    const tools: Array<{
      name: string;
      execute: (a: unknown, e: unknown) => Promise<unknown>;
    }> = [];
    registerAll((t) =>
      tools.push(
        t as unknown as {
          name: string;
          execute: (a: unknown, e: unknown) => Promise<unknown>;
        },
      ),
    );
    const read = tools.find((t) => t.name === 'obsidian_read')!;
    const text = await read.execute(
      { path: 'notes/x', vault: 'second' },
      { signal: new AbortController().signal },
    );
    expect(typeof text).toBe('string');
    expect(captured.argv).toEqual([
      'obsidian',
      'read',
      'vault=second',
      'path=notes/x',
    ]);
  });

  it('obsidian_run 接受任意 command 走通用入口', async () => {
    const captured: { argv: string[] | null } = { argv: null };
    const spawner = mockSpawner(
      mockChild({ stdout: 'moved', exitCode: 0 }),
      captured,
    );
    const { registerAll } = createObsidianTools({
      runnerOptions: { spawner, executable: 'obsidian', now: () => 1 },
    });
    const tools: Array<{
      name: string;
      execute: (a: unknown, e: unknown) => Promise<unknown>;
    }> = [];
    registerAll((t) =>
      tools.push(
        t as unknown as {
          name: string;
          execute: (a: unknown, e: unknown) => Promise<unknown>;
        },
      ),
    );
    const run = tools.find((t) => t.name === 'obsidian_run')!;
    await run.execute(
      { command: 'file:move', args: { path: 'a.md', to: 'b.md' } },
      { signal: new AbortController().signal },
    );
    expect(captured.argv).toEqual([
      'obsidian',
      'file:move',
      'path=a.md',
      'to=b.md',
    ]);
  });

  it('runner ENOENT 被工具层归一为 [OBSIDIAN_CLI_NOT_FOUND] 文本', async () => {
    const enoent = Object.assign(new Error('spawn obsidian ENOENT'), {
      code: 'ENOENT',
    });
    const spawner: RunnerSpawner = {
      spawn: () => {
        throw enoent;
      },
    };
    const { registerAll } = createObsidianTools({
      runnerOptions: { spawner, executable: 'obsidian' },
    });
    const tools: Array<{
      name: string;
      execute: (a: unknown, e: unknown) => Promise<unknown>;
    }> = [];
    registerAll((t) =>
      tools.push(
        t as unknown as {
          name: string;
          execute: (a: unknown, e: unknown) => Promise<unknown>;
        },
      ),
    );
    const read = tools.find((t) => t.name === 'obsidian_read')!;
    const text = await read.execute(
      { path: 'notes/x' },
      { signal: new AbortController().signal },
    );
    expect(String(text)).toContain('[OBSIDIAN_CLI_NOT_FOUND]');
    expect(String(text)).toContain('obsidian');
  });

  it('stdout "Error:" 前缀被工具层归一为 [OBSIDIAN_PROTOCOL_ERROR] 文本', async () => {
    const spawner = mockSpawner(
      mockChild({ stdout: 'Error: cannot move: target exists\n', exitCode: 0 }),
    );
    const { registerAll } = createObsidianTools({
      runnerOptions: { spawner, executable: 'obsidian', now: () => 1 },
    });
    const tools: Array<{
      name: string;
      execute: (a: unknown, e: unknown) => Promise<unknown>;
    }> = [];
    registerAll((t) =>
      tools.push(
        t as unknown as {
          name: string;
          execute: (a: unknown, e: unknown) => Promise<unknown>;
        },
      ),
    );
    const run = tools.find((t) => t.name === 'obsidian_run')!;
    const text = await run.execute(
      { command: 'file:move', args: { path: 'a.md', to: 'b.md' } },
      { signal: new AbortController().signal },
    );
    expect(String(text)).toContain('[OBSIDIAN_PROTOCOL_ERROR]');
    expect(String(text)).toContain('cannot move: target exists');
  });

  it('obsidian_run 收到未知 command 名被归一为 [OBSIDIAN_INVALID_INPUT] 文本(防止模型虚构 CLI 子命令)', async () => {
    const spawner = mockSpawner(mockChild({ stdout: 'never' }));
    const { registerAll } = createObsidianTools({
      runnerOptions: { spawner, executable: 'obsidian' },
    });
    const tools: Array<{
      name: string;
      execute: (a: unknown, e: unknown) => Promise<unknown>;
    }> = [];
    registerAll((t) =>
      tools.push(
        t as unknown as {
          name: string;
          execute: (a: unknown, e: unknown) => Promise<unknown>;
        },
      ),
    );
    const run = tools.find((t) => t.name === 'obsidian_run')!;
    const text = await run.execute(
      { command: 'fabricated:nope' }, // 不在 commands.ts 清单里
      { signal: new AbortController().signal },
    );
    expect(String(text)).toContain('[OBSIDIAN_INVALID_INPUT]');
    expect(String(text)).toContain('fabricated:nope');
  });

  it('obsidian_create 缺 content 由 dsh-tools schema 层拒绝(不绕到 runner;协议闸前置)', async () => {
    // 这条断言是契约保护:必填参数由 dsh-tools schema 在 execute 入口校验,
    // 拒绝抛 ToolArgsError,不会走到 runner;若 runner 路径也想拦截,
    // 行为见上面"runObsidian error classification > 必填参数缺失"那一条。
    const spawner = mockSpawner(mockChild({ stdout: 'never' }));
    const { registerAll } = createObsidianTools({
      runnerOptions: { spawner, executable: 'obsidian' },
    });
    const tools: Array<{
      name: string;
      execute: (a: unknown, e: unknown) => Promise<unknown>;
    }> = [];
    registerAll((t) =>
      tools.push(
        t as unknown as {
          name: string;
          execute: (a: unknown, e: unknown) => Promise<unknown>;
        },
      ),
    );
    const create = tools.find((t) => t.name === 'obsidian_create')!;
    await expect(
      create.execute(
        { path: 'notes/x' },
        { signal: new AbortController().signal },
      ),
    ).rejects.toBeDefined();
  });
});

// ── 7. 错误码 - 消息表 ─────────────────────────────────────────────

describe('OBSIDIAN_ERROR_MESSAGES', () => {
  it('每个错误码都有非空中文消息', () => {
    for (const [k, v] of Object.entries(OBSIDIAN_ERROR_MESSAGES)) {
      expect(v.length, `error code ${k}`).toBeGreaterThan(0);
      expect(v).toMatch(/[\u4e00-\u9fa5]/); // 含中文字符
    }
  });
});

// ── 8. ObsidianError 契约 ─────────────────────────────────────────

describe('ObsidianError', () => {
  it('保留 code + context', () => {
    const e = new ObsidianError('boom', 'OBSIDIAN_TIMEOUT', {
      command: 'read',
    });
    expect(e.code).toBe('OBSIDIAN_TIMEOUT');
    expect(e.context).toEqual({ command: 'read' });
    expect(e.message).toBe('boom');
    expect(e.name).toBe('ObsidianError');
  });
});
