/**
 * dsh-open-design 配置合并语义单测（修复轮）。
 *
 * 覆盖三层优先级：overrides（用户显式意图） > 配置卡显式值 > 探测填充，
 * 以及 isExplicitValue 对「宿主补默认值」场景的显式性判定边界。
 */
import { describe, expect, it } from 'vitest';

import {
  collectExplicitOverrides,
  DEFAULT_SERVER_NAME,
  DEFAULT_SOURCE,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_TOOL_CALL_TIMEOUT_MS,
  deriveDetectedConnection,
  isExplicitValue,
  resolveConfig,
  type DetectedEnvironment,
} from './config.ts';

const DETECTED: DetectedEnvironment = {
  method: 'pipe',
  stamp: {
    channel: 'stable',
    namespace: 'release-stable-win',
    source: 'packaged',
    mode: 'runtime',
    app: 'daemon',
  },
  endpoint: '\\\\.\\pipe\\open-design-sidecar-6eec4ea0e7395b977771b1af7124c1b9',
  installDir: 'E:\\Programs\\Open Design',
  dataDir:
    'C:\\Users\\AI\\AppData\\Roaming\\Open Design\\namespaces\\release-stable-win\\data',
  daemonCliPath:
    'E:\\Programs\\Open Design\\resources\\app\\prebundled\\daemon\\daemon-cli.mjs',
};

