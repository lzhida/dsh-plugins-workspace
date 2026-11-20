/**
 * `victauri_cli_status` 单测。
 *
 * 覆盖验收三态：
 * - CLI 存在（mock spawn 出 `victauri 0.8.8`）→ status=available + 版本号 + 实际命中路径；
 * - spawn ENOENT（CLI 不存在）→ status=not_found + 结构化错误 + 安装指引；
 * - cliPath 自定义路径注入生效 → spawn 目标即注入路径、source=config。
 *
 * 手法：mock 掉 `node:child_process` 的 spawn（走真实 `runVictauriCli` 代码路径），
 * PATH 收敛到临时目录并放置真实文件，使「实际命中路径」可预期。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CLI_ACTIONS } from '../cli.ts';
import {
  CLI_INSTALL_HINT,
  createVictauriCliStatusTool,
  locateExecutable,
  parseCliVersion,
  probeCliStatus,
  resetCliStatusCache,
  victauriCliStatusTool,
  type CliStatusResult,
} from './cli-status.ts';

// spawn 全模块 mock：探测走真实 runVictauriCli，但用假子进程替代真进程。
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

/** spawn mock（规避 spawn 多重载的 TS 推断问题）。 */
const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

/** 假子进程选项。 */
interface FakeChildOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
}

/** 构造假子进程：模拟 spawn 的 stdout/stderr/close/error 事件流。 */
function fakeChild(options: FakeChildOptions): ChildProcess {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { stdout, stderr, kill: () => undefined });
  setImmediate(() => {
    if (options.error) {
      child.emit('error', options.error);
      return;
    }
    if (options.stdout !== undefined)
      stdout.emit('data', Buffer.from(options.stdout));
    if (options.stderr !== undefined)
      stderr.emit('data', Buffer.from(options.stderr));
    child.emit('close', options.exitCode ?? 0);
  });
  return child;
}

/** 让下一次 spawn 返回指定假子进程。 */
function mockSpawn(options: FakeChildOptions): void {
  spawnMock.mockImplementation(() => fakeChild(options));
}

