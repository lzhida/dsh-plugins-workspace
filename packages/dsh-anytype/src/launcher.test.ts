/**
 * launcher.ts 测试：CLI 服务状态解析与启动，全部经注入的
 * execFile/healthFetch 假体，绝不真起进程。
 */

import { describe, expect, it, vi } from 'vitest';

import { CliLauncher, type ExecFileLike } from './launcher.ts';
import type { LauncherConfig } from './launcher.ts';

/** 构造拉起器配置（cli 指向假地址）。 */
function makeConfig(overrides?: {
  cliBin?: string;
  cliAutoStart?: boolean;
}): LauncherConfig {
  return {
    cli: {
      url: 'http://127.0.0.1:31012',
      key: 'bot',
      autoStart: overrides?.cliAutoStart ?? false,
      binPath: overrides?.cliBin ?? 'anytype',
    },
  };
}

/** 快轮询预算（测试不等待）。 */
const FAST = { cliMs: 200, intervalMs: 10 };

describe('dsh-anytype launcher', () => {
  describe('cliServiceStatus', () => {
    it('输出含 running → running', async () => {
      const exec: ExecFileLike = () =>
        Promise.resolve({ stdout: 'anytype service is running', stderr: '' });
      const launcher = new CliLauncher(() => makeConfig(), undefined, exec);
      const status = await launcher.cliServiceStatus();
      expect(status.binFound).toBe(true);
      expect(status.state).toBe('running');
    });

    it('输出含 not installed → not-installed', async () => {
      const exec: ExecFileLike = () =>
        Promise.resolve({ stdout: 'service is not installed', stderr: '' });
      const launcher = new CliLauncher(() => makeConfig(), undefined, exec);
      expect((await launcher.cliServiceStatus()).state).toBe('not-installed');
    });

    it('ENOENT（二进制缺失）→ binFound=false', async () => {
      const err = Object.assign(new Error('spawn anytype ENOENT'), {
        stdout: '',
        stderr: '',
      });
      const exec: ExecFileLike = () => Promise.reject(err);
      const launcher = new CliLauncher(() => makeConfig(), undefined, exec);
      const status = await launcher.cliServiceStatus();
      expect(status.binFound).toBe(false);
      expect(status.state).toBe('not-installed');
    });

    it('无法识别的输出 → unknown（binFound=true）', async () => {
      const exec: ExecFileLike = () =>
        Promise.resolve({ stdout: '?? gibberish ??', stderr: '' });
      const launcher = new CliLauncher(() => makeConfig(), undefined, exec);
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
      const launcher = new CliLauncher(() => makeConfig(), health, exec, FAST);
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
      const launcher = new CliLauncher(() => makeConfig(), health, exec, FAST);
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
      const launcher = new CliLauncher(() => makeConfig(), health, exec, FAST);
      expect(await launcher.startCliService()).toBe('not-installed');
    });

    it('service start 成功但健康超时 → failed', async () => {
      const exec: ExecFileLike = () =>
        Promise.resolve({ stdout: 'started', stderr: '' });
      const health = vi.fn(() => Promise.reject(new Error('down')));
      const launcher = new CliLauncher(() => makeConfig(), health, exec, {
        cliMs: 30,
        intervalMs: 10,
      });
      expect(await launcher.startCliService()).toBe('failed');
    });
  });
});
