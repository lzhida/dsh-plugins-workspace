/**
 * systemone HTTP client（决策工具系列 2/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §2（systemone 接口定稿）。
 *
 * 职责边界：只做 HTTP、超时、错误码归一（§2.6 映射表）与响应形状解析
 * （§2.3/§2.4）。不做守卫、记账、预算——那些在 runtime/ 统一调用层。
 *
 * 关键定稿：
 * - POST `{baseUrl}/v1/systemone`，`Authorization: Bearer <key>`。
 * - 带 `assets` 时必须带 `TypeSafe-Danger-Zone-Images: true` 头（§2.5）。
 * - noul 至少含 `noul`；choice 至少含 `choice`；score 至少含 `score` 与
 *   `legend`；缺失的 `confidence` / `probabilities` 记 `null`，不臆造。
 * - 某题未出现在 `answers` → 记入 `droppedQuestionIds`（不填默认值）。
 * - HTTP→错误码映射见 mapHttpFailure()；`error.details` 不含 apiKey。
 */

import { decisionError, type DecisionErrorEnvelope } from './errors.ts';
import type {
  SystemOneAsset,
  SystemOneCallResult,
  SystemOneInvalidAnswer,
  SystemOneNormalizedUsage,
  SystemOneParsedAnswer,
  SystemOneQuestion,
} from './types.ts';

// ── 常量 ──────────────────────────────────────────────────────────────

export const SYSTEMONE_ENDPOINT_PATH = '/v1/systemone';
export const IMAGES_DANGER_HEADER = 'TypeSafe-Danger-Zone-Images';

/** 单请求题数上限（契约 §2.2，阿里云口径）。 */
export const MAX_QUESTIONS_PER_CALL = 16;

// ── 类型 ──────────────────────────────────────────────────────────────

export interface SystemOneHttpConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/** 请求载荷的业务部分（model 由 http 配置注入）。 */
export interface SystemOneCallBody {
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  assets?: Record<string, SystemOneAsset>;
}

/**
 * 最小 fetch 形状（与全局 fetch 兼容，测试可注入 stub）。
 * 刻意不引宿主/Node 类型：只要求用到的成员。
 */
export type FetchLike = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface SystemOneCallOptions {
  http: SystemOneHttpConfig;
  body: SystemOneCallBody;
  /** 调用方取消信号（与内部超时融合为同一条 abort 线）。 */
  signal?: AbortSignal;
  /** verify 阶段 401/403 归一为 model-verify-failed（契约 §2.6）。 */
  phase?: 'call' | 'verify';
  fetchImpl?: FetchLike;
}

export interface VerifyOk {
  ok: true;
  model: string | null;
  latencyMs: number;
}

export interface VerifyFail {
  ok: false;
  error: DecisionErrorEnvelope;
  latencyMs: number;
}

export type VerifyResult = VerifyOk | VerifyFail;

// ── URL 与头 ──────────────────────────────────────────────────────────

/** 拼端点；baseUrl 非法（空/非 http）返回 null——守卫层据此报未配置。 */
export function buildSystemOneEndpoint(baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '' || !/^https?:\/\//i.test(trimmed)) return null;
  return `${trimmed}${SYSTEMONE_ENDPOINT_PATH}`;
}

export function buildSystemOneHeaders(
  apiKey: string,
  hasAssets: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  // 图片/box 题型默认关闭，必须显式声明（契约 §2.5）。
  if (hasAssets) headers[IMAGES_DANGER_HEADER] = 'true';
  return headers;
}

// ── 低层 POST（超时 + 取消融合）───────────────────────────────────────

type RawOutcome =
  | { kind: 'response'; status: number; text: string; latencyMs: number }
  | { kind: 'timeout'; latencyMs: number }
  | { kind: 'caller-aborted'; latencyMs: number }
  | { kind: 'network-error'; message: string; latencyMs: number };

async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  bodyJson: unknown,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<RawOutcome> {
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timer);
      return { kind: 'caller-aborted', latencyMs: Date.now() - startedAt };
    }
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(bodyJson),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      kind: 'response',
      status: response.status,
      text,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (timedOut) return { kind: 'timeout', latencyMs: Date.now() - startedAt };
    if (callerSignal?.aborted) {
      return { kind: 'caller-aborted', latencyMs: Date.now() - startedAt };
    }
    return {
      kind: 'network-error',
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }
}