describe('dsh-victauri victauri_cli_status', () => {
  let workDir: string;
  const originalPath = process.env['PATH'];

  beforeEach(() => {
    resetCliStatusCache();
    spawnMock.mockReset();
    workDir = join(
      tmpdir(),
      `dsh-victauri-cli-status-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(workDir, { recursive: true });
    // PATH 收敛到临时目录：命中逻辑可预期，不依赖开发机真实安装
    process.env['PATH'] = workDir;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
    rmSync(workDir, { recursive: true, force: true });
  });

  it('CLI 存在(mock spawn):返回版本号 + 实际命中路径 + CLI_ACTIONS 子命令口径', async () => {
    const cli = join(workDir, 'victauri.exe');
    writeFileSync(cli, 'fake-binary');
    mockSpawn({ stdout: 'victauri 0.8.8\n' });

    const tool = createVictauriCliStatusTool({ cliPath: cli });
    const value = (await tool.execute(
      {},
      {} as never,
    )) as unknown as CliStatusResult;

    expect(value.status).toBe('available');
    expect(value.version).toBe('0.8.8');
    expect(value.version_output).toBe('victauri 0.8.8');
    expect(value.cli_path).toBe(resolve(cli));
    expect(value.error).toBeNull();
    // 子命令口径与 CLI_ACTIONS 原样一致
    expect(value.actions).toEqual([...CLI_ACTIONS]);
    expect(value.actions).toContain('doctor');
  });

  it('输出 schema 的 actions 描述与 CLI_ACTIONS 同源(不硬编码旧子命令清单)', () => {
    const tool = createVictauriCliStatusTool({ cliPath: process.execPath });
    const schema = tool.output.schema as unknown as {
      properties: Record<string, { description?: string }>;
    };
    const description = schema.properties['actions']?.description ?? '';
    for (const action of CLI_ACTIONS) {
      expect(description).toContain(action);
    }
    // 旧 9 项清单（含 0.10.x 新增子命令缺失）必须已被取代
    expect(description).toContain('tools');
    expect(description).toContain('call');
    expect(description).toContain('run');
    expect(description).toContain('logs');
  });

  it('CLI 不存在(spawn ENOENT):返回结构化 not_found + 安装指引', async () => {
    const missing = join(workDir, 'not-installed.exe');
    mockSpawn({ error: new Error(`spawn ${missing} ENOENT`) });

    const tool = createVictauriCliStatusTool({ cliPath: missing });
    const value = (await tool.execute(
      {},
      {} as never,
    )) as unknown as CliStatusResult;

    expect(value.status).toBe('not_found');
    expect(value.version).toBeNull();
    expect(value.cli_path).toBeNull();
    expect(value.error?.kind).toBe('not_found');
    // 安装指引三条都在文案里
    expect(value.error?.message).toContain('scoop install victauri');
    expect(value.error?.message).toContain('mise install victauri');
    expect(value.error?.message).toContain('cargo install victauri');
    expect(value.error?.hint).toBe(CLI_INSTALL_HINT);
  });

  it('cliPath 自定义路径注入生效:spawn 目标即注入路径且 source=config', async () => {
    const cli = join(workDir, 'custom', 'victauri-tool.exe');
    mkdirSync(join(workDir, 'custom'), { recursive: true });
    writeFileSync(cli, 'fake-binary');
    mockSpawn({ stdout: 'victauri 0.9.0' });

    const tool = createVictauriCliStatusTool({ cliPath: cli });
    const value = (await tool.execute(
      {},
      {} as never,
    )) as unknown as CliStatusResult;

    expect(value.source).toBe('config');
    expect(value.requested_path).toBe(cli);
    expect(value.cli_path).toBe(resolve(cli));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const call = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(call[0]).toBe(resolve(cli));
    expect(call[1]).toEqual(['--version']);
  });

  it('未注入 cliPath:按平台默认名在 PATH 中定位(实际命中路径 + platform_default)', async () => {
    const defaultName =
      process.platform === 'win32' ? 'victauri.exe' : 'victauri';
    writeFileSync(join(workDir, defaultName), 'fake-binary');
    mockSpawn({ stdout: 'victauri 0.8.8' });

    const value = (await victauriCliStatusTool.execute(
      {},
      {} as never,
    )) as unknown as CliStatusResult;

    expect(value.source).toBe('platform_default');
    expect(value.requested_path).toBe(defaultName);
    expect(value.cli_path).toBe(join(workDir, defaultName));
    expect(value.status).toBe('available');
  });

  it('locateExecutable:路径型命中/未命中，裸名按 PATH 搜索', () => {
    const cli = join(workDir, 'victauri.exe');
    writeFileSync(cli, 'fake-binary');
    const originalPathExt = process.env['PATHEXT'];
    // 显式固化 PATHEXT（V2 低-1）：不隐含依赖宿主环境必含 .EXE
    if (process.platform === 'win32') {
      process.env['PATHEXT'] = '.COM;.EXE;.BAT;.CMD';
    }
    try {
      expect(locateExecutable(cli)).toBe(resolve(cli));
      expect(locateExecutable(join(workDir, 'nope.exe'))).toBeNull();
      // 裸名命中分平台：win32 无后缀裸名靠 PATHEXT 解析到 .exe；非 Windows
      // 没有 PATHEXT 机制，按精确名命中，需补无后缀夹具（CI Linux 实测：
      // 只放 .exe 夹具时裸名返回 null —— 见 run 42019682148）。
      if (process.platform !== 'win32') {
        writeFileSync(join(workDir, 'victauri'), 'fake-binary');
      }
      const expected =
        process.platform === 'win32'
          ? join(workDir, 'victauri.exe')
          : join(workDir, 'victauri');
      // 先 not.toBeNull 保证失败信息可读（V2 低-2），再比较具体命中路径。
      // win32 的 PATHEXT 条目通常是大写（.EXE），返回值保留拼接时的字面量
      // 大小写，而磁盘大小写不敏感 → 统一归一小写比较（Linux 字面量本就
      // 相等，归一无害，保持跨平台断言同构 —— V2 低-3 认可的风格选择）。
      const hit = locateExecutable('victauri');
      expect(hit).not.toBeNull();
      expect(hit?.toLowerCase()).toBe(expected.toLowerCase());
    } finally {
      if (originalPathExt === undefined) delete process.env['PATHEXT'];
      else process.env['PATHEXT'] = originalPathExt;
    }
  });

  it('locateExecutable:非 Windows 平台按精确名命中（无 PATHEXT，不认裸名→.exe）', () => {
    // 平台伪装：把 CI（ubuntu-latest）上真实发生的 Linux 语义在任意平台
    // 复现为回归用例，Windows 本机也能验证这一失败形态。
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    expect(original).toBeDefined();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      // 修复前 CI 失败形态：PATH 目录只有 victauri.exe，裸名不命中
      expect(locateExecutable('victauri')).toBeNull();
      // 补无后缀夹具后按精确名命中（Linux 无 PATHEXT，不做扩展名补全）
      writeFileSync(join(workDir, 'victauri'), 'fake-binary');
      expect(locateExecutable('victauri')).toBe(join(workDir, 'victauri'));
    } finally {
      Object.defineProperty(
        process,
        'platform',
        original as PropertyDescriptor,
      );
    }
  });

  it('parseCliVersion:提取语义化版本号，无版本则 null', () => {
    expect(parseCliVersion('victauri 0.8.8')).toBe('0.8.8');
    expect(parseCliVersion('0.10.2\n')).toBe('0.10.2');
    expect(parseCliVersion('victauri 1.0.0-beta.1')).toBe('1.0.0-beta.1');
    expect(parseCliVersion('no version here')).toBeNull();
  });

  it('spawn 失败但非 ENOENT:status=error（不误报 not_found）', async () => {
    const cli = join(workDir, 'victauri.exe');
    writeFileSync(cli, 'fake-binary');
    mockSpawn({ error: new Error('spawn EACCES permission denied') });

    const tool = createVictauriCliStatusTool({ cliPath: cli });
    const value = (await tool.execute(
      {},
      {} as never,
    )) as unknown as CliStatusResult;

    expect(value.status).toBe('error');
    expect(value.error?.kind).toBe('cli-error');
    expect(value.error?.hint).toBe(CLI_INSTALL_HINT);
  });

  it('--version 退出码非 0:status=error 并带退出码信息', async () => {
    const cli = join(workDir, 'victauri.exe');
    writeFileSync(cli, 'fake-binary');
    mockSpawn({ stdout: 'boom', exitCode: 2 });

    const tool = createVictauriCliStatusTool({ cliPath: cli });
    const value = (await tool.execute(
      {},
      {} as never,
    )) as unknown as CliStatusResult;

    expect(value.status).toBe('error');
    expect(value.error?.kind).toBe('cli-error');
    expect(value.error?.message).toContain('exited with code 2');
  });

  it('结果缓存:TTL 内复用不重复 spawn，refresh=true 强制重探', async () => {
    const cli = join(workDir, 'victauri.exe');
    writeFileSync(cli, 'fake-binary');
    mockSpawn({ stdout: 'victauri 0.8.8' });

    const tool = createVictauriCliStatusTool({ cliPath: cli });
    await tool.execute({}, {} as never);
    await tool.execute({}, {} as never);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await tool.execute({ refresh: true }, {} as never);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('probeCliStatus:注入依赖下超时与非零退出均归一为 error', async () => {
    const timedOut = await probeCliStatus('victauri.exe', {
      locate: () => null,
      run: async () => ({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
      }),
    });
    expect(timedOut.status).toBe('error');
    expect(timedOut.error?.kind).toBe('timeout');

    const failed = await probeCliStatus('victauri.exe', {
      locate: () => null,
      run: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'nope',
        timedOut: false,
      }),
    });
    expect(failed.status).toBe('error');
    expect(failed.error?.kind).toBe('cli-error');
  });

  it('timeout 真实路径:真实子进程超时 → status=error / kind=timeout', async () => {
    // 让 mock 的 spawn 委派给真实实现：走真实 runVictauriCli 的 kill + close 全链路
    const actual =
      await vi.importActual<typeof import('node:child_process')>(
        'node:child_process',
      );
    spawnMock.mockImplementation(actual.spawn as never);

    const result = await probeCliStatus(process.execPath, {
      locate: () => process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      timeoutMs: 150,
    });

    expect(result.status).toBe('error');
    expect(result.error?.kind).toBe('timeout');
    expect(result.error?.message).toContain('timed out after 150ms');
  }, 10_000);

  it('默认工具常量可导入且 name 正确', () => {
    expect(victauriCliStatusTool.name).toBe('victauri_cli_status');
  });
});
