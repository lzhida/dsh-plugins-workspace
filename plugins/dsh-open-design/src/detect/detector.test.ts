/**
 * dsh-open-design 探测模块单测（二）：安装环境与管道端点探测编排。
 *
 * 覆盖：管道命中、PowerShell 兜底、进程筛选、降级、失败重试与超时。
 */
import { describe, expect, it } from 'vitest';

import { detectOnce, POWERSHELL_PROCESS_SCRIPT } from './detector.ts';

const GOLDEN_DIGEST = '6eec4ea0e7395b977771b1af7124c1b9';
const GOLDEN_ENDPOINT = `\\\\.\\pipe\\open-design-sidecar-${GOLDEN_DIGEST}`;
const GOLDEN_PRINCIPAL = 'AI';
const APP_DATA_DIR = String.raw`C:\Users\AI\AppData\Roaming`;

/** 运行中的 sidecar 监督进程命令行（app=daemon）。 */
const DAEMON_COMMAND_LINE = String.raw`"E:\Programs\Open Design\Open Design.exe" "E:\Programs\Open Design\resources\app\node_modules\@open-design\sidecar\dist\supervisor.mjs" --od-stamp-channel=stable --od-stamp-namespace=release-stable-win --od-stamp-source=packaged --od-stamp-mode=runtime --od-stamp-app=daemon`;

/** 桌面应用进程命令行（app=desktop）。 */
const DESKTOP_COMMAND_LINE = String.raw`"E:\Programs\Open Design\Open Design.exe" --od-stamp-channel=stable --od-stamp-namespace=release-stable-win --od-stamp-source=packaged --od-stamp-mode=runtime --od-stamp-app=desktop`;

/** 构造 ConvertTo-Json 风格的进程列表输出。 */
function processListJson(commandLines: string[]): string {
  return JSON.stringify(
    commandLines.map((commandLine, index) => ({
      ProcessId: 1000 + index,
      CommandLine: commandLine,
    })),
  );
}

/** 永不结束的 PowerShell 调用（用于超时用例）。 */
function neverResolve(): Promise<string> {
  return new Promise<string>(() => {
    /* 故意不 settle */
  });
}

describe('dsh-open-design detector', () => {
  it('命中命名管道时给出管道方式的环境快照', async () => {
    const detected = await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => [
        'some-other-pipe',
        `open-design-sidecar-${GOLDEN_DIGEST}`,
      ],
      runPowerShell: async () => processListJson([DAEMON_COMMAND_LINE]),
    });
    expect(detected.method).toBe('pipe');
    expect(detected.stamp).toEqual({
      channel: 'stable',
      namespace: 'release-stable-win',
      source: 'packaged',
      mode: 'runtime',
      app: 'daemon',
    });
    expect(detected.endpoint).toBe(GOLDEN_ENDPOINT);
    expect(detected.installDir).toBe(String.raw`E:\Programs\Open Design`);
    expect(detected.dataDir).toBe(
      String.raw`C:\Users\AI\AppData\Roaming\Open Design\namespaces\release-stable-win\data`,
    );
    expect(detected.daemonCliPath).toBe(
      String.raw`E:\Programs\Open Design\resources\app\prebundled\daemon\daemon-cli.mjs`,
    );
  });

  it('管道未命中时用进程命令行兜底还原语义戳', async () => {
    const detected = await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => ['some-other-pipe'],
      runPowerShell: async () => processListJson([DAEMON_COMMAND_LINE]),
    });
    expect(detected.method).toBe('powershell');
    expect(detected.stamp?.namespace).toBe('release-stable-win');
    expect(detected.endpoint).toBe(GOLDEN_ENDPOINT);
    expect(detected.installDir).toBe(String.raw`E:\Programs\Open Design`);
  });

  it('进程列表里优先挑选守护进程', async () => {
    const detected = await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => [],
      runPowerShell: async () =>
        processListJson([DESKTOP_COMMAND_LINE, DAEMON_COMMAND_LINE]),
    });
    expect(detected.method).toBe('powershell');
    expect(detected.stamp?.app).toBe('daemon');
  });

  it('进程列表只有桌面进程时取首条可解析记录', async () => {
    const detected = await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => [],
      runPowerShell: async () => processListJson([DESKTOP_COMMAND_LINE]),
    });
    expect(detected.method).toBe('powershell');
    expect(detected.stamp?.app).toBe('desktop');
  });

  it('接受单对象形式的进程列表输出', async () => {
    const detected = await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => [],
      runPowerShell: async () =>
        JSON.stringify({ ProcessId: 1234, CommandLine: DAEMON_COMMAND_LINE }),
    });
    expect(detected.method).toBe('powershell');
    expect(detected.stamp?.app).toBe('daemon');
    expect(detected.installDir).toBe(String.raw`E:\Programs\Open Design`);
  });

  it('两条通道都失败时降级为未探测到', async () => {
    const detected = await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => {
        throw new Error('管道目录不可读');
      },
      runPowerShell: async () => {
        throw new Error('PowerShell 不可用');
      },
    });
    expect(detected.method).toBe('none');
    expect(detected.stamp).toBeNull();
    expect(detected.endpoint).toBe('');
    expect(detected.installDir).toBe('');
    expect(detected.dataDir).toBe('');
    expect(detected.daemonCliPath).toBe('');
  });

  it('PowerShell 输出无法解析时降级为未探测到', async () => {
    const detected = await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => [],
      runPowerShell: async () => 'not-a-json',
    });
    expect(detected.method).toBe('none');
    expect(detected.stamp).toBeNull();
  });

  it('PowerShell 调用失败时重试一次再放弃', async () => {
    let calls = 0;
    const detected = await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => [],
      runPowerShell: async () => {
        calls += 1;
        if (calls === 1) throw new Error('首次调用失败');
        return processListJson([DAEMON_COMMAND_LINE]);
      },
    });
    expect(calls).toBe(2);
    expect(detected.method).toBe('powershell');
  });

  it('PowerShell 超时后降级为未探测到', async () => {
    const detected = await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => [],
      runPowerShell: () => neverResolve(),
      timeoutMs: 20,
    });
    expect(detected.method).toBe('none');
  });

  it('管道命中但 PowerShell 不可用时仍给出管道端点', async () => {
    const detected = await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => [`open-design-sidecar-${GOLDEN_DIGEST}`],
      runPowerShell: async () => {
        throw new Error('PowerShell 不可用');
      },
    });
    expect(detected.method).toBe('pipe');
    expect(detected.endpoint).toBe(GOLDEN_ENDPOINT);
    expect(detected.stamp?.namespace).toBe('release-stable-win');
    // 拿不到可执行文件路径时安装目录与守护脚本路径留空
    expect(detected.installDir).toBe('');
    expect(detected.daemonCliPath).toBe('');
  });

  it('用固定的进程枚举脚本查询 Open Design 进程', async () => {
    let script = '';
    await detectOnce({
      principal: GOLDEN_PRINCIPAL,
      appDataDir: APP_DATA_DIR,
      listPipes: () => [],
      runPowerShell: async (value: string) => {
        script = value;
        return '[]';
      },
    });
    expect(script).toBe(POWERSHELL_PROCESS_SCRIPT);
    expect(script).toContain("Name='Open Design.exe'");
    expect(script).toContain('ConvertTo-Json');
  });
});