describe('dsh-open-design config', () => {
  it('在所有来源都为空时用探测结果兜底', () => {
    const resolved = resolveConfig(undefined, DETECTED, undefined);
    expect(resolved.command).toBe('E:\\Programs\\Open Design\\Open Design.exe');
    expect(resolved.args).toEqual([
      'E:\\Programs\\Open Design\\resources\\app\\prebundled\\daemon\\daemon-cli.mjs',
      'mcp',
    ]);
    expect(resolved.env.OD_DATA_DIR).toBe(DETECTED.dataDir);
    expect(resolved.env.OD_SIDECAR_CLIENT_ENDPOINT).toBe(DETECTED.endpoint);
    expect(resolved.env.OD_MCP_BOOTSTRAP_COMMAND).toBe(
      'E:\\Programs\\Open Design\\Open Design.exe',
    );
    expect(resolved.env.OD_MCP_BOOTSTRAP_ARGS).toBe('["--headless"]');
    expect(resolved.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(resolved.source).toBe(DEFAULT_SOURCE);
    expect(resolved.serverName).toBe(DEFAULT_SERVER_NAME);
    expect(resolved.startupTimeoutMs).toBe(DEFAULT_STARTUP_TIMEOUT_MS);
    expect(resolved.toolCallTimeoutMs).toBe(DEFAULT_TOOL_CALL_TIMEOUT_MS);
    expect(resolved.autoDetect).toBe(true);
    expect(resolved.detected).toBe(DETECTED);
  });

  it('让 overrides 以最高优先级压过卡面显式值与探测结果', () => {
    const resolved = resolveConfig({ command: 'D:\\card\\od.exe' }, DETECTED, {
      command: 'E:\\override\\od.exe',
    });
    expect(resolved.command).toBe('E:\\override\\od.exe');
  });

  it('让 overrides 里等于默认值的项失效并回落到卡面显式值', () => {
    const resolved = resolveConfig(
      { command: 'D:\\card\\od.exe' },
      DETECTED,
      // 用户在 config.json 手写 serverName 又改回默认值：视为「回落默认语义」。
      { command: '', serverName: DEFAULT_SERVER_NAME },
    );
    expect(resolved.command).toBe('D:\\card\\od.exe');
    expect(resolved.serverName).toBe(DEFAULT_SERVER_NAME);
  });

  it('让配置卡显式值压过探测结果', () => {
    const resolved = resolveConfig(
      { command: 'D:\\custom\\od.exe', args: ['--mcp'] },
      DETECTED,
      undefined,
    );
    expect(resolved.command).toBe('D:\\custom\\od.exe');
    expect(resolved.args).toEqual(['--mcp']);
    // 未显式配置的字段继续用探测填充
    expect(resolved.env.OD_DATA_DIR).toBe(DETECTED.dataDir);
  });

  it('在配置卡留空白字符串时回落探测填充', () => {
    const resolved = resolveConfig({ command: '   ' }, DETECTED, undefined);
    expect(resolved.command).toBe('E:\\Programs\\Open Design\\Open Design.exe');
  });

  it('在没有任何来源时给出空连接配置', () => {
    const resolved = resolveConfig(undefined, null, undefined);
    expect(resolved.command).toBe('');
    expect(resolved.args).toEqual([]);
    expect(resolved.env).toEqual({});
    expect(resolved.detected).toBeNull();
    expect(resolved.autoDetect).toBe(true);
  });

  it('让显式的布尔与数值配置压过默认值', () => {
    const resolved = resolveConfig(
      { autoDetect: false, startupTimeoutMs: 3000, toolCallTimeoutMs: 4000 },
      DETECTED,
      undefined,
    );
    expect(resolved.autoDetect).toBe(false);
    expect(resolved.startupTimeoutMs).toBe(3000);
    expect(resolved.toolCallTimeoutMs).toBe(4000);
  });

  it('复制传入的数组与对象避免外部改写', () => {
    const args = ['--mcp'];
    const env = { A: '1' };
    const resolved = resolveConfig({ args, env }, null, undefined);
    args.push('--late');
    env.A = '2';
    expect(resolved.args).toEqual(['--mcp']);
    expect(resolved.env).toEqual({ A: '1' });
  });
});

describe('dsh-open-design isExplicitValue', () => {
  it('布尔字段只有与默认值不同才算显式（autoDetect 默认 true）', () => {
    expect(isExplicitValue('autoDetect', true)).toBe(false);
    expect(isExplicitValue('autoDetect', false)).toBe(true);
    expect(isExplicitValue('autoDetect', undefined)).toBe(false);
  });

  it('字符串字段非空且不等于默认值才算显式', () => {
    expect(isExplicitValue('command', '')).toBe(false);
    expect(isExplicitValue('command', '   ')).toBe(false);
    expect(isExplicitValue('command', 'D:\\x\\od.exe')).toBe(true);
    expect(isExplicitValue('source', DEFAULT_SOURCE)).toBe(false);
    expect(isExplicitValue('serverName', 'custom-name')).toBe(true);
  });

  it('数组字段只有非空才算显式', () => {
    expect(isExplicitValue('args', [])).toBe(false);
    expect(isExplicitValue('args', ['--mcp'])).toBe(true);
    expect(isExplicitValue('args', undefined)).toBe(false);
    expect(isExplicitValue('args', 'not-array')).toBe(false);
  });

  it('对象字段只有含键才算显式', () => {
    expect(isExplicitValue('env', {})).toBe(false);
    expect(isExplicitValue('env', { A: '1' })).toBe(true);
    expect(isExplicitValue('env', undefined)).toBe(false);
  });

  it('数值字段只有与默认值不同才算显式', () => {
    expect(
      isExplicitValue('startupTimeoutMs', DEFAULT_STARTUP_TIMEOUT_MS),
    ).toBe(false);
    expect(isExplicitValue('toolCallTimeoutMs', 5000)).toBe(true);
    expect(isExplicitValue('startupTimeoutMs', '5000')).toBe(false);
  });

  it('collectExplicitOverrides 只收集与默认值不同的字段', () => {
    const overrides = collectExplicitOverrides({
      autoDetect: true,
      command: 'D:\\x\\od.exe',
      args: [],
      env: {},
      serverName: DEFAULT_SERVER_NAME,
      startupTimeoutMs: 9999,
    });
    expect(overrides).toEqual({
      command: 'D:\\x\\od.exe',
      startupTimeoutMs: 9999,
    });
  });
});

describe('dsh-open-design deriveDetectedConnection', () => {
  it('探测未命中时不注入任何环境变量', () => {
    const fill = deriveDetectedConnection(null);
    expect(fill.command).toBe('');
    expect(fill.args).toEqual([]);
    expect(fill.env).toEqual({});
  });

  it('探测命中时生成完整连接参数与五项环境变量', () => {
    const fill = deriveDetectedConnection(DETECTED);
    expect(fill.command).toBe('E:\\Programs\\Open Design\\Open Design.exe');
    expect(fill.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(Object.keys(fill.env).sort()).toEqual([
      'ELECTRON_RUN_AS_NODE',
      'OD_DATA_DIR',
      'OD_MCP_BOOTSTRAP_ARGS',
      'OD_MCP_BOOTSTRAP_COMMAND',
      'OD_SIDECAR_CLIENT_ENDPOINT',
    ]);
  });
});
