/**
 * config.ts 测试：默认值、volatile 解包、双后端归一化、组过滤与数值回退。
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_CLI_BIN,
  DEFAULT_CLI_URL,
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveConfig,
  unwrapVolatile,
} from './config.ts';

/** 构造 cosmokit volatile 引用假体（Symbol.for 跨副本稳定）。 */
function fakeVolatile(value: unknown): { get: () => unknown } {
  return {
    [Symbol.for('cosmokit.volatile.write')]: true,
    get: () => value,
  } as { get: () => unknown };
}

describe('dsh-anytype config', () => {
  it('undefined 输入回落全默认（auto 模式、desktop 默认地址、CLI 未配置）', () => {
    const cfg = resolveConfig(undefined);
    expect(cfg.enabled).toBe(true);
    expect(cfg.backendMode).toBe('auto');
    expect(cfg.desktop.url).toBe(DEFAULT_BASE_URL);
    expect(cfg.desktop.key).toBe('');
    expect(cfg.cli.url).toBe(DEFAULT_CLI_URL);
    expect(cfg.cli.key).toBe('');
    expect(cfg.cli.binPath).toBe(DEFAULT_CLI_BIN);
    expect(cfg.cli.autoStart).toBe(false);
    expect(cfg.disabledGroups.size).toBe(0);
    expect(cfg.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(cfg.maxResponseChars).toBe(DEFAULT_MAX_RESPONSE_CHARS);
  });

  it('volatile 引用被深度解包（嵌套字段可读）', () => {
    const cfg = resolveConfig({
      enabled: fakeVolatile(true),
      apiKey: fakeVolatile(' vk '),
      cliKey: fakeVolatile(' bot '),
      disabledGroups: fakeVolatile(['search']),
    });
    expect(cfg.enabled).toBe(true);
    expect(cfg.desktop.key).toBe('vk');
    expect(cfg.cli.key).toBe('bot');
    expect(cfg.disabledGroups.has('search')).toBe(true);
  });

  it('unwrapVolatile 直接解包普通值原样返回', () => {
    expect(
      unwrapVolatile({ a: fakeVolatile(1), b: [fakeVolatile('x')] }),
    ).toEqual({
      a: 1,
      b: ['x'],
    });
    expect(unwrapVolatile(42)).toBe(42);
  });

  it('双后端 URL 各自归一化：去尾斜杠；非法值回落各自默认', () => {
    const ok = resolveConfig({
      baseUrl: 'http://localhost:31009/',
      cliUrl: 'http://127.0.0.1:39999/',
    });
    expect(ok.desktop.url).toBe('http://localhost:31009');
    expect(ok.cli.url).toBe('http://127.0.0.1:39999');
    const bad = resolveConfig({ baseUrl: 'ftp://x', cliUrl: 'not a url' });
    expect(bad.desktop.url).toBe(DEFAULT_BASE_URL);
    expect(bad.cli.url).toBe(DEFAULT_CLI_URL);
  });

  it('backendMode 只认 auto/desktop/cli，其余回落 auto', () => {
    expect(resolveConfig({ backend: 'cli' }).backendMode).toBe('cli');
    expect(resolveConfig({ backend: 'desktop' }).backendMode).toBe('desktop');
    expect(resolveConfig({ backend: 'auto' }).backendMode).toBe('auto');
    expect(resolveConfig({ backend: 'bogus' }).backendMode).toBe('auto');
    expect(resolveConfig({ backend: 42 }).backendMode).toBe('auto');
  });

  it('cliPath trim；空回落默认二进制名', () => {
    const cfg = resolveConfig({ cliPath: '  ' });
    expect(cfg.cli.binPath).toBe(DEFAULT_CLI_BIN);
  });

  it('cliAutoStart 仅字面 true 生效', () => {
    expect(resolveConfig({ cliAutoStart: true }).cli.autoStart).toBe(true);
    expect(resolveConfig({ cliAutoStart: 'yes' }).cli.autoStart).toBe(false);
    expect(resolveConfig({ cliAutoStart: 1 }).cli.autoStart).toBe(false);
  });

  it('apiKey/cliKey trim；空 apiVersion 回落默认', () => {
    const cfg = resolveConfig({
      apiKey: '  k  ',
      cliKey: 123,
      apiVersion: '  ',
    });
    expect(cfg.desktop.key).toBe('k');
    expect(cfg.cli.key).toBe('123');
    expect(cfg.apiVersion).toBe(DEFAULT_API_VERSION);
  });

  it('disabledGroups 过滤未知组名，只保留合法组', () => {
    const cfg = resolveConfig({
      disabledGroups: ['search', 'bogus', 'generic'],
    });
    const groups: ReadonlySet<string> = cfg.disabledGroups;
    expect(groups.has('search')).toBe(true);
    expect(groups.has('generic')).toBe(true);
    expect(groups.has('bogus')).toBe(false);
    expect(cfg.disabledGroups.size).toBe(2);
  });

  it('非数组 disabledGroups 安全回退为空集', () => {
    expect(
      resolveConfig({ disabledGroups: 'search' }).disabledGroups.size,
    ).toBe(0);
  });

  it('超时/截断上限：非正数与非有限数回落默认', () => {
    expect(resolveConfig({ requestTimeoutMs: -5 }).requestTimeoutMs).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    expect(resolveConfig({ requestTimeoutMs: 1500 }).requestTimeoutMs).toBe(
      1500,
    );
    expect(
      resolveConfig({ maxResponseChars: Number.NaN }).maxResponseChars,
    ).toBe(DEFAULT_MAX_RESPONSE_CHARS);
  });
});
