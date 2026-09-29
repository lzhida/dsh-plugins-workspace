import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * DSH 会话日志（session.v4.jsonl.zstd）是「一行一帧」的独立 Zstandard 帧拼接：
 * 每帧压缩一条 JSONL 事件（首帧为 session 头）。帧边界扫描算法与
 * `@deepseek-ai/dsh-session-persistence-jsonl` 的 scanZstdFrames 保持一致。
 */

const ZSTD_MAGIC = 4247762216;

export interface ZstdFrameRange {
  start: number;
  end: number;
}

export interface ZstdFrameScan {
  frames: ZstdFrameRange[];
  /** 末尾截断帧的起始偏移；无截断时为 null。 */
  tornStart: number | null;
}

/** 定位完整帧（不解压块）；末尾被截断的帧记录其起点。 */
export function scanZstdFrames(
  buffer: Buffer,
  maxFrames = Number.POSITIVE_INFINITY,
): ZstdFrameScan {
  const frames: ZstdFrameRange[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(
        `corrupt Zstandard session log: invalid frame magic at byte ${offset}`,
      );
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) {
      throw new Error(
        `corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`,
      );
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes)
      return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) {
        throw new Error(
          `corrupt Zstandard session log: reserved block type at byte ${offset - 3}`,
        );
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes)
        return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames, tornStart: null };
  }
  return { frames, tornStart: null };
}

/** 运行时是否具备 Node 内建 zstd 能力（Node >= 22.15 / 23.8）。 */
export function hasZstdSupport(): boolean {
  return typeof zlib.zstdDecompressSync === 'function';
}

/** 解压全部完整帧并拼接为明文；截断帧的可用前缀一并恢复。 */
export function decodeZstdSessionLog(buffer: Buffer): string {
  if (!hasZstdSupport()) {
    throw new Error('当前 Node 缺少内建 zstd 支持，需要 Node >= 22.15');
  }
  const { frames, tornStart } = scanZstdFrames(buffer);
  const parts: string[] = [];
  for (const frame of frames) {
    parts.push(
      zlib
        .zstdDecompressSync(buffer.subarray(frame.start, frame.end))
        .toString('utf8'),
    );
  }
  if (tornStart !== null) {
    // 截断帧：尽力恢复已写入的明文前缀。
    try {
      const recovered = zlib.zstdDecompressSync(buffer.subarray(tornStart), {
        finishFlush: zlib.constants.ZSTD_e_flush,
      });
      parts.push(recovered.toString('utf8'));
    } catch {
      // 彻底不可恢复的尾巴直接忽略。
    }
  }
  return parts.join('');
}

/** 解码一个会话文件（.jsonl.zstd 或明文 .jsonl）为 JSONL 行数组。 */
export function readSessionLines(filePath: string): string[] {
  const bytes = fs.readFileSync(filePath);
  const isZstd = filePath.endsWith('.zstd');
  const text = isZstd ? decodeZstdSessionLog(bytes) : bytes.toString('utf8');
  return text.split('\n').filter((line) => line.trim().length > 0);
}
