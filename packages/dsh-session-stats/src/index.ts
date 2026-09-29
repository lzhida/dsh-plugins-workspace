/**
 * @lzhida/dsh-session-stats
 * 同步本地 DSH 会话文件并生成 oh-my-pi 风格的用量统计面板。
 *
 * 本文件同时是 dsh 宿主插件入口(loader 读取 main 并取 name/inject/apply):
 * 把统计 API 挂到 dsh Web 服务的共享 /api 通道,配合客户端插件在右侧栏
 * 提供入口与页面——无需独立端口。
 */
export { name, inject, apply } from './plugin.ts';

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
