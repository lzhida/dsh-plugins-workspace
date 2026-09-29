import fs from 'node:fs';
import path from 'node:path';
import { discoverSessionFiles } from './discover.ts';
import { extractSession } from './extract.ts';
import { readSessionLines } from './zstd.ts';
import type { SessionFileInfo } from './discover.ts';
import type { SessionRecord, StoreFile, SyncResult } from './types.ts';

/** 会话统计 store 文件的默认位置。 */
export function defaultStorePath(dshHome: string): string {
  return path.join(dshHome, 'dsh-session-stats', 'store.json');
}

export function loadStore(storePath: string): StoreFile {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as StoreFile;
    if (
      raw &&
      raw.version === 1 &&
      typeof raw.sessions === 'object' &&
      raw.sessions !== null
    ) {
      return raw;
    }
  } catch {
    // 不存在或损坏：从空 store 开始。
  }
  return { version: 1, syncedAt: 0, sessions: {} };
}

export function saveStore(storePath: string, store: StoreFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, storePath);
}

function recordIsFresh(file: SessionFileInfo, record: SessionRecord): boolean {
  return record.fileMtimeMs === file.mtimeMs && record.fileBytes === file.size;
}

/** 从单个会话文件构建记录；解析失败返回 null 并携带原因。 */
export function buildRecord(file: SessionFileInfo): {
  record: SessionRecord | null;
  reason?: string;
} {
  try {
    const lines = readSessionLines(file.absolutePath);
    const record = extractSession(lines, {
      sourceFile: file.absolutePath,
      fileBytes: file.size,
      fileMtimeMs: file.mtimeMs,
    });
    return { record };
  } catch (error) {
    return {
      record: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface SyncOptions {
  dshHome: string;
  storePath?: string;
  /** 强制重新解码全部文件。 */
  force?: boolean;
}

/**
 * 增量同步全部本地会话文件：mtime/size 未变的文件直接复用记录，
 * 变化与新增的文件重新解码，消失的文件从 store 移除。
 */
export function syncSessions(options: SyncOptions): {
  store: StoreFile;
  result: SyncResult;
} {
  const startedAt = Date.now();
  const storePath = options.storePath ?? defaultStorePath(options.dshHome);
  const store = loadStore(storePath);
  const files = discoverSessionFiles(options.dshHome);
  const seen = new Set(files.map((file) => file.absolutePath));
  let processed = 0;

  for (const file of files) {
    const existing = store.sessions[file.absolutePath];
    if (!options.force && existing && recordIsFresh(file, existing)) continue;
    const { record } = buildRecord(file);
    if (record) {
      store.sessions[file.absolutePath] = record;
    } else if (existing && !options.force) {
      // 解码失败（如文件正在写入）：保留旧记录。
    } else {
      delete store.sessions[file.absolutePath];
    }
    processed += 1;
  }

  for (const known of Object.keys(store.sessions)) {
    if (!seen.has(known)) delete store.sessions[known];
  }

  store.syncedAt = Date.now();
  if (processed > 0) saveStore(storePath, store);

  const records = Object.values(store.sessions);
  return {
    store,
    result: {
      files: files.length,
      processed,
      sessions: records.length,
      totalMessages: records.reduce(
        (sum, r) => sum + r.userMessages + r.assistantMessages,
        0,
      ),
      durationMs: Date.now() - startedAt,
    },
  };
}

/** 一次性解码全部文件并返回记录（不落 store，供测试/导出使用）。 */
export function scanAllSessions(dshHome: string): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const file of discoverSessionFiles(dshHome)) {
    const { record } = buildRecord(file);
    if (record) records.push(record);
  }
  return records;
}
