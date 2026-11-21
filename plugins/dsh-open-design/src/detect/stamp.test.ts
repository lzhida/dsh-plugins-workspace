/**
 * dsh-open-design 探测模块单测（一）：语义戳与命名管道端点推算。
 *
 * 覆盖：黄金摘要、键值串顺序、命令行标记解析、候选集合生成与兜底 namespace。
 */
import { describe, expect, it } from 'vitest';

import type { SidecarStamp } from '../config.ts';
import {
  buildStampCandidates,
  computePipeDigest,
  computePipeEndpoint,
  defaultNamespaceDir,
  FALLBACK_NAMESPACE,
  parseStampFlags,
  sidecarStampKey,
  STAMP_FIELDS,
} from './stamp.ts';

/** 本机黄金语义戳（与 Open Design 侧 supervisor 的实际标记一致）。 */
const GOLDEN_STAMP: SidecarStamp = {
  channel: 'stable',
  namespace: 'release-stable-win',
  source: 'packaged',
  mode: 'runtime',
  app: 'daemon',
};

/** 本机黄金摘要：sha256('AI\n' + 键值串) 前 32 位十六进制。 */
const GOLDEN_DIGEST = '6eec4ea0e7395b977771b1af7124c1b9';

/** 本机主体名（Windows 用户名）。 */
const GOLDEN_PRINCIPAL = 'AI';

/** 运行中的 sidecar 监督进程命令行（真实形态）。 */
const DAEMON_COMMAND_LINE = String.raw`"E:\Programs\Open Design\Open Design.exe" "E:\Programs\Open Design\resources\app\node_modules\@open-design\sidecar\dist\supervisor.mjs" --od-stamp-channel=stable --od-stamp-namespace=release-stable-win --od-stamp-source=packaged --od-stamp-mode=runtime --od-stamp-app=daemon`;

describe('dsh-open-design stamp', () => {
  it('按固定字段顺序拼出语义键值串', () => {
    expect(sidecarStampKey(GOLDEN_STAMP)).toBe(
      'channel=stable\nnamespace=release-stable-win\nsource=packaged\nmode=runtime\napp=daemon',
    );
    expect([...STAMP_FIELDS]).toEqual([
      'channel',
      'namespace',
      'source',
      'mode',
      'app',
    ]);
  });

  it('对黄金语义戳算出既定管道摘要', () => {
    expect(computePipeDigest(GOLDEN_PRINCIPAL, GOLDEN_STAMP)).toBe(
      GOLDEN_DIGEST,
    );
    expect(computePipeDigest(GOLDEN_PRINCIPAL, GOLDEN_STAMP)).toHaveLength(32);
  });

  it('把语义戳拼成完整命名管道端点', () => {
    expect(computePipeEndpoint(GOLDEN_PRINCIPAL, GOLDEN_STAMP)).toBe(
      `\\\\.\\pipe\\open-design-sidecar-${GOLDEN_DIGEST}`,
    );
  });

  it('换主体名会得到不同摘要', () => {
    expect(computePipeDigest('other-user', GOLDEN_STAMP)).not.toBe(
      GOLDEN_DIGEST,
    );
  });

  it('换语义字段会得到不同摘要', () => {
    expect(
      computePipeDigest(GOLDEN_PRINCIPAL, { ...GOLDEN_STAMP, app: 'desktop' }),
    ).not.toBe(GOLDEN_DIGEST);
    expect(
      computePipeDigest(GOLDEN_PRINCIPAL, {
        ...GOLDEN_STAMP,
        channel: 'release-stable',
      }),
    ).not.toBe(GOLDEN_DIGEST);
  });

  it('从进程命令行解析出五个语义标记', () => {
    expect(parseStampFlags(DAEMON_COMMAND_LINE)).toEqual(GOLDEN_STAMP);
  });

  it('命令行缺少任一标记时返回空', () => {
    expect(parseStampFlags('')).toBeNull();
    expect(
      parseStampFlags(String.raw`"E:\Programs\Open Design\Open Design.exe"`),
    ).toBeNull();
    expect(
      parseStampFlags(
        '--od-stamp-channel=stable --od-stamp-namespace=release-stable-win --od-stamp-source=packaged --od-stamp-mode=runtime',
      ),
    ).toBeNull();
  });

  it('按命名空间目录枚举生成候选集合', () => {
    const candidates = buildStampCandidates({
      principal: GOLDEN_PRINCIPAL,
      namespaceDir: String.raw`C:\Users\AI\AppData\Roaming\Open Design\namespaces`,
      readNamespaces: () => ['release-stable-win', 'beta-win'],
    });
    // 2 个 namespace × 2 个 channel
    expect(candidates).toHaveLength(4);
    const golden = candidates.find(
      (candidate) =>
        candidate.stamp.namespace === 'release-stable-win' &&
        candidate.stamp.channel === 'stable',
    );
    expect(golden?.digest).toBe(GOLDEN_DIGEST);
    expect(golden?.endpoint).toBe(
      `\\\\.\\pipe\\open-design-sidecar-${GOLDEN_DIGEST}`,
    );
  });

  it('枚举不到命名空间目录时使用兜底命名空间', () => {
    const candidates = buildStampCandidates({
      principal: GOLDEN_PRINCIPAL,
      namespaceDir: String.raw`C:\nonexistent\namespaces`,
      readNamespaces: () => {
        throw new Error('目录不可读');
      },
    });
    expect(candidates).toHaveLength(2);
    expect(
      candidates.every(
        (candidate) => candidate.stamp.namespace === FALLBACK_NAMESPACE,
      ),
    ).toBe(true);
    expect(candidates.map((candidate) => candidate.digest)).toContain(
      GOLDEN_DIGEST,
    );
  });

  it('候选集合覆盖多个通道且摘要不重复', () => {
    const candidates = buildStampCandidates({
      principal: GOLDEN_PRINCIPAL,
      namespaceDir: String.raw`C:\nonexistent\namespaces`,
      readNamespaces: () => [],
      channels: ['stable', 'release-stable', 'beta'],
    });
    expect(candidates).toHaveLength(3);
    expect(new Set(candidates.map((candidate) => candidate.digest)).size).toBe(
      3,
    );
    expect(
      candidates.every((candidate) => candidate.stamp.source === 'packaged'),
    ).toBe(true);
    expect(
      candidates.every((candidate) => candidate.stamp.mode === 'runtime'),
    ).toBe(true);
    expect(
      candidates.every((candidate) => candidate.stamp.app === 'daemon'),
    ).toBe(true);
  });

  it('按数据根目录推导命名空间目录', () => {
    expect(defaultNamespaceDir(String.raw`C:\Users\AI\AppData\Roaming`)).toBe(
      String.raw`C:\Users\AI\AppData\Roaming\Open Design\namespaces`,
    );
    expect(defaultNamespaceDir('')).toBe('');
  });
});
