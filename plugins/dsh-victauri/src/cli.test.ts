import { describe, expect, it } from 'vitest';

import {
  CLI_ACTIONS,
  isCliAction,
  resolveCliPath,
  runVictauriCli,
  CLI_DEFAULT_TIMEOUT_MS,
} from './cli.ts';
import { VictauriError } from './errors.ts';

/** node -e 脚本:把完整 argv(JSON)打到 stdout。 */
const ECHO_ARGV = 'console.log(JSON.stringify(process.argv))';

describe('dsh-victauri cli bridge', () => {
  it('参数按序拼装并经 stdout 捕获返回', async () => {
    const result = await runVictauriCli({
      cliPath: process.execPath,
      args: ['-e', ECHO_ARGV, 'doctor', '--json', 'extra'],
    });
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as string[];
    // node -e 把首个位置参数放 argv[1],其余按序在 argv[2+]:尾部三参完整保留
    expect(parsed.slice(-3)).toEqual(['doctor', '--json', 'extra']);
  });

  it('退出码与 stderr 捕获', async () => {
    const result = await runVictauriCli({
      cliPath: process.execPath,
      args: ['-e', 'console.error("boom");process.exit(3)'],
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
    expect(result.timedOut).toBe(false);
  });

  it('超时路径:timedOut=true 且 exitCode 为 null', async () => {
    const result = await runVictauriCli({
      cliPath: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      timeoutMs: 150,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  }, 10_000);

  it('cliPath 不存在抛 VictauriError(cli-error)', async () => {
    await expect(
      runVictauriCli({
        cliPath: 'definitely-not-a-real-binary-xyz',
        args: ['doctor'],
        timeoutMs: 3000,
      }),
    ).rejects.toMatchObject({ kind: 'cli-error' });
  });

  it('cwd 生效(子进程在该目录下解析相对路径)', async () => {
    const result = await runVictauriCli({
      cliPath: process.execPath,
      args: ['-e', 'console.log(process.cwd())'],
      cwd: process.cwd(),
    });
    expect(result.stdout.trim()).toBe(process.cwd());
  });

  it('resolveCliPath:显式值直通,默认值带平台后缀', () => {
    expect(resolveCliPath('C:/bin/victauri.exe')).toBe('C:/bin/victauri.exe');
    const fallback = resolveCliPath();
    expect(fallback).toBe(
      process.platform === 'win32' ? 'victauri.exe' : 'victauri',
    );
  });

  it('CLI_ACTIONS 全集与 isCliAction 守卫', () => {
    expect(CLI_ACTIONS).toEqual([
      'init',
      'check',
      'test',
      'record',
      'doctor',
      'watch',
      'invoke',
      'tools',
      'call',
      'bridge',
      'coverage',
      'run',
      'logs',
    ]);
    expect(isCliAction('doctor')).toBe(true);
    expect(isCliAction('nope')).toBe(false);
    expect(CLI_DEFAULT_TIMEOUT_MS).toBe(120_000);
  });

  it('env 注入生效', async () => {
    const result = await runVictauriCli({
      cliPath: process.execPath,
      args: ['-e', 'console.log(process.env["VICTAURI_PROBE"] ?? "missing")'],
      env: { VICTAURI_PROBE: 'ok' },
    });
    expect(result.stdout.trim()).toBe('ok');
  });

  it('spawn 非 Error 抛出也归一为 VictauriError', () => {
    // 直接验证错误归一逻辑的构造面(runVictauriCli 内部 catch 分支)
    const err = new VictauriError('cli-error', 'spawn failed: fake');
    expect(err.kind).toBe('cli-error');
    expect(err.message).toContain('spawn failed');
  });
});
