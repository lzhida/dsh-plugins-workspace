/**
 * per-tool 请求预算（批二 2/4）：REST 通道按工具声明/动态计算覆盖全局超时。
 *
 * 优先级语义（高 → 低，由本函数定义并单测锁定）：
 * 1. wait_for 动态预算：`timeout_ms` 参数 + 5s 余量（长轮询不被 30s 全局超时掐断）；
 * 2. 工具 spec 声明 `requestBudgetMs`（trace / introspect 长操作显式预算）；
 * 3. 客户端配置 `requestTimeoutMs`（构造时注入 client.timeoutMs）；
 * 4. 内置默认 DEFAULT_TIMEOUT_MS = 30s。
 *
 * 工具来源的预算（前两档）一律夹到 `TOOL_BUDGET_MAX_MS`（120s）以内——
 * 预算过大时用户会感知为卡顿，故设硬上限并文档化。
 * 返回 undefined = 无工具级覆盖，请求层沿用客户端自身超时（3/4 档）。
 */
import type { JsonValue } from '../../json.ts';

/** 工具来源预算的硬上限：超过夹到该值（防用户感知长卡顿）。 */
export const TOOL_BUDGET_MAX_MS = 120_000;

/** wait_for 动态预算在 timeout_ms 之上追加的余量（覆盖网络与轮询间隔开销）。 */
export const WAIT_FOR_BUDGET_MARGIN_MS = 5_000;

/**
 * 解析一次 callTool 的请求预算。
 *
 * @param toolName - victauri 工具名（spec.name）。
 * @param args - 归一后的调用参数（别名已归一、undefined 已过滤）。
 * @param declaredBudgetMs - 工具 spec 声明的预算（RestToolSpec.requestBudgetMs）。
 * @returns 生效预算毫秒；undefined = 无工具级覆盖（沿用客户端默认链）。
 */
export function resolveRequestBudgetMs(
  toolName: string,
  args: Record<string, JsonValue>,
  declaredBudgetMs?: number,
): number | undefined {
  // 1) wait_for 动态预算：timeout_ms 参数 + 余量，夹上限
  if (toolName === 'wait_for') {
    const raw = args['timeout_ms'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      return Math.min(raw + WAIT_FOR_BUDGET_MARGIN_MS, TOOL_BUDGET_MAX_MS);
    }
  }
  // 2) spec 静态声明（trace / introspect 等），夹上限；非法声明忽略
  if (
    typeof declaredBudgetMs === 'number' &&
    Number.isFinite(declaredBudgetMs) &&
    declaredBudgetMs > 0
  ) {
    return Math.min(declaredBudgetMs, TOOL_BUDGET_MAX_MS);
  }
  // 3/4) 无工具级覆盖：请求层沿用 client.timeoutMs（配置或 30s 默认）
  return undefined;
}
