import { addUsage, emptyUsage } from './types.ts';
import { localDateKey } from './extract.ts';
import type {
  DashboardData,
  DailyPoint,
  ErrorRow,
  LedgerRow,
  ModelRow,
  ProjectRow,
  ProviderRow,
  RecentSessionRow,
  SessionRecord,
  StatsRange,
  TokenUsage,
  ToolRow,
} from './types.ts';

const RANGE_MS: Record<Exclude<StatsRange, 'all'>, number> = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  '90d': 90 * 24 * 60 * 60 * 1000,
};

export const RANGE_KEYS: StatsRange[] = ['7d', '30d', '90d', 'all'];

export function normalizeRange(value: string | undefined | null): StatsRange {
  if (
    value !== undefined &&
    value !== null &&
    (RANGE_KEYS as string[]).includes(value)
  ) {
    return value as StatsRange;
  }
  return '30d';
}

function rangeStart(range: StatsRange, now: number): number | null {
  if (range === 'all') return null;
  return now - RANGE_MS[range];
}

/** 会话的用量 = 其 daily 桶之和（daily 缺失时回退 models 聚合）。 */
export function usageOfSession(session: SessionRecord): TokenUsage {
  const total = emptyUsage();
  for (const usage of Object.values(session.daily)) addUsage(total, usage);
  if (total.calls === 0) {
    for (const usage of Object.values(session.models)) addUsage(total, usage);
  }
  return total;
}

export interface AggregateOptions {
  range?: StatsRange;
  now?: number;
  /** 最近会话列表长度。 */
  recentLimit?: number;
  /** dsh usage-ledger 展开行（用于补齐已归档会话的历史缺口）。 */
  ledgerRows?: LedgerRow[];
}

