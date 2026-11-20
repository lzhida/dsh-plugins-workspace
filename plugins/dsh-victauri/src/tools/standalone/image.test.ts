import { readFileSync, rmSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { VictauriClient } from '../../client.ts';
import { COMPOUND_TOOL_SPECS } from '../compound/catalog.ts';
import { REST_TOOL_SPECS } from './catalog.ts';
import { applyImageChannel, createRestBridgeTool } from './bridge.ts';
import {
  IMAGE_DIR_NAME,
  IMAGE_SAVE_MAX,
  IMAGE_SAVE_MAX_BYTES,
  extForMime,
  isImageValue,
  normalizeImageResult,
  saveImage,
} from './image.ts';
import { RENDER_MAX_CHARS, renderJson } from './render.ts';

/** 1x1 红 PNG 的 base64（与 standalone.test.ts 同源）。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** PNG 魔数：落盘文件必须以此开头才是可解码 PNG。 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 最小 mock client（同 standalone.test.ts 口径）。 */
function mockClient(
  impl: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): VictauriClient {
  return {
    callTool: async (name: string, args: Record<string, unknown>) =>
      impl(name, args),
  } as unknown as VictauriClient;
}

/** trace/animation 在 compound catalog，其余在 standalone catalog；同一通道覆盖两表。 */
const specOf = (name: string) =>
  REST_TOOL_SPECS.find((spec) => spec.name === name) ??
  COMPOUND_TOOL_SPECS.find((spec) => spec.name === name)!;

type AnyRecord = Record<string, unknown>;

/** image 块构造（REST to_rest_json 多块形态）。 */
const imageBlock = (data: string) => ({
  type: 'image',
  data,
  mimeType: 'image/png',
});

/** 清理落盘文件（tests 写入 %TEMP%/dsh-victauri/）。 */
function cleanup(...paths: unknown[]) {
  for (const path of paths) {
    if (typeof path === 'string') rmSync(path, { force: true });
  }
}

describe('image.ts 通用图像值识别', () => {
  it('isImageValue 形状矩阵：{data,mimeType} 即图像，type 可有可无', () => {
    expect(isImageValue({ data: 'aGk=', mimeType: 'image/png' })).toBe(true);
    expect(isImageValue(imageBlock(PNG_BASE64))).toBe(true);
    expect(isImageValue({ data: '', mimeType: 'image/png' })).toBe(false);
    expect(isImageValue({ data: 123, mimeType: 'image/png' })).toBe(false);
    expect(isImageValue({ data: 'aGk=' })).toBe(false);
    expect(isImageValue({ type: 'text', text: 'hello' })).toBe(false);
    expect(isImageValue(null)).toBe(false);
    expect(isImageValue('aGk=')).toBe(false);
    expect(isImageValue([imageBlock(PNG_BASE64)])).toBe(false);
  });

  it('extForMime：常见 mime 映射扩展名，未知兜底', () => {
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('image/svg+xml')).toBe('svg');
    expect(extForMime('audio/mpeg')).toBe('mpeg');
    expect(extForMime('image/png; charset=binary')).toBe('png');
    expect(extForMime('weird')).toBe('bin');
  });

  it('saveImage：单图命名 = <prefix>-<ts>.<ext>，带序号追加 -NNN', () => {
    const saved = saveImage(PNG_BASE64, 'image/png', 'screenshot');
    expect(saved.path).toContain(IMAGE_DIR_NAME);
    expect(saved.path).toMatch(/screenshot-\d+\.png$/);
    expect(saved.bytes).toBeGreaterThan(0);
    expect(readFileSync(saved.path)).toEqual(Buffer.from(PNG_BASE64, 'base64'));
    const framed = saveImage(PNG_BASE64, 'image/png', 'trace', 3);
    expect(framed.path).toMatch(/trace-\d+-003\.png$/);
    cleanup(saved.path, framed.path);
  });

  it('saveImage 字节上限(L-10)：超过 IMAGE_SAVE_MAX_BYTES 抛错不落盘，恰好等于上限可落盘', () => {
    // 超 1 字节:抛错且消息含实际字节数与上限(不写任何文件)
    const big = Buffer.alloc(IMAGE_SAVE_MAX_BYTES + 1, 0x61).toString('base64');
    expect(() => saveImage(big, 'image/png', 'too-big')).toThrowError(
      new RegExp(
        `image too large to save: \\d+ bytes \\(limit ${IMAGE_SAVE_MAX_BYTES}\\)`,
      ),
    );
    // 边界:恰好等于上限,正常落盘
    const exact = Buffer.alloc(IMAGE_SAVE_MAX_BYTES, 0x61).toString('base64');
    const saved = saveImage(exact, 'image/png', 'cap-ok');
    expect(saved.bytes).toBe(IMAGE_SAVE_MAX_BYTES);
    cleanup(saved.path);
  });
});

