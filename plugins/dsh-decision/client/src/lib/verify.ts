/**
 * 验证状态机纯函数（决策工具系列 6/11）。
 *
 * 卡内验收项要求「验证按钮的成功与失败两态渲染」可测——这里把状态迁移
 * 抽成纯函数（单测覆盖 idle → verifying → ok / fail / route-missing 全路径
 * 与 reason 映射），组件只消费状态渲染，不藏逻辑。
 *
 * @module dsh-decision/client/lib/verify
 */

/** 验证接口响应（host 半区 verify-route 的载荷，无敏感字段）。 */
export interface VerifyResponse {
  ok?: unknown;
  model?: unknown;
  latencyMs?: unknown;
  reason?: unknown;
}

/** 验证状态（渲染层直接消费）。 */
export type VerifyStatus =
  | { phase: 'idle' }
  | { phase: 'verifying' }
  | {
      phase: 'ok';
      model: string | null;
      latencyMs: number;
    }
  | {
      phase: 'fail';
      reason: string;
      /** true = 宿主路由未注册（404），提示重载；false = 端点侧失败。 */
      routeMissing: boolean;
    };

export const INITIAL_VERIFY_STATUS: VerifyStatus = { phase: 'idle' };

/** 迁移：点击按钮 → verifying。 */
export function startVerify(): VerifyStatus {
  return { phase: 'verifying' };
}

/**
 * 迁移：响应到达 → ok / fail。
 * - ok 需要 `response.ok === true`；latency 只认有限非负数（非法回 0）；
 * - 失败 reason 截断到 300 字符；HTTP 404 / 非 JSON 视为「路由缺失」。
 */
export function applyVerifyResponse(response: VerifyResponse): VerifyStatus {
  if (response.ok === true) {
    const latency =
      typeof response.latencyMs === 'number' &&
      Number.isFinite(response.latencyMs) &&
      response.latencyMs >= 0
        ? response.latencyMs
        : 0;
    return {
      phase: 'ok',
      model: typeof response.model === 'string' ? response.model : null,
      latencyMs: latency,
    };
  }
  const rawReason =
    typeof response.reason === 'string' && response.reason.length > 0
      ? response.reason
      : 'model-verify-failed: 验证未通过';
  return {
    phase: 'fail',
    reason: rawReason.length > 300 ? `${rawReason.slice(0, 300)}…` : rawReason,
    routeMissing: false,
  };
}

/** 迁移：请求本身失败（网络/非 2xx/路由缺失）。 */
export function applyVerifyFailure(error: unknown): VerifyStatus {
  const message = error instanceof Error ? error.message : String(error);
  const routeMissing =
    message.includes('404') || message.includes('Failed to fetch');
  return {
    phase: 'fail',
    reason: routeMissing
      ? 'verify.route-missing'
      : message.length > 300
        ? `${message.slice(0, 300)}…`
        : message,
    routeMissing,
  };
}

/** 同源验证请求（POST JSON；apiKey 仅在本机同源链路上传输，不进日志）。 */
export async function requestVerify(
  path: string,
  body: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    timeoutMs?: number;
  },
): Promise<VerifyResponse> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`verify route returned ${response.status}`);
  }
  try {
    return (await response.json()) as VerifyResponse;
  } catch {
    throw new Error(`verify route returned invalid JSON (${response.status})`);
  }
}