// ── HTTP 失败 → 错误码（契约 §2.6 映射表）────────────────────────────

function mapHttpFailure(
  outcome: Exclude<RawOutcome, { kind: 'response' }>,
): DecisionErrorEnvelope {
  switch (outcome.kind) {
    case 'timeout':
      return decisionError(
        'model-timeout',
        'systemone 调用超时，可重试或调大 systemoneTimeoutMs',
        {
          details: { timeoutMs: true },
        },
      );
    case 'caller-aborted':
      // details.aborted=true 让调用层识别「调用方主动取消」——不触发兜底裁判。
      return decisionError(
        'model-call-failed',
        'systemone 调用已被调用方取消',
        {
          details: { aborted: true },
        },
      );
    case 'network-error':
      return decisionError(
        'model-call-failed',
        `systemone 连接失败，请检查 baseUrl 与网络：${outcome.message.slice(0, 120)}`,
      );
  }
}

function mapHttpStatus(
  status: number,
  bodyText: string,
  phase: 'call' | 'verify',
): DecisionErrorEnvelope {
  if (status === 401 || status === 403) {
    return phase === 'verify'
      ? decisionError(
          'model-verify-failed',
          `验证被拒绝（HTTP ${status}），请检查 API key 与端点权限`,
        )
      : decisionError(
          'model-call-failed',
          `systemone 拒绝调用（HTTP ${status}），请检查 API key`,
        );
  }
  if (status === 400) {
    // 400 可能是「模型不支持 box/图像能力」——按契约 §2.6 区分。
    const lower = bodyText.toLowerCase();
    // 上游题型枚举拒绝实测（卡 9/11，local-decision-model）：
    //   questions.target: "type" must be one of: choice, score, noul
    // 这类是「该模型不支持所请求题型」的能力缺失，不是载荷形状写错。
    const typeEnumRejected =
      lower.includes('must be one of') &&
      (lower.includes('choice') ||
        lower.includes('score') ||
        lower.includes('noul'));
    const capabilityLike =
      lower.includes('box') ||
      lower.includes('image') ||
      lower.includes('asset') ||
      typeEnumRejected;
    if (capabilityLike) {
      const upstream = bodyText.replace(/\s+/g, ' ').slice(0, 160);
      return decisionError(
        'model-unsupported-capability',
        `该端点/模型不支持所请求的题型或图像/box 定位能力（HTTP 400）`,
        { details: { upstream } },
      );
    }
    return decisionError(
      'model-invalid-response',
      `systemone 拒绝请求载荷（HTTP 400），请检查题型与 criteria 形状`,
    );
  }
  if (status === 404) {
    return decisionError(
      'model-call-failed',
      'systemone 端点不存在（HTTP 404），请检查 baseUrl 是否含正确路径',
    );
  }
  if (status === 429 || status >= 500) {
    return decisionError(
      'model-call-failed',
      `systemone 暂时不可用（HTTP ${status}），可稍后重试`,
    );
  }
  return decisionError(
    'model-call-failed',
    `systemone 返回异常状态（HTTP ${status}）`,
  );
}