describe('normalizeImageResult：图像通道归一', () => {
  it('顶层单图（screenshot 形状）→ {path,mime_type,bytes}，image/* 无附加键', () => {
    const out = normalizeImageResult(imageBlock(PNG_BASE64), 'screenshot');
    expect(Object.keys(out!).sort()).toEqual(['bytes', 'mime_type', 'path']);
    expect(out!['mime_type']).toBe('image/png');
    cleanup(out!['path']);
  });

  it('非 image/* mimeType 同通道落盘并在结果中注明未验证', () => {
    const out = normalizeImageResult(
      { data: 'aGVsbG8=', mimeType: 'audio/mpeg' },
      'app_info',
    );
    expect(String(out!['note'])).toContain('非 image');
    expect(out!['path']).toMatch(/\.mpeg$/);
    cleanup(out!['path']);
  });

  it('trace frames 多块数组 → 多帧多文件，顺序与字节保留，提示文本进 notes', () => {
    const notice =
      'returned the newest 3 of 9 frames (response capped at 8 MB)';
    const out = normalizeImageResult(
      [
        imageBlock(PNG_BASE64),
        imageBlock(PNG_BASE64),
        imageBlock(PNG_BASE64),
        { type: 'text', text: notice },
      ],
      'trace',
    );
    const paths = out!['paths'] as string[];
    expect(paths).toHaveLength(3);
    expect(out!['count']).toBe(3);
    expect(out!['mime_type']).toBe('image/png');
    expect(out!['notes']).toEqual([notice]);
    // 多帧多文件：路径互不相同、按保存顺序带序号后缀
    expect(new Set(paths).size).toBe(3);
    paths.forEach((path, i) => {
      expect(path).toMatch(new RegExp(`trace-\\d+-00${i + 1}\\.png$`));
      const bytes = readFileSync(path);
      expect(bytes.subarray(0, 8)).toEqual(PNG_MAGIC);
      expect(bytes).toEqual(Buffer.from(PNG_BASE64, 'base64'));
    });
    cleanup(...paths);
  });

  it('animation scrub capture=true：image 块落盘 + meta JSON 文本块合并进结果', () => {
    const meta = {
      scrubbed: true,
      points: 5,
      captured: true,
      curve: [{ progress: 0, rect: { x: 1 } }],
      filmstrip: {
        cols: 3,
        frame_count: 5,
        manifest: [{ cell: 0, progress: 0 }],
      },
    };
    const out = normalizeImageResult(
      [imageBlock(PNG_BASE64), { type: 'text', text: JSON.stringify(meta) }],
      'animation',
    );
    expect(out!['paths']).toHaveLength(1);
    expect(out!['scrubbed']).toBe(true);
    expect(out!['captured']).toBe(true);
    expect(out!['filmstrip']).toEqual(meta.filmstrip);
    expect(out!['curve']).toEqual(meta.curve);
    expect(out!['notes']).toBeUndefined();
    cleanup(...(out!['paths'] as string[]));
  });

  it('超过 IMAGE_SAVE_MAX 上限：只落盘前 N 张，dropped+note 注明', () => {
    const many = Array.from({ length: IMAGE_SAVE_MAX + 5 }, () =>
      imageBlock(PNG_BASE64),
    );
    const out = normalizeImageResult(many, 'trace');
    const paths = out!['paths'] as string[];
    expect(paths).toHaveLength(IMAGE_SAVE_MAX);
    expect(out!['count']).toBe(IMAGE_SAVE_MAX);
    expect(out!['dropped']).toBe(5);
    expect(String(out!['note'])).toContain(String(IMAGE_SAVE_MAX));
    cleanup(...paths);
  });

  it('无图像结果返回 null（数组/对象/标量），不触发图像通道', () => {
    expect(
      normalizeImageResult([{ tag: 'button' }], 'find_elements'),
    ).toBeNull();
    expect(normalizeImageResult({ frames: 0 }, 'trace')).toBeNull();
    expect(
      normalizeImageResult({ items: [imageBlock(PNG_BASE64)] }, 'x'),
    ).toBeNull();
    expect(normalizeImageResult('plain', 'app_info')).toBeNull();
    expect(
      normalizeImageResult([{ type: 'text', text: 'only text' }], 'trace'),
    ).toBeNull();
  });
});

