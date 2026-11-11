import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compareByStartedDesc,
  discoveryRoots,
  pickLatest,
  resolveLatestInstance,
  scanInstances,
  sortCandidates,
} from './discovery.ts';
import { VictauriError } from './errors.ts';

/** 在临时 discovery 根下写一个实例目录;选项可模拟各类残缺场景。 */
function writeInstance(
  root: string,
  pid: number,
  opts: {
    identifier?: string;
    port?: number;
    startedAt?: string;
    productName?: string;
    version?: string;
    token?: string;
    portContent?: string;
    metadataContent?: string;
    omit?: Array<'metadata.json' | 'port' | 'token'>;
  } = {},
): string {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  if (!opts.omit?.includes('metadata.json')) {
    const meta =
      opts.metadataContent ??
      JSON.stringify({
        identifier: opts.identifier ?? 'com.example.app',
        pid,
        port: opts.port ?? 7373,
        product_name: opts.productName ?? 'demo',
        started_at: opts.startedAt ?? '2026-11-02T08:00:00.000Z',
        version: opts.version ?? '0.10.2',
      });
    writeFileSync(join(dir, 'metadata.json'), meta, 'utf8');
  }
  if (!opts.omit?.includes('port')) {
    writeFileSync(
      join(dir, 'port'),
      opts.portContent ?? String(opts.port ?? 7373),
      'utf8',
    );
  }
  if (!opts.omit?.includes('token')) {
    writeFileSync(join(dir, 'token'), opts.token ?? 'tok-token', 'utf8');
  }
  return dir;
}

function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'victauri-test-'));
}

describe('dsh-victauri discovery', () => {
  it('扫描全部实例目录并解析 metadata/port/token', () => {
    const root = makeRoot();
    writeInstance(root, 100, { identifier: 'com.a', port: 7373 });
    writeInstance(root, 200, { identifier: 'com.b', port: 7374 });
    const list = scanInstances({ rootDir: root });
    expect(list).toHaveLength(2);
    const first = list[0];
    expect(first?.pid).toBe(100);
    expect(first?.port).toBe(7373);
    expect(first?.token).toBe('tok-token');
    expect(first?.identifier).toBe('com.a');
    expect(first?.productName).toBe('demo');
    expect(first?.version).toBe('0.10.2');
    rmSync(root, { recursive: true, force: true });
  });

  it('pickLatest 按 started_at 降序选最新,缺失时间戳排最后', () => {
    const old = {
      pid: 1,
      port: 7373,
      token: 'a',
      identifier: null,
      productName: null,
      startedAt: '2026-11-01T00:00:00.000Z',
      version: null,
      dir: '/1',
    };
    const newest = {
      ...old,
      pid: 2,
      startedAt: '2026-11-02T09:00:00.000Z',
      token: 'b',
    };
    const noTime = { ...old, pid: 3, startedAt: null, token: 'c' };
    expect(pickLatest([old, noTime, newest])?.pid).toBe(2);
    expect(pickLatest([])).toBeNull();
    // 时间戳相同时 pid 大者在前(排序稳定可复现)
    const twinA = { ...old, pid: 10, token: 'x' };
    const twinB = { ...old, pid: 11, token: 'y' };
    expect(pickLatest([twinA, twinB])?.pid).toBe(11);
  });

  it('sortCandidates 返回 started_at 降序完整候选列表', () => {
    const a = { pid: 1, startedAt: '2026-11-02T08:00:00.000Z' } as Parameters<
      typeof compareByStartedDesc
    >[0];
    const b = { pid: 2, startedAt: '2026-11-02T09:00:00.000Z' } as typeof a;
    const sorted = sortCandidates([a, b]);
    expect(sorted.map((x) => x.pid)).toEqual([2, 1]);
  });

  it('identifier 过滤只保留匹配 bundle id 的实例', () => {
    const root = makeRoot();
    writeInstance(root, 100, { identifier: 'com.a' });
    writeInstance(root, 200, { identifier: 'com.b' });
    const filtered = scanInstances({ rootDir: root, identifier: 'com.b' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.pid).toBe(200);
    rmSync(root, { recursive: true, force: true });
  });

  it('残缺目录逐个容错跳过:缺文件/坏 JSON/非法端口/空 token', () => {
    const root = makeRoot();
    writeInstance(root, 100, { omit: ['token'] });
    writeInstance(root, 101, { metadataContent: '{broken' });
    writeInstance(root, 102, { portContent: 'not-a-port' });
    writeInstance(root, 103, { token: '   ' });
    writeInstance(root, 104, {}); // 唯一完好
    const list = scanInstances({ rootDir: root });
    expect(list).toHaveLength(1);
    expect(list[0]?.pid).toBe(104);
    rmSync(root, { recursive: true, force: true });
  });

  it('根目录不存在返回空数组而非抛错', () => {
    expect(scanInstances({ rootDir: join(makeRoot(), 'nope') })).toEqual([]);
  });

  it('多根扫描合并结果', () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    writeInstance(rootA, 100, { identifier: 'com.a' });
    writeInstance(rootB, 200, { identifier: 'com.b' });
    const merged = scanInstances({ rootDir: [rootA, rootB] });
    expect(merged.map((x) => x.pid).sort()).toEqual([100, 200]);
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('resolveLatestInstance 返回最新实例,无候选时抛 no-instance', () => {
    const root = makeRoot();
    writeInstance(root, 100, { startedAt: '2026-11-02T08:00:00.000Z' });
    writeInstance(root, 200, { startedAt: '2026-11-02T09:00:00.000Z' });
    expect(resolveLatestInstance({ rootDir: root }).pid).toBe(200);
    try {
      resolveLatestInstance({ rootDir: join(makeRoot(), 'nope') });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VictauriError);
      expect((err as VictauriError).kind).toBe('no-instance');
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('discoveryRoots:Windows 单根,类 Unix 多根候选', () => {
    const roots = discoveryRoots();
    if (process.platform === 'win32') {
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatch(/victauri$/);
    } else {
      expect(roots.length).toBeGreaterThanOrEqual(2);
    }
  });
});
