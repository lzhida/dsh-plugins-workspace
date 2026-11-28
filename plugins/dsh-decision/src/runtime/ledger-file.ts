/**
 * 文件持久化账本（决策工具系列 5/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §5.4——
 * 落位 `<DSH_HOME>/plugins/dsh-decision/ledger.jsonl`（DSH_HOME 环境变量
 * 缺省回退 `~/.dsh`），JSONL 逐行一条；超过 ledgerMaxEntries 时滚动淘汰
 * 最旧条目，被淘汰条目的 decisionId 之后按 id 查询一律 decision-not-found
 * （调用方返回契约错误码，不猜）。
 *
 * 实现口径：
 * - 启动时全量加载（损坏行跳过并告警，不中断）；append 走追加写，
 *   触顶后整文件重写（临时文件 + rename，进程崩溃不留半截文件）。
 * - 与宿主会话轨迹记账互不相干（契约 §3.6：插件自有本地数据）。
 * - 同步 IO：账本写入频率低（每次模型调用 ≤16 条），同步足够。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { LedgerEntry, LedgerSink } from './ledger.ts';

export interface FileLedgerOptions {
  /** 每次写盘时现取的账本文件路径（支持 DSH_HOME 热切换）。 */
  resolvePath(): string;
  /** 每次触顶判定时现取的上限（volatile 配置热生效）。 */
  resolveMaxEntries(): number;
}

/** 解析账本落位（契约 §5.4）：DSH_HOME 环境变量优先，缺省 ~/.dsh。 */
export function resolveLedgerPath(env?: {
  dshHome?: string | undefined;
  home?: string;
}): string {
  const base =
    env?.dshHome && env.dshHome.trim() !== ''
      ? env.dshHome.trim()
      : join(env?.home ?? '', '.dsh');
  return join(base, 'plugins', 'dsh-decision', 'ledger.jsonl');
}

function isLedgerEntryLike(value: unknown): value is LedgerEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { decisionId?: unknown; ts?: unknown };
  return (
    typeof candidate.decisionId === 'string' && typeof candidate.ts === 'string'
  );
}

/** 从磁盘加载（损坏行跳过 + 告警），返回最旧在前数组。 */
function loadEntries(filePath: string): LedgerEntry[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    // 读取失败 = 硬预算周期用量归零（预算闸变相降级），必须与「损坏行」区分告警
    console.warn(
      '[decision-tools] ledger load failed, starting empty; hard budget statistics reset this cycle',
      error,
    );
    return [];
  }
  const entries: LedgerEntry[] = [];
  let corrupted = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isLedgerEntryLike(parsed)) entries.push(parsed);
      else corrupted += 1;
    } catch {
      corrupted += 1;
    }
  }
  if (corrupted > 0) {
    console.warn(
      `[decision-tools] ledger contains ${corrupted} corrupted line(s), skipped`,
    );
  }
  return entries;
}

/** 整文件原子重写（临时文件 + rename）。 */
function rewriteFile(filePath: string, entries: readonly LedgerEntry[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const body =
    entries.map((entry) => JSON.stringify(entry)).join('\n') +
    (entries.length > 0 ? '\n' : '');
  writeFileSync(tempPath, body, 'utf8');
  renameSync(tempPath, filePath);
}

export function createFileLedger(options: FileLedgerOptions): LedgerSink {
  const entries = loadEntries(options.resolvePath());
  return {
    append(entry: LedgerEntry) {
      const filePath = options.resolvePath();
      const cap = Math.max(1, Math.floor(options.resolveMaxEntries()));
      entries.push(entry);
      if (entries.length > cap) {
        entries.splice(0, entries.length - cap);
        rewriteFile(filePath, entries);
        return;
      }
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch (error) {
        console.warn('[decision-tools] ledger append failed', error);
      }
    },
    list() {
      return [...entries].reverse();
    },
    findById(decisionId: string) {
      return entries.find((item) => item.decisionId === decisionId);
    },
    updateOutcome(decisionId, outcome) {
      const found = entries.find((item) => item.decisionId === decisionId);
      if (!found) return false;
      found.outcome = {
        state: outcome.state,
        value: outcome.value ?? null,
        source: outcome.source ?? 'downstream',
        updatedAt: new Date().toISOString(),
      };
      rewriteFile(options.resolvePath(), entries);
      return true;
    },
    size() {
      return entries.length;
    },
  };
}