describe('applyImageChannel（bridge 集成）', () => {
  it('screenshot 回归：单图形状不变且文件名为 screenshot-<ts>.png', async () => {
    const client = mockClient(async () => imageBlock(PNG_BASE64));
    const tool = createRestBridgeTool(specOf('screenshot'), {
      getClient: async () => client,
    });
    const result = (await tool.execute({}, {} as never)) as AnyRecord;
    expect(result['path']).toContain(IMAGE_DIR_NAME);
    expect(result['path']).toMatch(/screenshot-\d+\.png$/);
    expect(result['mime_type']).toBe('image/png');
    expect(result['bytes']).toBeGreaterThan(0);
    cleanup(result['path']);
  });

  it('通用性：非 screenshot 工具返回 {data,mimeType} 同样落盘（特判已推广）', async () => {
    const client = mockClient(async () => ({
      data: PNG_BASE64,
      mimeType: 'image/png',
    }));
    const tool = createRestBridgeTool(specOf('app_info'), {
      getClient: async () => client,
    });
    const result = (await tool.execute({}, {} as never)) as AnyRecord;
    expect(result['path']).toContain(IMAGE_DIR_NAME);
    expect(result['mime_type']).toBe('image/png');
    cleanup(result['path']);
  });

  it('trace frames 经桥：base64 不残留，renderJson 渲染文本短于截断阈值', async () => {
    const client = mockClient(async () => [
      imageBlock(PNG_BASE64),
      { type: 'text', text: 'returned the newest 1 of 9 frames' },
    ]);
    const tool = createRestBridgeTool(specOf('trace'), {
      getClient: async () => client,
    });
    const result = (await tool.execute(
      { action: 'frames' },
      {} as never,
    )) as AnyRecord;
    // 分流发生在 renderJson 6000 字符截断之前:结果与渲染文本都不含 base64
    expect(JSON.stringify(result)).not.toContain('iVBORw0KGgo');
    const text = (renderJson(result)[0] as { text: string }).text;
    expect(text.length).toBeLessThan(RENDER_MAX_CHARS);
    expect(text).not.toContain('iVBORw0KGgo');
    cleanup(...(result['paths'] as string[]));
  });

  it('落盘失败：回退原文（数组包 {items}）+ image_save_error，不吞错', () => {
    const boom = () => {
      throw new Error('disk full');
    };
    const fallback = applyImageChannel(
      [imageBlock(PNG_BASE64)],
      'trace',
      boom,
    )!;
    expect(fallback['image_save_error']).toBe('disk full');
    const items = fallback['items'] as unknown[];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual(imageBlock(PNG_BASE64));
    // 单对象回退:原字段保留
    const single = applyImageChannel(imageBlock(PNG_BASE64), 'x', boom)!;
    expect(single['image_save_error']).toBe('disk full');
    expect(single['data']).toBe(PNG_BASE64);
  });

  it('字节上限经桥(L-10)：超限图像走真实 saveImage 抛错 → image_save_error 回退', () => {
    const big = Buffer.alloc(IMAGE_SAVE_MAX_BYTES + 1, 0x61).toString('base64');
    const out = applyImageChannel(
      { data: big, mimeType: 'image/png' },
      'big-tool',
    );
    expect(out).not.toBeNull();
    const message = String(out!['image_save_error']);
    expect(message).toContain(`limit ${IMAGE_SAVE_MAX_BYTES}`);
    // 巨型 base64 仍在原文里(回退不吞错),由 renderJson 截断兜底
    expect(out!['data']).toBe(big);
  });

  it('frames=0 对象经桥原样返回（不触发图像通道）', async () => {
    const client = mockClient(async () => ({ frames: 0 }));
    const tool = createRestBridgeTool(specOf('trace'), {
      getClient: async () => client,
    });
    const result = (await tool.execute(
      { action: 'frames' },
      {} as never,
    )) as AnyRecord;
    expect(result).toEqual({ frames: 0 });
  });
});