/** 把会话记录聚合为仪表盘数据集。 */
export function buildDashboard(
  sessions: SessionRecord[],
  options: AggregateOptions = {},
): DashboardData {
  const now = options.now ?? Date.now();
  const range = options.range ?? '30d';
  const from = rangeStart(range, now);
  const recentLimit = options.recentLimit ?? 20;

  const filtered =
    from === null ? sessions : sessions.filter((s) => s.lastActiveAt >= from);

  const overviewUsage = emptyUsage();
  let messages = 0;
  let turns = 0;
  let steps = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let retryCount = 0;
  const models = new Map<
    string,
    { usage: TokenUsage; sessions: Set<string> }
  >();
  const tools = new Map<
    string,
    { calls: number; totalDurationMs: number; errors: number }
  >();
  const projects = new Map<string, ProjectRow>();
  const providers = new Map<string, ProviderRow>();
  const retries = new Map<string, number>();
  const dailySessions = new Map<
    string,
    { usage: TokenUsage; ids: Set<string> }
  >();
  const hourly = new Array<number>(24).fill(0) as number[];

  for (const session of filtered) {
    messages += session.userMessages + session.assistantMessages;
    turns += session.turns;
    steps += session.steps;
    toolCalls += session.toolCalls;
    toolErrors += session.toolErrors;

    for (const [key, usage] of Object.entries(session.models)) {
      const bucket = models.get(key) ?? {
        usage: emptyUsage(),
        sessions: new Set<string>(),
      };
      addUsage(bucket.usage, usage);
      bucket.sessions.add(session.id);
      models.set(key, bucket);
    }
    for (const [name, stat] of Object.entries(session.tools)) {
      const bucket = tools.get(name) ?? {
        calls: 0,
        totalDurationMs: 0,
        errors: 0,
      };
      bucket.calls += stat.calls;
      bucket.totalDurationMs += stat.totalDurationMs;
      bucket.errors += stat.errors;
      tools.set(name, bucket);
    }
    const project =
      projects.get(session.cwd) ??
      ({
        project: session.project,
        cwd: session.cwd,
        sessions: 0,
        usage: emptyUsage(),
        messages: 0,
        lastActiveAt: 0,
      } satisfies ProjectRow);
    project.sessions += 1;
    project.messages += session.userMessages + session.assistantMessages;
    project.lastActiveAt = Math.max(project.lastActiveAt, session.lastActiveAt);
    addUsage(project.usage, usageOfSession(session));
    projects.set(session.cwd, project);

    for (const [key, usage] of Object.entries(session.models)) {
      const provider = key.split('|')[0] ?? 'unknown';
      const bucket = providers.get(provider) ?? { provider, ...emptyUsage() };
      addUsage(bucket, usage);
      providers.set(provider, bucket);
    }
    for (const [code, count] of Object.entries(session.retries)) {
      retries.set(code, (retries.get(code) ?? 0) + count);
      retryCount += count;
    }
    for (const [date, usage] of Object.entries(session.daily)) {
      const bucket = dailySessions.get(date) ?? {
        usage: emptyUsage(),
        ids: new Set<string>(),
      };
      addUsage(bucket.usage, usage);
      bucket.ids.add(session.id);
      dailySessions.set(date, bucket);
    }
    for (let hour = 0; hour < 24; hour++) hourly[hour] += session.hourly[hour];
  }

  // 每日曲线对账：会话文件与 usage-ledger 各自覆盖一部分真实历史
  // （归档会话只剩账本；最近日期账本可能未写）。逐日取两者中较大者，
  // 避免归档缺口导致的低计，也避免双计。范围外的日期一律丢弃。
  const fromDateKey = from === null ? null : localDateKey(from);
  const daily: DailyPoint[] = [];
  for (const [date, bucket] of dailySessions) {
    if (fromDateKey !== null && date < fromDateKey) continue;
    daily.push({
      date,
      ...bucket.usage,
      sessions: bucket.ids.size,
      source: 'sessions',
    });
  }
  const ledgerByDate = new Map<string, TokenUsage>();
  for (const row of options.ledgerRows ?? []) {
    if (fromDateKey !== null && row.date < fromDateKey) continue;
    const bucket = ledgerByDate.get(row.date) ?? emptyUsage();
    addUsage(bucket, row.usage);
    ledgerByDate.set(row.date, bucket);
  }
  for (const [date, ledgerUsage] of ledgerByDate) {
    const existing = daily.find((point) => point.date === date);
    if (!existing) {
      const point = emptyUsage() as DailyPoint;
      point.date = date;
      addUsage(point, ledgerUsage);
      point.sessions = 0;
      point.source = 'ledger';
      daily.push(point);
      continue;
    }
    if (ledgerUsage.totalTokens > existing.totalTokens) {
      const sessions = existing.sessions;
      const replaced = emptyUsage() as DailyPoint;
      replaced.date = date;
      addUsage(replaced, ledgerUsage);
      replaced.sessions = sessions;
      replaced.source = 'ledger';
      daily.splice(daily.indexOf(existing), 1, replaced);
    }
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  // overview 的用量口径与每日曲线保持一致（对账后的总量）。
  for (const point of daily) addUsage(overviewUsage, point);

  const modelRows: ModelRow[] = [...models.entries()]
    .map(([key, value]) => {
      const [provider, model] = key.split('|');
      return {
        provider: provider ?? 'unknown',
        model: model ?? 'unknown',
        ...value.usage,
        sessions: value.sessions.size,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const toolRows: ToolRow[] = [...tools.entries()]
    .map(([name, value]) => ({
      name,
      calls: value.calls,
      totalDurationMs: value.totalDurationMs,
      avgDurationMs:
        value.calls > 0 ? Math.round(value.totalDurationMs / value.calls) : 0,
      errors: value.errors,
    }))
    .sort((a, b) => b.calls - a.calls);

  const projectRows: ProjectRow[] = [...projects.values()].sort(
    (a, b) => b.usage.totalTokens - a.usage.totalTokens,
  );

  const providerRows: ProviderRow[] = [...providers.values()].sort(
    (a, b) => b.totalTokens - a.totalTokens,
  );

  const recent: RecentSessionRow[] = [...filtered]
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, recentLimit)
    .map((session) => ({
      id: session.id,
      title: session.title ?? '(未命名会话)',
      project: session.project,
      model: session.primaryModel?.split('|')[1] ?? 'unknown',
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      activeMs: session.activeMs,
      messages: session.userMessages + session.assistantMessages,
      toolCalls: session.toolCalls,
      usage: usageOfSession(session),
    }));

  const errors: ErrorRow[] = [...retries.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  const activeDays = daily.length;
  const sortedDates = daily.map((point) => point.date);

  return {
    generatedAt: now,
    range,
    rangeFrom: from,
    overview: {
      sessions: filtered.length,
      projects: projects.size,
      messages,
      turns,
      steps,
      toolCalls,
      toolErrors,
      activeDays,
      usage: overviewUsage,
      avgTokensPerActiveDay:
        activeDays > 0 ? Math.round(overviewUsage.totalTokens / activeDays) : 0,
      topModel: modelRows[0]
        ? `${modelRows[0].provider}/${modelRows[0].model}`
        : null,
      topTool: toolRows[0]?.name ?? null,
      firstDay: sortedDates[0] ?? null,
      lastDay: sortedDates[sortedDates.length - 1] ?? null,
      retryCount,
    },
    daily,
    models: modelRows,
    tools: toolRows,
    projects: projectRows,
    providers: providerRows,
    recent,
    errors,
    hourly,
  };
}
