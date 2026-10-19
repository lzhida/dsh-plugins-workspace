/**
 * launcher.ts 测试：桌面端 exe 发现/拉起、CLI 服务状态解析与启动，
 * 全部经注入的 spawn/execFile/healthFetch 假体，绝不真起进程。
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackendLauncher, type ExecFileLike } from './launcher.ts';
import type { LauncherConfig } from './launcher.ts';

/** 构造拉起器配置（desktop/cli 指向假地址）。 */
function makeConfig(overrides?: {
  desktopBin?: string;
  desktopAutoStart?: boolean;
  cliBin?: string;
  cliAutoStart?: boolean;
}): LauncherConfig {
  return {
    desktop: {
      url: 'http://127.0.0.1:31009',
      key: 'k',
      autoStart: overrides?.desktopAutoStart ?? false,
      binPath: overrides?.desktopBin ?? '',
    },
    cli: {
      url: 'http://127.0.0.1:31012',
      key: 'bot',
      autoStart: overrides?.cliAutoStart ?? false,
      binPath: overrides?.cliBin ?? 'anytype',
    },
  };
}

/** 快轮询预算（测试不等待）。 */
const FAST = { desktopMs: 200, cliMs: 200, intervalMs: 10 };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 生成磁盘上真实存在的桩 exe 路径（launchDesktop 有存在性校验）。 */
function createStubExe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anytype-exe-'));
  const exe = join(dir, 'Anytype.exe');
  writeFileSync(exe, 'stub');
  return exe;
}

