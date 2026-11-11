/**
 * standalone 工具结果文本渲染：JSON → ContentBlock[]。
 * 图像结果（{data,mimeType} 形态）由 image.ts 在渲染之前分流落盘，
 * 本模块只负责文本渲染与截断。
 */
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm/types';

/** JSON 文本渲染最大字符数（超出截断，防上下文爆炸）。 */
export const RENDER_MAX_CHARS = 6000;

/**
 * backend_logs 载荷摘要化时保留的最大条数。
 * invoke_command {with_logs:true} 与 logs {action:"backend"} 返回的
 * backend_logs 可能达数千条；完整列表可经 since_seq 分页重取，
 * 渲染层只保留头部样本 + 显式带出游标类标量键（backend_log_cursor /
 * next_seq / backend_logs_hint）——丢失游标会让三段式第②步
 * （wait_for condition=log since_seq）无从下手。
 */
export const BACKEND_LOG_PREVIEW_COUNT = 5;

/** 识别 with_logs 类返回体：含 backend_logs 数组的顶层对象。 */
function isBackendLogsPayload(
  value: unknown,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  return Array.isArray((value as Record<string, unknown>).backend_logs);
}

/**
 * 摘要化超长 backend_logs 载荷：非 backend_logs 的键（游标/提示等短标量）
 * 重排到前面原样保留，backend_logs 只留前 BACKEND_LOG_PREVIEW_COUNT 条
 * 并追加一条摘要说明。短载荷（≤ 预览条数）原样返回不重排。
 */
export function summarizeBackendLogsPayload(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const logs = value.backend_logs as unknown[];
  if (logs.length <= BACKEND_LOG_PREVIEW_COUNT) return value;
  const rest: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (key !== 'backend_logs') rest[key] = val;
  }
  return {
    ...rest,
    backend_logs: [
      ...logs.slice(0, BACKEND_LOG_PREVIEW_COUNT),
      `(backend_logs 已摘要化:共 ${logs.length} 条,仅保留前 ${BACKEND_LOG_PREVIEW_COUNT} 条;其余经 victauri_logs {action:"backend", since_seq} 分页取回)`,
    ],
  };
}

/** 通用 JSON 结果渲染：pretty-print + 截断。 */
export function renderJson(value: unknown): ContentBlock[] {
  let text: string;
  try {
    if (isBackendLogsPayload(value)) {
      value = summarizeBackendLogsPayload(value);
    }
    text = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    text = String(value);
  }
  if (text.length > RENDER_MAX_CHARS) {
    text = `${text.slice(0, RENDER_MAX_CHARS)}\n…(截断,共 ${text.length} 字符)`;
  }
  const block: TextBlock = { type: 'text', text };
  return [block];
}
