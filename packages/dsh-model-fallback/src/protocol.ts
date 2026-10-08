/**
 * dsh-model-fallback system-prompt section。
 *
 * 给 agent 看的协议说明:
 * - 何时会触发回退(可识别失败码 RATE_LIMIT / QUOTA / CONTEXT_WINDOW_EXCEEDED 等);
 * - 回退是 loop-level 的:同 step 内一次失败 → 切下一候选;agent 不会察觉;
 * - 如果所有候选都失败,用户会看到错误信息(代码级契约,与 prompt 无关);
 * - 模型不应主动配置 fallback(由用户在 settings 里设置)。
 *
 * order=2970(排在 dsh-obsidian 2960 之后,与 taskboard 2950 同档 PLUGIN 类)。
 * 文本不含 `{{var}}`,适配 dsh 0.2.0-rc.2 renderPrompt 严格校验。
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

/** section 名(全局唯一;dsh 0.2.0 重复注册会抛,故用包名空间)。 */
export const PROTOCOL_SECTION_NAME = 'tool:model-fallback';

/** section order:PLUGIN 类,排在 dsh-obsidian(2960)之后。 */
export const PROTOCOL_SECTION_ORDER = 2970;

const MODEL_FALLBACK_PROTOCOL_TEXT = `A host-level plugin (\`dsh-model-fallback\`) wraps every model call in a configured fallback chain. When the current provider/model returns a recognized failure code, the next candidate is tried automatically before the error surfaces to you.

## What this means for you

- **You do not need to handle transient model failures.** RATE_LIMIT, QUOTA, ACCOUNT_QUOTA, CONTEXT_WINDOW_EXCEEDED, EMPTY_RESPONSE, SERVER_ERROR, TIMEOUT, NETWORK — all of these will be retried on the next configured model within the same turn. Treat them as if they did not happen.
- **You do not pick the model.** The user configures the chain (one primary, then N fallbacks). You do not call any tool to switch models, and there is no tool exposed by this plugin.
- **If every model in the chain fails**, the error reaches the loop normally. Report it to the user as you would any other terminal error — the chain has been exhausted; there is nothing more to retry.
- **Failure codes that are NOT in the whitelist** (for example INVALID_CREDENTIAL, INVALID_ARGS) bypass the chain and surface immediately. Those are user/configuration problems, not transient outages.

## What you should NOT do

- Do not invent model-switching mechanisms. The chain is configured at the host level.
- Do not retry "by hand" on a fallback error — the plugin already did, or will. Repeated retries on the same call waste budget.
- Do not mention the fallback chain in user-facing replies unless the user explicitly asks. It is an implementation detail of resilience, not a feature to be advertised.

## Limits

- Within one step (turn+step), fallback is bounded by \`maxRetries\` (default = chain length). Once the chain is exhausted, the error surfaces.
- The plugin never modifies the request contents, only the \`provider\` and \`model\` fields. Token budgets, tools, and prompts are preserved across the fallback.
- Backoff between attempts is exponential (base × 2^attempt, capped at \`maxDelayMs\`) with ±10% jitter.
`;

/** 构造 PromptSection(供 ctx.systemPrompt.section() 注册)。 */
export function modelFallbackSection(): PromptSection {
  return {
    name: PROTOCOL_SECTION_NAME,
    order: PROTOCOL_SECTION_ORDER,
    text: MODEL_FALLBACK_PROTOCOL_TEXT,
  };
}
