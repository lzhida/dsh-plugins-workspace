// ── 切换可观测性(0.9.0)───────────────────────────────────────────
// 三个数据面,全部只描述「本插件自己看到的活动」,不读取会话内容:
// 1. usage     —— 按天 × 候选的活动计数(尝试/失败/冷却标记/切换),
//                 进程内存累加,失败/切换等事件触发 + 卸载兜底,节流
//                 (5s debounce)原子落盘到 DSH_HOME 下的 JSON 文件,
//                 宿主重启后 load 恢复(损坏时回落空表)。
// 2. recent    —— 最近切换事件环形缓冲(仅内存,重启清零)。
// 3. incidents —— 「旧装配守卫」告警计数(仅内存):切换经 model.select
//                 持久化后,下一个新 step 的 selection 应等于切换目标;
//                 不一致说明 selection 未生效(配置被外部改写等),
//                 面板可见、控制台告警,不干预请求。
// 统计数据仅本机(落盘也在 DSH_HOME),无外发。

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

/** 单候选单日的活动计数。 */
export interface CandidateUsage {
  /** 本插件在 agent/request 观察到的请求次数(seed 路由口径)。 */
  attempts: number;
  /** 白名单内失败次数(agent/request-error,重试判定通过)。 */
  failures: number;
  /** 记冷却次数(失败冷却标记;时间窗预填不计入此项)。 */
  cooldownMarks: number;
  /** 切换次数(切换提交、退避未被 abort 的路径)。 */
  switches: number;
}

/** 一天内的按候选计数,key = 'provider/model'。 */
export type DayUsage = Record<string, CandidateUsage>;

/** 持久化形态(带版本号,向前兼容只加字段)。 */
export interface UsageStats {
  version: 1;
  /** key = 本地日期 'YYYY-MM-DD'。 */
  days: Record<string, DayUsage>;
}

/** 最近切换事件(环形缓冲条目,仅内存)。 */
export interface SwitchEvent {
  /** epoch ms。 */
  at: number;
  /** 切换来源路由('provider/model';会话指定模型同样用其路由表示)。 */
  from: string;
  /** 切换目标路由。 */
  to: string;
  /** 触发切换的失败码。 */
  reason: string;
  /** 会话 id(缺 agent 的 payload 无此字段)。 */
  sessionId?: string;
}

/** GET /dsh-llm-fallback/status 的返回体(客户端面板数据契约)。 */
export interface UsageSnapshot {
  /** 快照对应的服务端本地日期。 */
  day: string;
  /** 今日全候选合计。 */
  totals: CandidateUsage;
  /** 今日按候选明细(按 switches+failures 降序,零活动候选不出现)。 */
  candidates: Array<{ route: string } & CandidateUsage>;
  /** 最近切换事件(新的在前,最多 MAX_RECENT 条,进程内存)。 */
  recent: SwitchEvent[];
  /** 旧装配守卫告警累计(进程内存,重启清零)。 */
  incidents: number;
}

/** recent 环形缓冲容量。 */
export const MAX_RECENT = 20;
/** 落盘保留天数(更早的日期在 prune 时删除)。 */
export const KEEP_DAYS = 14;

/** 本地时区日期键('YYYY-MM-DD')。 */
export function dayKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 空表。 */
export function emptyUsage(): UsageStats {
  return { version: 1, days: {} };
}

/** 取出(或惰性创建)某天某候选的计数桶;形态异常的旧桶重置为零值。 */
function bucket(
  stats: UsageStats,
  dayKey: string,
  route: string,
): CandidateUsage {
  let day = stats.days[dayKey];
  if (day === undefined || typeof day !== 'object' || day === null) {
    day = {};
    stats.days[dayKey] = day;
  }
  const stored: unknown = day[route];
  let cell: Partial<CandidateUsage> | undefined =
    stored !== null && typeof stored === 'object'
      ? (stored as Partial<CandidateUsage>)
      : undefined;
  if (
    cell === undefined ||
    typeof cell.attempts !== 'number' ||
    typeof cell.failures !== 'number' ||
    typeof cell.cooldownMarks !== 'number' ||
    typeof cell.switches !== 'number'
  ) {
    cell = { attempts: 0, failures: 0, cooldownMarks: 0, switches: 0 };
    day[route] = cell as CandidateUsage;
  }
  return cell as CandidateUsage;
}

