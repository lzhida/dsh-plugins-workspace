/**
 * 会话轨迹写入（trajectory transparency）。
 *
 * 官方接口分析结论(对照宿主 0.2.0-rc.2 实际代码):
 * - `agent/request-error` waterfall 的 payload 由 fused dispatcher 注入 `agent`
 *   字段(`@deepseek-ai/dsh-agent` 的 agentEvents:`{ ...payload, agent }`;
 *   官方类型 dsh-agent `runtime-types.d.ts` 的 `'agent/request-error'` 声明
 *   `agent: Agent`),`agent.session` 即 append-only 会话日志(Session);
 * - 官方 `dsh-llm-retry` 插件以此写入 `llm/retry` / `llm/retry-started` 事件
 *   (durable、non-surface:进入持久日志但**不进模型上下文**);
 * - 宿主轨迹 UI(`dsh-client-ui-trajectory`)对 `llm/retry` 有硬编码渲染:
 *   折叠进请求节点的重试状态(错误消息 + code + retry N/maxRetries + delayMs)。
 *
 * 约束(为什么复用官方事件类型而不是自创):
 * - `Session.append(type, data)` 的公开签名**不支持**设置 `ignorable` 标记;
 * - 未知事件类型落盘后,format v4 读侧 admission
 *   (`!knownEventTypes.has(type) && ignorable !== true` → 抛
 *   SessionFormatUnsupportedMigrationError)会**拒绝恢复整个会话日志**;
 * - 因此插件事件必须落在宿主已知词汇表内。`llm/retry`(normal 形态)与
 *   `llm/retry-started` 语义精确吻合跨 provider 回退——"失败后调度一次带退避
 *   的 provider 路由重试",且轨迹 UI 无需任何 client 侧开发即可见。
 * - 「切换到哪个模型」由宿主 loop 自动记录:切换生效后的下一次请求会 append
 *   `request/header`(reason:'change')与 `request/context`(provider/model),
 *   轨迹请求节点的 requestConfig 随之更新,本模块无需重复记录。
 *
 * 失败安全:append 的任何异常都被吞掉并只打日志——写轨迹失败绝不允许阻断
 * 回退本体(监听器抛错会中断 loop 的恢复链)。
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm';

/** 本插件在官方 `llm/retry.policyKey` 空间中的标识(官方 policyKey 为
 * `JSON.stringify([mode, ...])` 形态,裸字符串不会与之冲突)。 */
export const FALLBACK_RETRY_POLICY_KEY = 'llm-fallback';

/** 官方 `llm/retry` 事件的 payload(normal 形态,对齐 dsh-llm-retry 类型)。 */
export interface LlmRetryEventData {
  /** 一次回退链的稳定标识:同 step 链上多次切换复用同一 id。 */
  retryId: string;
  turn: number;
  step: number;
  /** 失败发生的 provider(切换起点,非切换目标)。 */
  provider: string;
  mode: 'normal';
  policyKey: string;
  /** 本次切换的序号(1 起)。 */
  retry: number;
  /** 本 step 最多可切换次数(min(链长-1, maxRetries))。 */
  maxRetries: number;
  /** 实际退避毫秒数。 */
  delayMs: number;
  /** 触发切换的失败(透传,不加工)。 */
  failure: LlmFailure;
}

/** 官方 `llm/retry-started` 事件的 payload:退避完成、切换即将生效。 */
export interface LlmRetryStartedEventData {
  retryId: string;
  turn: number;
  step: number;
  retry: number;
}

/**
 * 本插件用到的 `agent.session` 最小结构面。
 * 运行时即 `@deepseek-ai/dsh-session` 的 Session(append-only 日志);
 * 只声明两个 append 重载,避免把整个 Session 类型拖进插件类型面。
 */
export interface TrajectorySession {
  append(type: 'llm/retry', data: LlmRetryEventData): unknown;
  append(type: 'llm/retry-started', data: LlmRetryStartedEventData): unknown;
}

/** `agent/request-error` payload 上 `agent` 字段的最小结构面。 */
export interface TrajectoryAgent {
  session: TrajectorySession;
}

/**
 * 本 step 的有效最大切换次数:链长上限与用户 maxRetries 上限取小者。
 * 链长 1(无备选)时为 0;防御非法负值。
 */
export function effectiveMaxSwitches(
  chainLength: number,
  maxRetries: number,
): number {
  if (!Number.isFinite(chainLength) || chainLength < 1) return 0;
  if (!Number.isFinite(maxRetries) || maxRetries < 0) return 0;
  return Math.min(Math.floor(maxRetries), Math.floor(chainLength) - 1);
}

/**
 * 记录"一次跨 provider 回退已调度"(官方 `llm/retry` 事件,normal 形态)。
 * 在退避等待**之前**写入——durable 先于 cancellable wait,与官方 retry 一致。
 * session 缺失(旧宿主未注入 agent)或 append 抛错时静默降级为仅打日志。
 */
export function recordFallbackScheduled(
  session: TrajectorySession | undefined,
  data: LlmRetryEventData,
): void {
  if (!session) return;
  try {
    session.append('llm/retry', data);
  } catch (error) {
    console.error(
      '[dsh-llm-fallback] failed to append llm/retry trajectory event:',
      error,
    );
  }
}

/**
 * 记录"退避完成、回退即将生效"(官方 `llm/retry-started` 事件)。
 * 在退避等待成功之后、返回 `{kind:'retry'}` 之前写入;被 abort 时不调用。
 */
export function recordFallbackStarted(
  session: TrajectorySession | undefined,
  data: LlmRetryStartedEventData,
): void {
  if (!session) return;
  try {
    session.append('llm/retry-started', data);
  } catch (error) {
    console.error(
      '[dsh-llm-fallback] failed to append llm/retry-started trajectory event:',
      error,
    );
  }
}
