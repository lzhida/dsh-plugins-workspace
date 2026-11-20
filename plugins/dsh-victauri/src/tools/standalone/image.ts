/**
 * 通用图像结果通道：识别 `{data, mimeType}` 形态的图像值并落盘
 * `%TEMP%\dsh-victauri\`，返回 `{path, mime_type, bytes}`（单图）或
 * `{paths[], mime_type, count}`（多图），使图像 base64 不进入
 * renderJson 的 6000 字符截断（不再产生残串）。
 *
 * 线格式（victauri-plugin REST 通道 to_rest_json 实证，0.10.2 源码）：
 * - screenshot：单 image 块 → `{type: 'image', data, mimeType}`；
 * - trace action=frames：多块 → `[{type:'image',...}, {type:'text',...}?]`（截断提示为文本块）；
 * - animation scrub capture=true：`[{type:'image',...}, {type:'text', text:<meta JSON>}]`
 *   （meta 含 curve / filmstrip.manifest，JSON 对象文本合并进结果）。
 *
 * 非图像 mimeType（如音频）按同一通道落盘但在结果中注明未验证；
 * 落盘失败时 throw，由 bridge 层回退原文返回并保留错误信息（不吞错）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue } from '../../json.ts';

/** 图像落盘目录名（%TEMP% 之下，与 screenshot 历史行为一致）。 */
export const IMAGE_DIR_NAME = 'dsh-victauri';

/** 单次调用最多落盘的图像文件数（trace 环形缓冲上限 600、filmstrip 上限 120）。 */
export const IMAGE_SAVE_MAX = 120;

/**
 * 单张图像落盘字节上限（20MiB，L-10）。超过它 saveImage 直接 throw
 * （不写盘），由 applyImageChannel 的既有回退兜成 image_save_error——
 * 避免 None 界的巨型 base64 解码后把临时目录当垃圾桶。
 */
export const IMAGE_SAVE_MAX_BYTES = 20 * 1024 * 1024;

/** 图像值形状：{data(base64), mimeType}，type 字段可有可无。 */
export interface ImageValue {
  data: string;
  mimeType: string;
  type?: string;
}

/** 落盘结果引用（dsh-browser 同款惯例：回路径不回内容）。 */
export interface SavedImage {
  path: string;
  mime_type: string;
  bytes: number;
}

/** 通用图像值识别：顶层对象含非空 data + mimeType 字符串即视为图像。 */
export function isImageValue(value: unknown): value is ImageValue {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const data = record['data'];
  const mimeType = record['mimeType'];
  return (
    typeof data === 'string' &&
    data.length > 0 &&
    typeof mimeType === 'string' &&
    mimeType.length > 0
  );
}

/** REST 多块结果中的文本块形状守卫（先于 isImageValue 判断 data/mimeType）。 */
export function isTextBlockValue(
  value: unknown,
): value is { type: string; text: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['text'] === 'string' && record['data'] === undefined;
}

/** mimeType → 文件扩展名（未识别的取子类型净化值，兜底 bin）。 */
export function extForMime(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.toLowerCase() ?? '';
  const known: Record<string, string> = {
    'svg+xml': 'svg',
    jpeg: 'jpg',
    'x-icon': 'ico',
  };
  const ext = known[subtype] ?? subtype.replace(/[^a-z0-9]/g, '');
  return ext || 'bin';
}

/**
 * 落盘单张图像：`%TEMP%\dsh-victauri\<prefix>-<ts>[-NNN].<ext>`。
 * index 省略时文件名与 screenshot 历史命名完全一致（`screenshot-<ts>.png`）。
 * @throws 单图解码后超过 IMAGE_SAVE_MAX_BYTES、或写盘失败时向上抛
 *   （bridge 层捕获后回退原文返回 + image_save_error）。
 */
export function saveImage(
  data: string,
  mimeType: string,
  prefix: string,
  index?: number,
): SavedImage {
  const dir = join(tmpdir(), IMAGE_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const suffix =
    index === undefined ? '' : `-${String(index).padStart(3, '0')}`;
  const file = join(dir, `${prefix}-${stamp}${suffix}.${extForMime(mimeType)}`);
  const buf = Buffer.from(data, 'base64');
  if (buf.byteLength > IMAGE_SAVE_MAX_BYTES) {
    throw new Error(
      `image too large to save: ${buf.byteLength} bytes (limit ${IMAGE_SAVE_MAX_BYTES})`,
    );
  }
  writeFileSync(file, buf);
  return { path: file, mime_type: mimeType, bytes: buf.byteLength };
}

/** 非 image/* mimeType 的未验证提示（结果内注明，不吞差异）。 */
const NON_IMAGE_MIME_NOTE = 'mimeType 非 image/*，同通道落盘（未经活体验证）';

/** 文本块内容尝试按 JSON 对象解析（失败/非对象返回 null）。 */
function tryParseJsonObject(text: string): Record<string, JsonValue> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, JsonValue>;
    }
  } catch {
    // 非 JSON 文本：按 notes 原文保留
  }
  return null;
}

/**
 * 图像结果归一：把 callTool 结果中的图像值落盘并替换为文件引用。
 * 返回 null = 结果不含图像（调用方走原 toRecord 通道，零行为变化）。
 * @throws 任一次落盘失败时向上抛（调用方回退原文返回 + image_save_error）。
 */
export function normalizeImageResult(
  value: unknown,
  toolName: string,
  save: typeof saveImage = saveImage,
): Record<string, JsonValue> | null {
  // 顶层单图（screenshot 及任何 {data,mimeType} 对象）
  if (isImageValue(value)) {
    const saved = save(value.data, value.mimeType, toolName);
    const out: Record<string, JsonValue> = { ...saved };
    if (!value.mimeType.startsWith('image/')) out['note'] = NON_IMAGE_MIME_NOTE;
    return out;
  }
  if (!Array.isArray(value)) return null;

  // REST 多块数组：image 块落盘、text 块 JSON 合并 / 原文进 notes
  const images: SavedImage[] = [];
  let dropped = 0;
  const notes: string[] = [];
  const merged: Record<string, JsonValue> = {};
  let sawImage = false;
  for (const item of value) {
    if (isImageValue(item)) {
      sawImage = true;
      if (images.length >= IMAGE_SAVE_MAX) {
        dropped++;
        continue;
      }
      images.push(save(item.data, item.mimeType, toolName, images.length + 1));
    } else if (isTextBlockValue(item)) {
      const parsed = tryParseJsonObject(item.text);
      if (parsed) Object.assign(merged, parsed);
      else notes.push(item.text);
    } else {
      notes.push(JSON.stringify(item) ?? String(item));
    }
  }
  if (!sawImage) return null;

  // 合并顺序：meta JSON 在前、通道键在后（同名时以落盘事实为准）
  const out: Record<string, JsonValue> = {
    ...merged,
    paths: images.map((img) => img.path),
    mime_type: images[0]!.mime_type,
    count: images.length,
  };
  if (dropped > 0) {
    out['dropped'] = dropped;
    out['note'] =
      `共 ${images.length + dropped} 张图像，超过单次落盘上限 ${IMAGE_SAVE_MAX}，仅落盘前 ${images.length} 张`;
  } else if (!images[0]!.mime_type.startsWith('image/')) {
    out['note'] = NON_IMAGE_MIME_NOTE;
  }
  if (notes.length > 0) out['notes'] = notes;
  return out;
}
