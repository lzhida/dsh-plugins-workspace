/**
 * dsh-open-design 配置持久化单测（配置持久化系列 2/6）。
 *
 * 临时目录走系统临时目录（os.tmpdir），不污染仓库与家目录。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OpenDesignConfig } from './config.ts';
import {
  CONFIG_SCHEMA_VERSION,
  loadStoredConfig,
  parseStoredDocument,
  resolveConfigDir,
  resolveConfigPath,
  resolveDshHome,
  saveStoredConfig,
} from './store.ts';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-open-design-'));
  tempDirs.push(dir);
  return dir;
}

const SAMPLE: OpenDesignConfig = {
  autoDetect: true,
  source: 'custom',
  serverName: 'open-design',
  command: 'E:\\Programs\\Open Design\\Open Design.exe',
  args: ['E:\\Programs\\Open Design\\daemon-cli.mjs', 'mcp'],
  env: {
    OD_DATA_DIR: 'C:\\Users\\AI\\AppData\\Roaming\\Open Design\\data',
    ELECTRON_RUN_AS_NODE: '1',
  },
  cwd: '',
  startupTimeoutMs: 120000,
  toolCallTimeoutMs: 60000,
  detected: {
    method: 'pipe',
    stamp: {
      channel: 'stable',
      namespace: 'release-stable-win',
      source: 'packaged',
      mode: 'runtime',
      app: 'daemon',
    },
    endpoint:
      '\\\\.\\pipe\\open-design-sidecar-6eec4ea0e7395b977771b1af7124c1b9',
    installDir: 'E:\\Programs\\Open Design',
    dataDir: 'C:\\Users\\AI\\AppData\\Roaming\\Open Design\\data',
    daemonCliPath: 'E:\\Programs\\Open Design\\daemon-cli.mjs',
  },
};

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('dsh-open-design store', () => {
  it('把配置目录解析到 DSH_HOME 下的 plugins 子目录', () => {
    const dir = resolveConfigDir({ DSH_HOME: 'D:\\dsh-home' }, 'C:\\Users\\me');
    expect(dir).toBe(join('D:\\dsh-home', 'plugins', 'dsh-open-design'));
  });

  it('在缺少 DSH_HOME 时回落到用户目录下的 .dsh', () => {
    expect(resolveDshHome({}, 'C:\\Users\\me')).toBe(
      join('C:\\Users\\me', '.dsh'),
    );
    expect(resolveConfigDir({}, 'C:\\Users\\me')).toBe(
      join('C:\\Users\\me', '.dsh', 'plugins', 'dsh-open-design'),
    );
  });

  it('把生效配置写入配置文件并原样读回', async () => {
    const dir = await makeTempDir();
    const path = await saveStoredConfig(dir, SAMPLE);
    expect(path).toBe(resolveConfigPath(dir));
    const loaded = await loadStoredConfig(dir);
    expect(loaded?.config.command).toBe(SAMPLE.command);
    expect(loaded?.config.args).toEqual(SAMPLE.args);
    expect(loaded?.config.env).toEqual(SAMPLE.env);
    expect(loaded?.detected?.endpoint).toBe(SAMPLE.detected?.endpoint);
  });

  it('写出的文档带 schemaVersion 与时间戳', async () => {
    const dir = await makeTempDir();
    await saveStoredConfig(dir, SAMPLE, new Date('2026-11-20T12:00:00.000Z'));
    const raw = JSON.parse(await readFile(resolveConfigPath(dir), 'utf8'));
    expect(raw.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
    expect(raw.updatedAt).toBe('2026-11-20T12:00:00.000Z');
    expect(raw.connection.serverName).toBe('open-design');
  });

  it('重复写入保持幂等', async () => {
    const dir = await makeTempDir();
    const at = new Date('2026-11-20T12:00:00.000Z');
    await saveStoredConfig(dir, SAMPLE, at);
    const first = await readFile(resolveConfigPath(dir), 'utf8');
    await saveStoredConfig(dir, SAMPLE, at);
    const second = await readFile(resolveConfigPath(dir), 'utf8');
    expect(second).toBe(first);
  });

  it('在配置文件缺失时返回 null', async () => {
    const dir = await makeTempDir();
    expect(await loadStoredConfig(dir)).toBeNull();
  });

  it('在配置文件损坏时返回 null', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = await makeTempDir();
      await writeFile(resolveConfigPath(dir), '{ not json', 'utf8');
      expect(await loadStoredConfig(dir)).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('配置文件内容损坏'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('在文档版本高于当前实现时拒绝解析', () => {
    expect(
      parseStoredDocument({ schemaVersion: CONFIG_SCHEMA_VERSION + 1 }),
    ).toBeNull();
    expect(
      parseStoredDocument({ schemaVersion: CONFIG_SCHEMA_VERSION }),
    ).not.toBeNull();
  });

  it('丢弃结构不匹配的字段', () => {
    const parsed = parseStoredDocument({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      autoDetect: 'yes',
      connection: { command: 42, args: ['ok', 7], env: { A: 1, B: '2' } },
    });
    expect(parsed?.config.autoDetect).toBeUndefined();
    expect(parsed?.config.command).toBeUndefined();
    expect(parsed?.config.args).toEqual(['ok']);
    expect(parsed?.config.env).toEqual({ B: '2' });
  });

  it('overrides 段随文档写入并原样读回', async () => {
    const dir = await makeTempDir();
    await saveStoredConfig(dir, SAMPLE, new Date('2026-11-20T12:00:00.000Z'), {
      command: 'C:\\custom\\od.exe',
      cwd: '',
    });
    const loaded = await loadStoredConfig(dir);
    expect(loaded?.overrides.command).toBe('C:\\custom\\od.exe');
    expect(loaded?.overrides.cwd).toBe('');
    expect(loaded?.overrides.args).toBeUndefined();
  });

  it('baseline 段随文档写入并原样读回，旧格式文档回落空对象', async () => {
    const dir = await makeTempDir();
    await saveStoredConfig(
      dir,
      SAMPLE,
      new Date('2026-11-20T12:00:00.000Z'),
      {},
      { command: 'C:\\prev\\od.exe' },
    );
    const loaded = await loadStoredConfig(dir);
    expect(loaded?.baseline.command).toBe('C:\\prev\\od.exe');
    expect(loaded?.baseline.cwd).toBeUndefined();
    expect(loaded?.baseline.args).toBeUndefined();
    // 旧格式文档没有 baseline 段 → 空对象（视为「无基线」）。
    const legacy = parseStoredDocument({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      connection: { command: 'x' },
    });
    expect(legacy?.baseline).toEqual({});
  });

  it('覆盖写入前把旧文件备份为 config.json.bak', async () => {
    const dir = await makeTempDir();
    const first = await saveStoredConfig(dir, SAMPLE);
    const before = await readFile(first, 'utf8');
    await saveStoredConfig(dir, { ...SAMPLE, command: 'X:\\new\\od.exe' });
    expect(await readFile(`${first}.bak`, 'utf8')).toBe(before);
    expect(await readFile(first, 'utf8')).not.toBe(before);
  });

  it('detected 块结构不合法时丢弃整个 detected 快照', () => {
    const bogus = parseStoredDocument({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      detected: { method: 'bogus', endpoint: 'x' },
    });
    expect(bogus?.detected).toBeNull();
    const partial = parseStoredDocument({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      detected: {
        method: 'pipe',
        stamp: { channel: 'stable', namespace: 1 },
        endpoint: '\\\\.\\pipe\\x',
      },
    });
    expect(partial?.detected).toBeNull();
  });
});
