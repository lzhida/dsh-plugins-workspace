/** 会话统计共享类型。 */

/** 归一化的 Token 用量（单位：token；calls 为 LLM 响应次数）。 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** input + output + cacheRead + cacheWrite 的 API 等价总量。 */
  totalTokens: number;
  calls: number;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    calls: 0,
  };
}

export function addUsage(
  target: TokenUsage,
  source: Partial<TokenUsage>,
): void {
  target.inputTokens += source.inputTokens ?? 0;
  target.outputTokens += source.outputTokens ?? 0;
  target.cacheReadTokens += source.cacheReadTokens ?? 0;
  target.cacheWriteTokens += source.cacheWriteTokens ?? 0;
  target.reasoningTokens += source.reasoningTokens ?? 0;
  target.totalTokens += source.totalTokens ?? 0;
  target.calls += source.calls ?? 0;
}

/** 单个工具的调用聚合。 */
export interface ToolStat {
  calls: number;
  totalDurationMs: number;
  errors: number;
}

/** 从一个会话文件提取出的完整统计记录。 */
export interface SessionRecord {
  /** 会话 id（session-<uuid>）。 */
  id: string;
  /** 项目短名（cwd 的 basename）。 */
  project: string;
  /** 会话工作目录。 */
  cwd: string;
  /** LLM/回退生成的标题；可能为 null。 */
  title: string | null;
  /** agent 预设（如 standard）。 */
  agentPreset: string | null;
  createdAt: number;
  /** 最后一条事件时间。 */
  lastActiveAt: number;
  /** lastActiveAt - createdAt 的墙钟跨度。 */
  activeMs: number;
  turns: number;
  steps: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  /** 显式失败的工具结果数（isError 或异常结构）。 */
  toolErrors: number;
  /** 工具名 -> 聚合。 */
  tools: Record<string, ToolStat>;
  /** "provider|model" -> 聚合。 */
  models: Record<string, TokenUsage>;
  /** 按 calls 数排序的主要模型 key。 */
  primaryModel: string | null;
  /** 本地日期 yyyy-MM-dd -> 用量。 */
  daily: Record<string, TokenUsage>;
  /** 本地小时 0-23 的 LLM 调用分布。 */
  hourly: number[];
  /** llm/retry 失败码 -> 次数。 */
  retries: Record<string, number>;
  /** 来源文件绝对路径。 */
  sourceFile: string;
  fileBytes: number;
  fileMtimeMs: number;
}

/** dsh 自维护的每日用量账本（usage-ledger.json）的一行展开。 */
export interface LedgerRow {
  date: string;
  provider: string;
  model: string;
  usage: TokenUsage;
}

export interface StoreFile {
  version: 1;
  syncedAt: number;
  /** 源文件绝对路径 -> 会话记录。 */
  sessions: Record<string, SessionRecord>;
}

export interface SyncResult {
  /** 发现的会话文件总数。 */
  files: number;
  /** 本次实际重新解码的文件数。 */
  processed: number;
  /** 同步后的会话记录总数。 */
  sessions: number;
  /** 全部会话的 user+assistant 消息总数。 */
  totalMessages: number;
  durationMs: number;
}

export type StatsRange = '7d' | '30d' | '90d' | 'all';

export interface DailyPoint extends TokenUsage {
  date: string;
  /** 当日活跃会话数（仅会话来源可精确统计）。 */
  sessions: number;
  /** 数据来源：sessions=会话文件；ledger=归档账本补齐。 */
  source: 'sessions' | 'ledger';
}

export interface ModelRow extends TokenUsage {
  provider: string;
  model: string;
  sessions: number;
}

export interface ToolRow {
  name: string;
  calls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  errors: number;
}

export interface ProjectRow {
  project: string;
  cwd: string;
  sessions: number;
  usage: TokenUsage;
  messages: number;
  lastActiveAt: number;
}

export interface ProviderRow extends TokenUsage {
  provider: string;
}

export interface RecentSessionRow {
  id: string;
  title: string;
  project: string;
  model: string;
  createdAt: number;
  lastActiveAt: number;
  activeMs: number;
  messages: number;
  toolCalls: number;
  usage: TokenUsage;
}

export interface ErrorRow {
  code: string;
  count: number;
}

export interface DashboardOverview {
  sessions: number;
  projects: number;
  messages: number;
  turns: number;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  activeDays: number;
  usage: TokenUsage;
  avgTokensPerActiveDay: number;
  topModel: string | null;
  topTool: string | null;
  firstDay: string | null;
  lastDay: string | null;
  retryCount: number;
}

export interface DashboardData {
  generatedAt: number;
  range: StatsRange;
  rangeFrom: number | null;
  overview: DashboardOverview;
  daily: DailyPoint[];
  models: ModelRow[];
  tools: ToolRow[];
  projects: ProjectRow[];
  providers: ProviderRow[];
  recent: RecentSessionRow[];
  errors: ErrorRow[];
  hourly: number[];
}