describe('dsh-anytype launcher', () => {
  describe('resolveDesktopExe', () => {
    it('显式 desktopPath 存在则优先返回', () => {
      const dir = mkdtempSync(join(tmpdir(), 'anytype-launcher-'));
      const exe = join(dir, 'Anytype.exe');
      writeFileSync(exe, 'stub');
      const launcher = new BackendLauncher(() =>
        makeConfig({ desktopBin: exe }),
      );
      const resolved = launcher.resolveDesktopExe();
      expect(resolved.exe).toBe(exe);
    });

    it('显式 desktopPath 不存在时不返回 exe', () => {
      const launcher = new BackendLauncher(() =>
        makeConfig({ desktopBin: 'C:\\definitely\\missing\\Anytype.exe' }),
      );
      expect(launcher.resolveDesktopExe().exe).toBeUndefined();
    });

    it('未配置时按候选发现（stub LOCALAPPDATA 指向临时目录）', () => {
      const dir = mkdtempSync(join(tmpdir(), 'anytype-candidates-'));
      const exeDir = join(dir, 'Programs', 'anytype');
      mkdirSync(exeDir, { recursive: true });
      const exe = join(exeDir, 'Anytype.exe');
      writeFileSync(exe, 'stub');
      vi.stubEnv('LOCALAPPDATA', dir);
      const launcher = new BackendLauncher(() => makeConfig());
      expect(launcher.resolveDesktopExe().exe).toBe(exe);
    });
  });

  describe('launchDesktop', () => {
    it('已健康（服务本就在跑）→ launched 且不 spawn', async () => {
      const spawn = vi.fn(() => Promise.resolve());
      const health = vi.fn(() => Promise.resolve(new Response('{}')));
      const launcher = new BackendLauncher(
        () => makeConfig({ desktopBin: 'C:\\x\\Anytype.exe' }),
        spawn,
        health,
        undefined,
        FAST,
      );
      expect(await launcher.launchDesktop()).toBe('launched');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('exe 未找到 → exe-not-found 且不 spawn', async () => {
      const spawn = vi.fn(() => Promise.resolve());
      const health = vi.fn(() => Promise.reject(new Error('down')));
      const launcher = new BackendLauncher(
        () => makeConfig({ desktopBin: 'C:\\missing\\Anytype.exe' }),
        spawn,
        health,
        undefined,
        FAST,
      );
      expect(await launcher.launchDesktop()).toBe('exe-not-found');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('spawn 成功且健康恢复 → launched', async () => {
      const spawn = vi.fn(() => Promise.resolve());
      let healthy = false;
      const health = vi.fn(() => {
        if (healthy) return Promise.resolve(new Response('{}'));
        healthy = true; // 第一次失败后立刻恢复
        return Promise.reject(new Error('down'));
      });
      const launcher = new BackendLauncher(
        () => makeConfig({ desktopBin: createStubExe() }),
        spawn,
        health,
        undefined,
        FAST,
      );
      expect(await launcher.launchDesktop()).toBe('launched');
      expect(spawn).toHaveBeenCalledTimes(1);
    });

    it('spawn 抛错 → failed', async () => {
      const spawn = vi.fn(() => Promise.reject(new Error('boom')));
      const health = vi.fn(() => Promise.reject(new Error('down')));
      const launcher = new BackendLauncher(
        () => makeConfig({ desktopBin: createStubExe() }),
        spawn,
        health,
        undefined,
        FAST,
      );
      expect(await launcher.launchDesktop()).toBe('failed');
    });

    it('拉起后健康超时 → failed', async () => {
      const spawn = vi.fn(() => Promise.resolve());
      const health = vi.fn(() => Promise.reject(new Error('still down')));
      const launcher = new BackendLauncher(
        () => makeConfig({ desktopBin: createStubExe() }),
        spawn,
        health,
        undefined,
        { desktopMs: 30, cliMs: 30, intervalMs: 10 },
      );
      expect(await launcher.launchDesktop()).toBe('failed');
    });
  });

  describe('cliServiceStatus', () => {
    it('输出含 running → running', async () => {
      const exec: ExecFileLike = () =>
        Promise.resolve({ stdout: 'anytype service is running', stderr: '' });
      const launcher = new BackendLauncher(
        () => makeConfig(),
        undefined,
        undefined,
        exec,
      );
      const status = await launcher.cliServiceStatus();
      expect(status.binFound).toBe(true);
      expect(status.state).toBe('running');
    });

    it('输出含 not installed → not-installed', async () => {
      const exec: ExecFileLike = () =>
        Promise.resolve({ stdout: 'service is not installed', stderr: '' });
      const launcher = new BackendLauncher(
        () => makeConfig(),
        undefined,
        undefined,
        exec,
      );
      expect((await launcher.cliServiceStatus()).state).toBe('not-installed');
    });

    it('ENOENT（二进制缺失）→ binFound=false', async () => {
      const err = Object.assign(new Error('spawn anytype ENOENT'), {
        stdout: '',
        stderr: '',
      });
      const exec: ExecFileLike = () => Promise.reject(err);
      const launcher = new BackendLauncher(
        () => makeConfig(),
        undefined,
        undefined,
        exec,
      );
      const status = await launcher.cliServiceStatus();
      expect(status.binFound).toBe(false);
      expect(status.state).toBe('not-installed');
    });

    it('无法识别的输出 → unknown（binFound=true）', async () => {
      const exec: ExecFileLike = () =>
        Promise.resolve({ stdout: '?? gibberish ??', stderr: '' });
      const launcher = new BackendLauncher(
        () => makeConfig(),
        undefined,
        undefined,
        exec,
      );
      const status = await launcher.cliServiceStatus();
      expect(status.binFound).toBe(true);
      expect(status.state).toBe('unknown');
    });
  });

  describe('startCliService', () => {
    it('已健康 → already-running 且不执行 service start', async () => {
      const exec = vi.fn(() => {
        throw new Error('should not be called');
      }) as unknown as ExecFileLike;
      const health = vi.fn(() => Promise.resolve(new Response('{}')));
      const launcher = new BackendLauncher(
        () => makeConfig(),
        undefined,
        health,
        exec,
        FAST,
      );
      expect(await launcher.startCliService()).toBe('already-running');
      expect(exec).not.toHaveBeenCalled();
    });

    it('service start 成功且健康恢复 → started', async () => {
      const exec: ExecFileLike = () =>
        Promise.resolve({ stdout: 'service started', stderr: '' });
      let healthy = false;
      const health = vi.fn(() => {
        if (healthy) return Promise.resolve(new Response('{}'));
        healthy = true;
        return Promise.reject(new Error('down'));
      });
      const launcher = new BackendLauncher(
        () => makeConfig(),
        undefined,
        health,
        exec,
        FAST,
      );
      expect(await launcher.startCliService()).toBe('started');
    });

    it('service start 报 not installed → not-installed', async () => {
      const exec: ExecFileLike = () =>
        Promise.reject(
          Object.assign(new Error('exit 1'), {
            stdout: '',
            stderr: 'service is not installed',
          }),
        );
      const health = vi.fn(() => Promise.reject(new Error('down')));
      const launcher = new BackendLauncher(
        () => makeConfig(),
        undefined,
        health,
        exec,
        FAST,
      );
      expect(await launcher.startCliService()).toBe('not-installed');
    });

    it('service start 成功但健康超时 → failed', async () => {
      const exec: ExecFileLike = () =>
        Promise.resolve({ stdout: 'started', stderr: '' });
      const health = vi.fn(() => Promise.reject(new Error('down')));
      const launcher = new BackendLauncher(
        () => makeConfig(),
        undefined,
        health,
        exec,
        { desktopMs: 30, cliMs: 30, intervalMs: 10 },
      );
      expect(await launcher.startCliService()).toBe('failed');
    });
  });
});