/** 计数 +1 的四个入口(内存累加,不触发落盘——节流在 index.ts)。 */
export function bumpAttempt(
  stats: UsageStats,
  dayKey: string,
  route: string,
): void {
  bucket(stats, dayKey, route).attempts += 1;
}

export function bumpFailure(
  stats: UsageStats,
  dayKey: string,
  route: string,
): void {
  bucket(stats, dayKey, route).failures += 1;
}

export function bumpCooldownMark(
  stats: UsageStats,
  dayKey: string,
  route: string,
): void {
  bucket(stats, dayKey, route).cooldownMarks += 1;
}

export function bumpSwitch(
  stats: UsageStats,
  dayKey: string,
  route: string,
): void {
  bucket(stats, dayKey, route).switches += 1;
}

/** 删除超过保留窗口的日期;返回是否删了东西(调用方据此决定是否落盘)。
 * YYYY-MM-DD 字典序即时间序,窗口起点按本地日历回退 keepDays 天。 */
export function pruneUsage(
  stats: UsageStats,
  todayKey: string,
  keepDays: number = KEEP_DAYS,
): boolean {
  const parts = todayKey.split('-');
  if (parts.length !== 3) return false;
  const [y, m, d] = parts.map(Number);
  if (
    y === undefined ||
    m === undefined ||
    d === undefined ||
    !Number.isFinite(y) ||
    !Number.isFinite(m) ||
    !Number.isFinite(d)
  ) {
    return false;
  }
  const cutoff = new Date(y, m - 1, d - (keepDays - 1));
  if (Number.isNaN(cutoff.getTime())) return false;
  const cutoffKey = dayKeyOf(cutoff);
  let changed = false;
  for (const key of Object.keys(stats.days)) {
    // 非 YYYY-MM-DD 的键不认识,不参与窗口判定(也不删)。
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (key < cutoffKey) {
      delete stats.days[key];
      changed = true;
    }
  }
  return changed;
}

/** 从磁盘读统计;任何损坏(缺文件/坏 JSON/形态不对)回落空表,绝不抛。
 * 命中的 day cell 逐个过 bucket() 修复(手改文件出现的坏字段归零,
 * 避免 /status 汇总出 NaN)。 */
export function loadUsageFile(file: string): UsageStats {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { days?: unknown }).days !== 'object' ||
      (parsed as { days?: unknown }).days === null
    ) {
      return emptyUsage();
    }
    const stats = parsed as UsageStats;
    for (const [dayKey, day] of Object.entries(stats.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || typeof day !== 'object') {
        continue;
      }
      for (const route of Object.keys(day)) {
        bucket(stats, dayKey, route);
      }
    }
    return stats;
  } catch {
    return emptyUsage();
  }
}

/** 原子落盘:mkdir → 随机 temp → writeFile → fsync → rename。失败向上抛,
 * 调用方(index.ts)吞掉并打日志——统计丢一拍不阻断回退本体;失败路径
 * 清理残留 temp 文件。 */
export function persistUsageFile(file: string, stats: UsageStats): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const fh = openSync(temp, 'w');
  try {
    writeSync(fh, JSON.stringify(stats));
    fsyncSync(fh);
    closeSync(fh);
    renameSync(temp, file);
  } catch (err) {
    try {
      closeSync(fh);
    } catch {
      // 已经关过(或关失败)都不影响清理与上抛。
    }
    try {
      unlinkSync(temp);
    } catch {
      // 清理失败也只影响 temp 残留,不掩盖原始错误。
    }
    throw err;
  }
}

/** 组装面板快照(纯函数;sessions/cooldowns 视图由 index.ts 追加)。 */
export function buildUsageSnapshot(
  stats: UsageStats,
  todayKey: string,
  recent: ReadonlyArray<SwitchEvent>,
  incidents: number,
): UsageSnapshot {
  const day = stats.days[todayKey] ?? {};
  const candidates = Object.entries(day)
    .map(([route, cell]) => ({ route, ...cell }))
    .sort((a, b) => b.switches + b.failures - (a.switches + a.failures));
  const totals: CandidateUsage = candidates.reduce(
    (acc, cell) => ({
      attempts: acc.attempts + cell.attempts,
      failures: acc.failures + cell.failures,
      cooldownMarks: acc.cooldownMarks + cell.cooldownMarks,
      switches: acc.switches + cell.switches,
    }),
    { attempts: 0, failures: 0, cooldownMarks: 0, switches: 0 },
  );
  return {
    day: todayKey,
    totals,
    candidates,
    recent: recent.slice(0, MAX_RECENT),
    incidents,
  };
}