// ── 响应解析（契约 §2.3/§2.4 形状定稿）────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalConfidence(raw: Record<string, unknown>): number | null {
  const value = raw.confidence;
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function optionalProbabilityMap(
  raw: Record<string, unknown>,
): Record<string, number> | null {
  const value = raw.probabilities;
  if (!isPlainObject(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, num] of Object.entries(value)) {
    if (typeof num !== 'number' || !Number.isFinite(num)) return null;
    out[key] = num;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * 档位序列归一：上游可能给「有序数组」也可能给「档位索引 → 值」的对象映射。
 * 实测（卡 9/11，local-decision-model）：score 题的 legend 与 probabilities 都返回
 * 对象映射（{"0":"negligible",...} / {"0":0.357,...}），而数组形状也合法。
 * 插件内部统一归一为数组：对象按数值键升序排列，非数值键保持出现顺序。
 */
function normalizeLevelSequence(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  const numericKeys = entries.every(([key]) => /^\d+$/.test(key));
  const sorted = numericKeys
    ? [...entries].sort((a, b) => Number(a[0]) - Number(b[0]))
    : entries;
  return sorted.map(([, item]) => item);
}

function normalizeScoreLegend(raw: Record<string, unknown>): string[] | null {
  const items = normalizeLevelSequence(raw.legend);
  if (!items || items.length === 0) return null;
  if (items.some((item) => typeof item !== 'string')) return null;
  return items as string[];
}

function normalizeScoreProbabilities(
  raw: Record<string, unknown>,
): number[] | null {
  const items = normalizeLevelSequence(raw.probabilities);
  if (!items || items.length === 0) return null;
  if (items.some((item) => typeof item !== 'number' || !Number.isFinite(item)))
    return null;
  return items as number[];
}

/** 单题解析；形状非法返回 null（由调用方记 invalidAnswers）。 */
function parseAnswer(
  question: SystemOneQuestion,
  raw: unknown,
): SystemOneParsedAnswer | null {
  if (!isPlainObject(raw)) return null;
  switch (question.type) {
    case 'noul': {
      const noul = raw.noul;
      if (
        typeof noul !== 'number' ||
        !Number.isFinite(noul) ||
        noul < 0 ||
        noul > 1
      ) {
        return null;
      }
      return {
        kind: 'noul',
        pYes: noul,
        confidence: optionalConfidence(raw),
        probabilities: optionalProbabilityMap(raw),
      };
    }
    case 'choice': {
      const choice = raw.choice;
      if (typeof choice !== 'string' || choice === '') return null;
      return {
        kind: 'choice',
        choice,
        confidence: optionalConfidence(raw),
        probabilities: optionalProbabilityMap(raw),
      };
    }
    case 'score': {
      const score = raw.score;
      if (typeof score !== 'number' || !Number.isFinite(score)) return null;
      const legend = normalizeScoreLegend(raw);
      if (!legend) return null;
      return {
        kind: 'score',
        score,
        legend,
        confidence: optionalConfidence(raw),
        probabilities: normalizeScoreProbabilities(raw),
      };
    }
    case 'box': {
      const box = raw.box;
      if (!isPlainObject(box)) return null;
      const edges = ['top', 'bottom', 'left', 'right'] as const;
      const normalized: Record<(typeof edges)[number], number> = {
        top: NaN,
        bottom: NaN,
        left: NaN,
        right: NaN,
      };
      for (const edge of edges) {
        const value = box[edge];
        if (
          typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 1
        ) {
          return null;
        }
        normalized[edge] = value;
      }
      // confidence 可显式为 null（契约 §2.5）。
      return {
        kind: 'box',
        box: normalized,
        confidence: optionalConfidence(raw),
      };
    }
  }
}

function normalizeUsage(raw: unknown): SystemOneNormalizedUsage | null {
  if (!isPlainObject(raw)) return null;
  const input = raw.input_tokens;
  const output = raw.output_tokens;
  return {
    inputTokens:
      typeof input === 'number' && Number.isFinite(input) ? input : null,
    outputTokens:
      typeof output === 'number' && Number.isFinite(output) ? output : null,
  };
}

function parseEnvelope(
  bodyText: string,
  questions: Record<string, SystemOneQuestion>,
):
  | {
      ok: true;
      result: Omit<SystemOneCallResult & { ok: true }, 'ok' | 'latencyMs'>;
    }
  | { ok: false; error: DecisionErrorEnvelope } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return {
      ok: false,
      error: decisionError(
        'model-invalid-response',
        'systemone 返回体不是合法 JSON',
      ),
    };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.answers)) {
    return {
      ok: false,
      error: decisionError(
        'model-invalid-response',
        'systemone 返回体缺少 answers 对象，形状不符合契约',
      ),
    };
  }
  const answers = parsed.answers as Record<string, unknown>;
  const parsedAnswers: Record<string, SystemOneParsedAnswer> = {};
  const droppedQuestionIds: string[] = [];
  const invalidAnswers: SystemOneInvalidAnswer[] = [];
  for (const [qid, question] of Object.entries(questions)) {
    const rawAnswer = answers[qid];
    if (rawAnswer === undefined || rawAnswer === null) {
      droppedQuestionIds.push(qid);
      continue;
    }
    const answer = parseAnswer(question, rawAnswer);
    if (answer === null) {
      invalidAnswers.push({
        questionId: qid,
        reason: `题型 ${question.type} 响应形状非法`,
      });
      continue;
    }
    parsedAnswers[qid] = answer;
  }
  return {
    ok: true,
    result: {
      model: typeof parsed.model === 'string' ? parsed.model : null,
      answers: parsedAnswers,
      droppedQuestionIds,
      invalidAnswers,
      usage: normalizeUsage(parsed.usage),
    },
  };
}

