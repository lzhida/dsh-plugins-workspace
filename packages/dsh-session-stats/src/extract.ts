import path from 'node:path';
import { addUsage, emptyUsage } from './types.ts';
import type { SessionRecord, TokenUsage, ToolStat } from './types.ts';

/** 会话事件的最小公共结构（多余字段忽略）。 */
export interface SessionEvent {
  type?: string;
  time?: number;
  seq?: number;
  data?: unknown;
}

/** 会话头事件。 */
interface SessionHeaderData {
  id?: string;
  createdAt?: number;
  cwd?: string;
  agentPreset?: string;
}

/** request/header 与 request/context 共同的路由信息。 */
interface RouteInfo {
  provider?: string;
  model?: string;
}

interface AssistantMessageData {
  usage?: Record<string, unknown>;
}

interface ToolCallData {
  callId?: string;
  name?: string;
}

interface ToolResultData {
  callId?: string;
  isError?: boolean;
  message?: { source?: { callId?: string }; toolCallId?: string };
}

interface RetryData {
  failure?: { code?: string; message?: string };
}

/** 本地时区的 yyyy-MM-dd 日期键。 */
export function localDateKey(ms: number): string {
  const d = new Date(ms);
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 把 LLM 返回的 usage 对象归一化；calls 由调用方决定。 */
function normalizeUsage(
  raw: Record<string, unknown> | undefined,
  calls: number,
): TokenUsage {
  const usage = emptyUsage();
  if (!raw) return usage;
  usage.inputTokens = asNumber(raw['inputTokens']);
  usage.outputTokens = asNumber(raw['outputTokens']);
  usage.cacheReadTokens = asNumber(raw['cacheReadTokens']);
  usage.cacheWriteTokens = asNumber(raw['cacheWriteTokens']);
  usage.reasoningTokens = asNumber(raw['reasoningTokens']);
  usage.totalTokens =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens;
  usage.calls = calls;
  return usage;
}

function readRoute(data: unknown): RouteInfo | null {
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  // request/context: { provider, model }；request/header: { header: { config: { provider, model } } }
  const direct = record as RouteInfo;
  if (typeof direct.provider === 'string' && typeof direct.model === 'string') {
    return { provider: direct.provider, model: direct.model };
  }
  const header = record['header'] as Record<string, unknown> | undefined;
  const config = header?.['config'] as RouteInfo | undefined;
  if (
    config &&
    typeof config.provider === 'string' &&
    typeof config.model === 'string'
  ) {
    return { provider: config.provider, model: config.model };
  }
  return null;
}

function modelKey(route: RouteInfo | null): string {
  const provider = route?.provider ?? 'unknown';
  const model = route?.model ?? 'unknown';
  return `${provider}|${model}`;
}

function ensureTool(tools: Record<string, ToolStat>, name: string): ToolStat {
  let stat = tools[name];
  if (!stat) {
    stat = { calls: 0, totalDurationMs: 0, errors: 0 };
    tools[name] = stat;
  }
  return stat;
}

function toolResultCallId(data: ToolResultData): string | null {
  if (typeof data.callId === 'string') return data.callId;
  const fromSource = data.message?.source?.callId;
  if (typeof fromSource === 'string') return fromSource;
  const fromMessage = data.message?.toolCallId;
  if (typeof fromMessage === 'string') return fromMessage;
  return null;
}

function projectFromCwd(cwd: string): string {
  const base = path.basename(cwd ?? '');
  return base.length > 0 ? base : '(未知项目)';
}

export interface ExtractMeta {
  sourceFile: string;
  fileBytes: number;
  fileMtimeMs: number;
}

/** 把一个会话文件的 JSONL 事件流聚合为 SessionRecord；无有效头事件时返回 null。 */
export function extractSession(
  lines: string[],
  meta: ExtractMeta,
): SessionRecord | null {
  let header: SessionHeaderData | null = null;
  let route: RouteInfo | null = null;
  let lastEventTime = 0;
  let title: string | null = null;
  let turns = 0;
  let steps = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const tools: Record<string, ToolStat> = {};
  const models: Record<string, TokenUsage> = {};
  const daily: Record<string, TokenUsage> = {};
  const hourly = new Array<number>(24).fill(0) as number[];
  const retries: Record<string, number> = {};
  const openToolCalls = new Map<string, { name: string; time: number }>();

  for (const line of lines) {
    let event: SessionEvent;
    try {
      event = JSON.parse(line) as SessionEvent;
    } catch {
      continue;
    }
    const time = asNumber(event.time);
    if (time > lastEventTime) lastEventTime = time;
    const data = event.data as Record<string, unknown> | undefined;

    switch (event.type) {
      case 'session': {
        // session 头的字段位于事件顶层：{"type":"session","version":4,"id":...,"createdAt":...,"cwd":...}
        header = event as unknown as SessionHeaderData;
        break;
      }
      case 'session/title': {
        const t = data?.['title'];
        if (typeof t === 'string' && t.trim().length > 0) title = t;
        break;
      }
      case 'request/header':
      case 'request/context': {
        const info = readRoute(data);
        if (info) route = info;
        break;
      }
      case 'turn/start': {
        turns += 1;
        break;
      }
      case 'step/start': {
        steps += 1;
        break;
      }
      case 'user/message': {
        userMessages += 1;
        break;
      }
      case 'assistant/message': {
        assistantMessages += 1;
        const messageData = (data ?? {}) as AssistantMessageData;
        const usage = normalizeUsage(messageData.usage, 1);
        const key = modelKey(route);
        const bucket = models[key] ?? emptyUsage();
        addUsage(bucket, usage);
        models[key] = bucket;
        const stamp = time > 0 ? time : meta.fileMtimeMs;
        const dayBucket = daily[localDateKey(stamp)] ?? emptyUsage();
        addUsage(dayBucket, usage);
        daily[localDateKey(stamp)] = dayBucket;
        hourly[new Date(stamp).getHours()] += 1;
        break;
      }
      case 'tool/call': {
        const callData = (data ?? {}) as ToolCallData;
        if (
          typeof callData.callId === 'string' &&
          typeof callData.name === 'string'
        ) {
          openToolCalls.set(callData.callId, { name: callData.name, time });
        }
        toolCalls += 1;
        break;
      }
      case 'tool/result': {
        const resultData = (data ?? {}) as ToolResultData;
        const callId = toolResultCallId(resultData);
        const open = callId !== null ? openToolCalls.get(callId) : undefined;
        const name = open?.name ?? '(未知工具)';
        const stat = ensureTool(tools, name);
        stat.calls += 1;
        if (open && time >= open.time) stat.totalDurationMs += time - open.time;
        const failed =
          resultData.isError === true ||
          typeof (data as Record<string, unknown> | undefined)?.['error'] ===
            'string';
        if (failed) {
          stat.errors += 1;
          toolErrors += 1;
        }
        if (callId !== null) openToolCalls.delete(callId);
        break;
      }
      case 'llm/retry': {
        const retryData = (data ?? {}) as RetryData;
        const code = retryData.failure?.code ?? 'UNKNOWN';
        retries[code] = (retries[code] ?? 0) + 1;
        break;
      }
      default:
        break;
    }
  }

  if (!header || typeof header.id !== 'string') return null;
  const createdAt = asNumber(header.createdAt) || meta.fileMtimeMs;
  const lastActiveAt = Math.max(lastEventTime, createdAt);
  const cwd =
    typeof header.cwd === 'string' && header.cwd.length > 0
      ? header.cwd
      : meta.sourceFile;
  const primaryModel =
    Object.entries(models).sort((a, b) => b[1].calls - a[1].calls)[0]?.[0] ??
    null;

  const record: SessionRecord = {
    id: header.id,
    project: projectFromCwd(cwd),
    cwd,
    title,
    agentPreset:
      typeof header.agentPreset === 'string' ? header.agentPreset : null,
    createdAt,
    lastActiveAt,
    activeMs: Math.max(0, lastActiveAt - createdAt),
    turns,
    steps,
    userMessages,
    assistantMessages,
    toolCalls,
    toolErrors,
    tools,
    models,
    primaryModel,
    daily,
    hourly,
    retries,
    sourceFile: meta.sourceFile,
    fileBytes: meta.fileBytes,
    fileMtimeMs: meta.fileMtimeMs,
  };
  return record;
}
