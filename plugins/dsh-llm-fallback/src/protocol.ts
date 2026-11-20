/**
 * dsh-llm-fallback system-prompt section。
 *
 * 给 agent 看的协议说明:
 * - 何时会触发回退(可识别失败码 RATE_LIMIT / QUOTA / CONTEXT_WINDOW_EXCEEDED /
 *   UNSUPPORTED_REASONING_EFFORT 等);
 * - 回退是 loop-level 的:同 step 内失败 → 预算耗尽后切下一候选;agent 不会察觉;
 * - 同候选重试预算固定跟随官方 dsh-llm-retry(provider retryPolicy 的 maxRetries,
 *   宿主默认 5),预算耗尽后才切换(0.6.0 起,插件不再提供自定义重试次数);
 * - 如果所有候选都失败,用户会看到错误信息(代码级契约,与 prompt 无关);
 * - 模型不应主动配置 fallback(由用户在 settings 里设置)。
 *
 * order=2970(PLUGIN 类档位,与宿主 taskboard 2950 等 section 同档)。
 * 文本不含 `{{var}}`,适配 dsh 0.2.0-rc.2 renderPrompt 严格校验。
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

/** section 名(全局唯一;dsh 0.2.0 重复注册会抛,故用包名空间)。 */
export const PROTOCOL_SECTION_NAME = 'tool:llm-fallback';

/** section order:PLUGIN 类档位(2970)。 */
export const PROTOCOL_SECTION_ORDER = 2970;

const MODEL_FALLBACK_PROTOCOL_TEXT = `A host-level plugin (\`dsh-llm-fallback\`) wraps every model call in a configured fallback chain. When the current provider/model keeps failing, the next candidate is tried automatically before the error surfaces to you.

## What this means for you

- **You do not need to handle transient model failures.** RATE_LIMIT, QUOTA, ACCOUNT_QUOTA, CONTEXT_WINDOW_EXCEEDED, EMPTY_RESPONSE, SERVER, TIMEOUT, TRANSPORT (connection failures such as "Connection error."), UNSUPPORTED_REASONING_EFFORT (the current model cannot run the requested reasoning effort) — all of these are recovered within the same turn by switching to the next configured model. Treat them as if they did not happen.
- **You do not pick the model.** The model selected in the session UI is the primary; the user additionally configures a pure fallback candidate list at the host level. You do not call any tool to switch models, and there is no tool exposed by this plugin.
- **Same-provider retries come first; cross-provider fallback is the second line of defense.** Same-candidate retries always run under the provider's own retry budget — the host's built-in retry executor (\`dsh-llm-retry\`, policy \`maxRetries\`, default 5). The plugin does not add or subtract retries: while the official budget lasts, its decisions pass through unchanged, and only after the budget is exhausted does the chain switch to the next candidate.
- **If every model in the chain fails**, the error reaches the loop normally. Report it to the user as you would any other terminal error — the chain has been exhausted; there is nothing more to retry.
- **Failure codes that are NOT in the whitelist** (for example INVALID_CREDENTIAL, INVALID_ARGS) bypass the chain and surface immediately. Those are user/configuration problems, not transient outages.

## What you should NOT do

- Do not invent model-switching mechanisms. The chain is configured at the host level.
- Do not retry "by hand" on a fallback error — the host already did, or will. Repeated retries on the same call waste budget.
- Do not mention the fallback chain in user-facing replies unless the user explicitly asks. It is an implementation detail of resilience, not a feature to be advertised.

## Limits

- Within one step (turn+step), fallback is bounded by \`maxRetries\` (default = queue length; this bounds candidate switches, not same-candidate retries — the same-candidate retry budget is the provider retry policy itself). Once every candidate has been tried, the error surfaces; the next step starts from the session-selected model again.
- **Recently failed models enter a short cooldown.** After a model (the session-selected primary or a chain candidate) has exhausted its retry budget and the chain switched away, subsequent failure-driven scans skip it for a configurable window (default 5 minutes) and prefer another healthy candidate instead of re-paying the same failure. When the cooldown expires with the breaker enabled, the model enters a configurable stabilization period (default 10 minutes): it remains available as a half-open probe but ranks below other healthy candidates; if no alternative is available, it can still be tried. A failure during this period escalates the cooldown exponentially (\`cooldownMs × 2^N\`, capped at the greater of the independent \`cooldownBreakerCapMs\` (default 30 minutes) and the fixed base \`cooldownMs\`); an uninterrupted period resets its priority, and it is re-verified on the next request. Recovery is time-based because the host does not expose per-model success events. When quota extension is enabled with a positive quota tier, recognized usage exhaustion uses a reported reset time when present, otherwise a longer quota tier (default 5 hours) capped at 7 days. If that quota tier is disabled, even quota-like failures can fall through to retry-after, breaker, or fixed cooldown. For other failures, a reported \`providerRetryAfterMs\` aligns the wait to the provider's \`retry-after\`; otherwise repeated failures may trigger breaker escalation, with ordinary failures retaining the fixed 5-minute window. Cooldown is an efficiency optimization only: if every candidate is cooling, the chain falls back to its normal order rather than giving up.
- The plugin never modifies the request contents, only the \`provider\` and \`model\` fields. Token budgets, tools, and prompts are preserved across the fallback.
- A stream that fails after it has already produced content is handled like any other failure: the host reports it through the same failure event, so the chain may switch to the next candidate. The host rebuilds the retry request from scratch, which means the interrupted partial answer never enters the model's context — treat the switch as a clean restart rather than a continuation of the partial text.
- Backoff between attempts is exponential (base × 2^attempt, capped at \`maxDelayMs\`) with ±10% jitter.
- Every fallback switch is recorded to the session trajectory as durable \`llm/retry\` events, so the user can see the failure and the retry progress in the UI. The new provider/model shows up in the next request's recorded config on its own.

## Configuration

The user configures the fallback candidates in the host's settings UI (Settings → Plugins → dsh-llm-fallback). The settings panel shows available models from the user's configured providers as a checkbox list; the user picks which ones to include and drags to reorder — that order is the fallback sequence (the session-selected primary is not part of that list). Leave that UI to the user; do not invent your own model list.
`;

/** 构造 PromptSection(供 ctx.systemPrompt.section() 注册)。 */
export function modelFallbackSection(): PromptSection {
  return {
    name: PROTOCOL_SECTION_NAME,
    order: PROTOCOL_SECTION_ORDER,
    text: MODEL_FALLBACK_PROTOCOL_TEXT,
  };
}
