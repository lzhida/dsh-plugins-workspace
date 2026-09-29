import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodeZstdSessionLog, scanZstdFrames } from './zstd.ts';

describe('dsh-session-stats zstd 多帧解码', () => {
  it('扫描多个独立拼接帧并返回帧边界', () => {
    const frames = [
      zlib.zstdCompressSync(Buffer.from('{"type":"session"}\n', 'utf8'), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      }),
      zlib.zstdCompressSync(Buffer.from('{"type":"turn/start"}\n', 'utf8'), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      }),
      zlib.zstdCompressSync(Buffer.from('{"type":"turn/end"}', 'utf8'), {
        params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 },
      }),
    ];
    const buffer = Buffer.concat(frames);
    const scan = scanZstdFrames(buffer);
    expect(scan.frames).toHaveLength(3);
    expect(scan.tornStart).toBeNull();
    expect(scan.frames[0]).toEqual({ start: 0, end: frames[0].length });
  });

  it('解码多帧日志并还原全部明文', () => {
    const buffer = Buffer.concat([
      zlib.zstdCompressSync(Buffer.from('line-a\n', 'utf8')),
      zlib.zstdCompressSync(Buffer.from('line-b\n', 'utf8')),
    ]);
    expect(decodeZstdSessionLog(buffer)).toBe('line-a\nline-b\n');
  });

  it('识别末尾截断帧并报告 tornStart', () => {
    const full = zlib.zstdCompressSync(Buffer.from('complete\n', 'utf8'));
    const torn = zlib.zstdCompressSync(Buffer.from('x'.repeat(4096), 'utf8'));
    const buffer = Buffer.concat([
      full,
      torn.subarray(0, Math.floor(torn.length / 2)),
    ]);
    const scan = scanZstdFrames(buffer);
    expect(scan.frames).toHaveLength(1);
    expect(scan.tornStart).toBe(full.length);
  });

  it('拒绝非法帧魔数', () => {
    const bad = Buffer.alloc(16, 0xab);
    expect(() => scanZstdFrames(bad)).toThrow(/invalid frame magic/);
  });
});