// ── 对外入口 ──────────────────────────────────────────────────────────

/** 发一次 systemone 决策调用（含超时、错误码归一与形状解析）。 */
export async function callSystemOne(
  options: SystemOneCallOptions,
): Promise<SystemOneCallResult> {
  const phase = options.phase ?? 'call';
  const endpoint = buildSystemOneEndpoint(options.http.baseUrl);
  if (
    endpoint === null ||
    options.http.apiKey === '' ||
    options.http.model === ''
  ) {
    return {
      ok: false,
      error: decisionError(
        'model-not-configured',
        '决策模型未配置完整（baseUrl / API key / model 任一为空），请先在设置页配置并验证',
      ),
      latencyMs: 0,
    };
  }
  const questionCount = Object.keys(options.body.questions).length;
  if (questionCount === 0 || questionCount > MAX_QUESTIONS_PER_CALL) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        `questions 需为 1–${MAX_QUESTIONS_PER_CALL} 题，当前 ${questionCount} 题`,
      ),
      latencyMs: 0,
    };
  }
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
  const payload: Record<string, unknown> = {
    model: options.http.model,
    state: options.body.state,
    questions: options.body.questions,
  };
  const hasAssets =
    options.body.assets !== undefined &&
    Object.keys(options.body.assets).length > 0;
  if (hasAssets) payload.assets = options.body.assets;
  const outcome = await postJson(
    fetchImpl,
    endpoint,
    buildSystemOneHeaders(options.http.apiKey, hasAssets),
    payload,
    options.http.timeoutMs,
    options.signal,
  );
  if (outcome.kind !== 'response') {
    return {
      ok: false,
      error: mapHttpFailure(outcome),
      latencyMs: outcome.latencyMs,
    };
  }
  if (outcome.status < 200 || outcome.status >= 300) {
    return {
      ok: false,
      error: mapHttpStatus(outcome.status, outcome.text, phase),
      latencyMs: outcome.latencyMs,
    };
  }
  const parsed = parseEnvelope(outcome.text, options.body.questions);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, latencyMs: outcome.latencyMs };
  }
  return { ok: true, ...parsed.result, latencyMs: outcome.latencyMs };
}

/**
 * 验证探测：发一题最小 noul 请求，2xx 且形状合法即视为验证通过。
 * 成功返回（model, latencyMs），失败返回归一化错误码（供设置页展示）。
 */
export async function verifySystemOne(options: {
  http: SystemOneHttpConfig;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<VerifyResult> {
  const result = await callSystemOne({
    http: options.http,
    phase: 'verify',
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    body: {
      state: {
        message: 'Verification probe: answer the single question below.',
      },
      questions: {
        probe: {
          type: 'noul',
          instructions:
            'Answer this probe question so the endpoint can be verified.',
        },
      },
    },
  });
  if (result.ok) {
    // 验证必须真的答出 probe 题——probe 被丢弃（dropped）或答案非法都不算通过，
    // 否则「端点返回 200 但不答决策题」的假端点会被误判为已验证。
    const probeMissing =
      !result.answers.probe ||
      result.droppedQuestionIds.includes('probe') ||
      result.invalidAnswers.some((item) => item.questionId === 'probe');
    if (probeMissing) {
      return {
        ok: false,
        error: decisionError(
          'model-verify-failed',
          '验证探测未被回答（端点有响应但缺少 probe 题的判定），请确认模型与端点支持决策接口',
        ),
        latencyMs: result.latencyMs,
      };
    }
    return { ok: true, model: result.model, latencyMs: result.latencyMs };
  }
  return { ok: false, error: result.error, latencyMs: result.latencyMs };
}
