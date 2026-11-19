/**
 * docx 正文文本提取（纯 Node，无第三方依赖）。
 *
 * docx 本质是 zip 容器，正文在 `word/document.xml`。这里做最小实现：
 * 读 zip 中央目录 → 定位 `word/document.xml` → inflate → 抽段落文本。
 * 不引第三方依赖（仓内无 mammoth/jszip），也不做排版还原——只取「能读懂」
 * 的纯文本：段落之间空一行、制表符与换行标记按 XML 顺序还原。
 *
 * 用途：`draft_review_check` 接受「已提取文本」或「.docx 路径」两种入参，
 * 后者走本模块。解析失败时抛错，由调用方转成可读提示（让模型改走提取
 * 文本的既有链路），不静默返回空文本。
 */

import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

/** zip 中央目录文件头签名。 */
const CENTRAL_SIGNATURE = 0x02014b50;
/** zip 结束记录签名。 */
const EOCD_SIGNATURE = 0x06054b50;
/** zip 本地文件头签名。 */
const LOCAL_SIGNATURE = 0x04034b50;

/** zip 内目标条目名。 */
const DOCUMENT_ENTRY = 'word/document.xml';

/** docx 体积上限（32MB）：初稿文件远小于此，超过多半不是正常 docx。 */
const MAX_DOCX_BYTES = 32 * 1024 * 1024;

/** 解压后正文上限（64MB）：防止异常压缩比把内存打爆。 */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/** 从 buffer 中定位 EOCD(结束记录)偏移；找不到返回 -1。 */
function findEocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/** 读取 zip 中某个条目并解压为文本（非 UTF-8 字节一律按 latin1 兜底）。 */
function readZipEntry(buffer: Buffer, wanted: string): Buffer | null {
  const eocd = findEocd(buffer);
  if (eocd < 0) return null;
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) return null;
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8');
    if (name === wanted) {
      if (localOffset + 30 > buffer.length) return null;
      if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) return null;
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) {
        try {
          return inflateRawSync(data, { maxOutputLength: MAX_INFLATED_BYTES });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(
            `解压「${wanted}」失败（${detail}）。文件可能已损坏或为异常压缩比，请改用 office skill 提取文本后传入。`,
            { cause: error },
          );
        }
      }
      return null;
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** WordprocessingML 转义字符还原（&amp; &lt; &gt; &quot; &apos;）。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 从 `word/document.xml` 抽纯文本：段落之间空一行，制表/换行标记按 XML
 * 出现顺序还原（表格单元格之间因此留下制表符，便于按列读）。
 */
export function extractDocxXmlText(xml: string): string {
  const paragraphs = xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
  const lines: string[] = [];
  const TOKEN_RE =
    /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
  for (const paragraph of paragraphs) {
    let text = '';
    for (const token of paragraph.matchAll(TOKEN_RE)) {
      const raw = token[0];
      if (raw.startsWith('<w:tab')) text += '\t';
      else if (raw.startsWith('<w:br')) text += '\n';
      else text += decodeEntities(token[1] ?? '');
    }
    lines.push(text);
  }
  // 段落之间空一行：重复度检测按空行分段，空行缺失会让整篇退化成一整块。
  return lines.join('\n\n');
}

/**
 * 读取 .docx 文件的正文纯文本。
 *
 * @throws 当文件不可读、不是合法 zip、或缺少 `word/document.xml` 时抛错，
 *         错误信息面向模型可读（提示改为先提取文本再传入）。
 */
export function extractDocxText(path: string): string {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 docx 文件「${path}」：${detail}`, {
      cause: error,
    });
  }
  if (buffer.length > MAX_DOCX_BYTES) {
    throw new Error(
      `「${path}」体积超过上限（${MAX_DOCX_BYTES} 字节），不像正常的初稿 docx；请改用 office skill 提取文本后传入。`,
    );
  }
  const xml = readZipEntry(buffer, DOCUMENT_ENTRY);
  if (!xml) {
    throw new Error(
      `「${path}」不是可解析的 docx（缺少 ${DOCUMENT_ENTRY}）。请先用 office skill 或捆绑 python-docx 提取文本，再把文本传入本工具。`,
    );
  }
  return extractDocxXmlText(xml.toString('utf8'));
}

/** 判断入参是否「看起来是 docx 路径」。 */
export function looksLikeDocxPath(value: string): boolean {
  return /\.docx$/i.test(value.trim());
}
