/**
 * launcher.ts 测试：CLI 服务状态解析与启动、机读 authStatus、
 * bot 账户 login/create 参数组装、serve 回退，全部经注入的
 * execFile/healthFetch 假体，绝不真起进程。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  CliLauncher,
  type ExecFileLike,
  type ExecFileStdinLike,
} from './launcher.ts';
import type { LauncherConfig } from './launcher.ts';

/** 构造拉起器配置（cli 指向假地址）。 */
function makeConfig(overrides?: {
  cliBin?: string;
  cliAutoStart?: boolean;
  accountKey?: string;
  accountName?: string;
  networkConfig?: string;
  listenAddress?: string;
}): LauncherConfig {
  return {
    cli: {
      url: 'http://127.0.0.1:31012',
      key: 'bot',
      autoStart: overrides?.cliAutoStart ?? false,
      binPath: overrides?.cliBin ?? 'anytype',
      accountKey: overrides?.accountKey ?? '',
      accountName: overrides?.accountName ?? '',
      networkConfig: overrides?.networkConfig ?? '',
      rootPath: '',
      listenAddress: overrides?.listenAddress ?? '127.0.0.1:31012',
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

  describe('authStatus（机读解析）', () => {
    it('解析 --json service status envelope 的关键字段', async () => {
      const calls: Array<{ args: string[] }> = [];
      const envelope = {
        schema_version: 1,
        state: 'unavailable',
        result: {
          account: { authenticated: false },
          api: {
            ready: false,
            configured_origin: 'http://127.0.0.1:31012',
          },
          service: {
            manager: 'unsupported',
            installed: false,
            running: false,
            health: 'not_running',
          },
          instance: { work_path: 'C:\\Users\\x\\anytype' },
          cli_version: 'v0.5.0',
        },
        error: { code: 'rpc_unavailable' },
      };
      const exec: ExecFileLike = (_file, args) => {
        calls.push({ args: [...args] });
        return Promise.resolve({
          stdout: JSON.stringify(envelope),
          stderr: '',
        });
      };
      const launcher = new CliLauncher(() => makeConfig(), undefined, exec);
      const status = await launcher.authStatus();

      expect(status.parsed).toBe(true);
      expect(status.state).toBe('unavailable');
      expect(status.cliVersion).toBe('v0.5.0');
      expect(status.authenticated).toBe(false);
      expect(status.serviceManager).toBe('unsupported');
      expect(status.serviceInstalled).toBe(false);
      expect(status.workPath).toBe('C:\\Users\\x\\anytype');
      expect(status.errorCode).toBe('rpc_unavailable');
      // 机读调用形态：--json 前缀 + service status
      expect(calls[0]?.args[0]).toBe('--json');
      expect(calls[0]?.args).toContain('service');
      expect(calls[0]?.args).toContain('status');
    });

    it('非 JSON 输出（老版本）→ parsed=false 附原始输出', async () => {
      const exec: ExecFileLike = () =>
        Promise.resolve({ stdout: 'plain human text', stderr: '' });
      const launcher = new CliLauncher(() => makeConfig(), undefined, exec);
      const status = await launcher.authStatus();
      expect(status.parsed).toBe(false);
      expect(status.detail).toContain('plain human text');
    });
  });

  describe('login / create（机读 + 参数组装）', () => {
    it('login：--key-stdin + 可选参数组装正确，账户 key 经 stdin', async () => {
      const calls: Array<{ args: string[]; stdin: string }> = [];
      const execStdin: ExecFileStdinLike = (_file, args, _opts, stdin) => {
        calls.push({ args: [...args], stdin });
        return Promise.resolve({
          stdout: JSON.stringify({
            schema_version: 1,
            state: 'ready',
            result: { account: { id: 'acc1' } },
          }),
          stderr: '',
        });
      };
      const launcher = new CliLauncher(
        () =>
          makeConfig({
            accountKey: 'secret-key',
            networkConfig: 'C:\\net.yml',
            listenAddress: '127.0.0.1:39999',
          }),
        undefined,
        undefined,
        undefined,
        execStdin,
      );
      const result = await launcher.login();

      expect(result.ok).toBe(true);
      expect(result.state).toBe('ready');
      expect(result.account).toEqual({ id: 'acc1' });
      const call = calls[0];
      expect(call?.stdin).toBe('secret-key');
      expect(call?.args[0]).toBe('--json');
      expect(call?.args).toContain('auth');
      expect(call?.args).toContain('login');
      expect(call?.args).toContain('--key-stdin');
      expect(call?.args).toContain('--network-config');
      expect(call?.args).toContain('C:\\net.yml');
      expect(call?.args).toContain('--listen-address');
      expect(call?.args).toContain('127.0.0.1:39999');
      // 机读变更操作必须携带 durable operation id（幂等键）
      const opIndex = call?.args.indexOf('--operation-id') ?? -1;
      expect(opIndex).toBeGreaterThan(-1);
      expect(call?.args[opIndex + 1]).toMatch(/^[A-Za-z0-9-]{8,128}$/);
      // key 绝不进命令行参数
      expect(call?.args.join(' ')).not.toContain('secret-key');
    });

    it('login：cliAccountKey 为空 → config-error 不执行', async () => {
      const exec = vi.fn(() => {
        throw new Error('never');
      }) as unknown as ExecFileLike;
      const launcher = new CliLauncher(
        () => makeConfig({ accountKey: '' }),
        undefined,
        exec,
      );
      const result = await launcher.login();
      expect(result.ok).toBe(false);
      expect(result.state).toBe('config-error');
      expect(exec).not.toHaveBeenCalled();
    });

    it('create：位置参数 name + 可选参数组装正确', async () => {
      const calls: Array<{ args: string[] }> = [];
      const exec: ExecFileLike = (_file, args) => {
        calls.push({ args: [...args] });
        return Promise.resolve({
          stdout: JSON.stringify({
            schema_version: 1,
            state: 'ready',
            result: { account: { id: 'acc2', name: 'dsh-bot' } },
          }),
          stderr: '',
        });
      };
      const launcher = new CliLauncher(
        () => makeConfig({ accountName: 'dsh-bot' }),
        undefined,
        exec,
      );
      const result = await launcher.create();

      expect(result.ok).toBe(true);
      expect(result.account).toEqual({ id: 'acc2', name: 'dsh-bot' });
      const args = calls[0]?.args ?? [];
      expect(args).toContain('auth');
      expect(args).toContain('create');
      expect(args).toContain('dsh-bot');
      // 机读变更操作必须携带 durable operation id（幂等键）
      const opIndex = args.indexOf('--operation-id');
      expect(opIndex).toBeGreaterThan(-1);
      expect(args[opIndex + 1]).toMatch(/^[A-Za-z0-9-]{8,128}$/);
      // create 要求「空实例」断言：--expect-account none
      const expectIdx = args.indexOf('--expect-account');
      expect(expectIdx).toBeGreaterThan(-1);
      expect(args[expectIdx + 1]).toBe('none');
    });

    it('create：cliAccountName 为空 → config-error 不执行', async () => {
      const exec = vi.fn(() => {
        throw new Error('never');
      }) as unknown as ExecFileLike;
      const launcher = new CliLauncher(
        () => makeConfig({ accountName: '' }),
        undefined,
        exec,
      );
      const result = await launcher.create();
      expect(result.ok).toBe(false);
      expect(result.state).toBe('config-error');
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('serveStart（service 不可用时的回退；节点存活以机读状态判定）', () => {
    /** 构造按调用次序返回不同 envelope 的 exec 假体。 */
    function sequencedExec(states: Array<'unavailable' | 'ready'>): {
      exec: ExecFileLike;
      calls: Array<{ args: string[] }>;
    } {
      const calls: Array<{ args: string[] }> = [];
      let i = 0;
      const exec: ExecFileLike = (_file, args) => {
        const state = states[Math.min(i, states.length - 1)];
        i += 1;
        calls.push({ args: [...args] });
        return Promise.resolve({
          stdout: JSON.stringify({
            schema_version: 1,
            state,
            result: {},
          }),
          stderr: '',
        });
      };
      return { exec, calls };
    }

    it('spawn detached serve + 节点 ready → started，参数带 listen-address', async () => {
      const spawnCalls: Array<{ exe: string; args: string[] }> = [];
      const serveSpawn = (exe: string, args: readonly string[]) => {
        spawnCalls.push({ exe, args: [...args] });
        return Promise.resolve();
      };
      // 第一次探测 unavailable（节点未起）→ spawn → 第二次 ready
      const { exec, calls } = sequencedExec(['unavailable', 'ready']);
      const launcher = new CliLauncher(
        () => makeConfig({ listenAddress: '127.0.0.1:39999' }),
        undefined,
        exec,
        FAST,
        undefined,
        serveSpawn,
      );
      expect(await launcher.serveStart()).toBe('started');
      expect(spawnCalls[0]?.exe).toBe('anytype');
      expect(spawnCalls[0]?.args).toEqual([
        'serve',
        '--listen-address',
        '127.0.0.1:39999',
      ]);
      // 探测走机读 service status（--json 前缀）
      expect(calls[0]?.args[0]).toBe('--json');
      expect(calls[0]?.args).toContain('service');
      expect(calls[0]?.args).toContain('status');
    });

    it('节点已 ready → already-running 不 spawn', async () => {
      const serveSpawn = vi.fn(() => Promise.resolve());
      const { exec } = sequencedExec(['ready']);
      const launcher = new CliLauncher(
        () => makeConfig(),
        undefined,
        exec,
        FAST,
        undefined,
        serveSpawn,
      );
      expect(await launcher.serveStart()).toBe('already-running');
      expect(serveSpawn).not.toHaveBeenCalled();
    });

    it('spawn 抛错（二进制缺失）→ bin-not-found', async () => {
      const serveSpawn = vi.fn(() =>
        Promise.reject(new Error('spawn anytype ENOENT')),
      );
      const { exec } = sequencedExec(['unavailable']);
      const launcher = new CliLauncher(
        () => makeConfig(),
        undefined,
        exec,
        FAST,
        undefined,
        serveSpawn,
      );
      expect(await launcher.serveStart()).toBe('bin-not-found');
    });

    it('拉起后节点持续 unavailable → failed', async () => {
      const serveSpawn = vi.fn(() => Promise.resolve());
      const { exec } = sequencedExec(['unavailable']);
      const launcher = new CliLauncher(
        () => makeConfig(),
        undefined,
        exec,
        { cliMs: 30, intervalMs: 10 },
        undefined,
        serveSpawn,
      );
      expect(await launcher.serveStart()).toBe('failed');
    });
  });
});
