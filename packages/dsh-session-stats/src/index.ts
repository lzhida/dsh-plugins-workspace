/**
 * @lzhida/dsh-session-stats
 * 同步本地 DSH 会话文件并生成 oh-my-pi 风格的用量统计面板。
 */
export {
  scanZstdFrames,
  decodeZstdSessionLog,
  readSessionLines,
  hasZstdSupport,
} from './zstd.ts';
export type { ZstdFrameRange, ZstdFrameScan } from './zstd.ts';
export { discoverSessionFiles, resolveDshHome } from './discover.ts';
export type { SessionFileInfo } from './discover.ts';
export { extractSession, localDateKey } from './extract.ts';
export {
  buildDashboard,
  normalizeRange,
  usageOfSession,
  RANGE_KEYS,
} from './aggregate.ts';
export type { AggregateOptions } from './aggregate.ts';
export { readUsageLedger } from './ledger.ts';
export type { LedgerRow } from './types.ts';
export {
  loadStore,
  saveStore,
  syncSessions,
  scanAllSessions,
  defaultStorePath,
} from './store.ts';
export { startServer, dashboardFromStore } from './server.ts';
export type { ServerOptions } from './server.ts';
export { main } from './cli.ts';
export type {
  DashboardData,
  DashboardOverview,
  DailyPoint,
  ErrorRow,
  ModelRow,
  ProjectRow,
  ProviderRow,
  RecentSessionRow,
  SessionRecord,
  StatsRange,
  StoreFile,
  SyncResult,
  TokenUsage,
  ToolRow,
  ToolStat,
} from './types.ts';
