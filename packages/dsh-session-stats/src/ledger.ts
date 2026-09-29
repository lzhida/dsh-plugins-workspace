import fs from 'node:fs';
import path from 'node:path';
import { emptyUsage } from './types.ts';
import type { LedgerRow } from './types.ts';

/**
 * dsh 自维护的每日用量账本（`<home>/dsh-usage/usage-ledger.json`）。
 * 已被归档清理的会话只剩这份日聚合，可以用它补齐每日曲线的历史缺口。
 */

interface LedgerFile {
  version?: number;
  days?: Record<
    string,
    Record<string, Record<string, Record<string, unknown>>>
  >;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 读取并展开账本为行列表；文件缺失或损坏返回空数组。 */
export function readUsageLedger(dshHome: string): LedgerRow[] {
  const file = path.join(dshHome, 'dsh-usage', 'usage-ledger.json');
  let parsed: LedgerFile;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerFile;
  } catch {
    return [];
  }
  const rows: LedgerRow[] = [];
  for (const [date, providers] of Object.entries(parsed.days ?? {})) {
    if (typeof providers !== 'object' || providers === null) continue;
    for (const [provider, models] of Object.entries(providers)) {
      if (typeof models !== 'object' || models === null) continue;
      for (const [model, rawUsage] of Object.entries(models)) {
        if (typeof rawUsage !== 'object' || rawUsage === null) continue;
        const usage = emptyUsage();
        usage.inputTokens = num(rawUsage['inputTokens']);
        usage.outputTokens = num(rawUsage['outputTokens']);
        usage.cacheReadTokens = num(rawUsage['cacheReadTokens']);
        usage.cacheWriteTokens = num(rawUsage['cacheWriteTokens']);
        usage.reasoningTokens = num(rawUsage['reasoningTokens']);
        usage.totalTokens =
          usage.inputTokens +
          usage.outputTokens +
          usage.cacheReadTokens +
          usage.cacheWriteTokens;
        usage.calls = num(rawUsage['calls']);
        rows.push({ date, provider, model, usage });
      }
    }
  }
  return rows;
}

/** 账本按日期聚合（跨 provider/model 求和）。 */
export function ledgerDailyTotals(dshHome: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const row of readUsageLedger(dshHome)) {
    totals.set(row.date, (totals.get(row.date) ?? 0) + row.usage.totalTokens);
  }
  return totals;
}
