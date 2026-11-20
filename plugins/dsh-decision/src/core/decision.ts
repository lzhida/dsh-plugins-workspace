/**
 * dsh-decision 决策底座（决策门控系列 2/4）。
 *
 * 「决策点无关」的决策能力三件套，供 ask-gate（3/4）与未来的
 * tool-gate / route-gate 复用：
 *
 * 1. {@linkcode runDecisionCall} —— 决策模型调用封装。照抄宿主
 *    `@deepseek-ai/dsh-session-title-llm` 范式：`ctx.llm.prepareCall(...)`
 *    + `call.stream({...call.config, messages, system, signal})`，
 *    手工拼流式 text 输出。**自带超时与上游取消融合**，任何故障都归一为
 *    结构化降级信号，绝不向调用方抛穿——辅助调用不受 dsh-llm-fallback
 *    保护，必须自兜底。
 * 2. {@linkcode parseDecisionResponse} —— 置信度解析纯函数。从决策模型
 *    的文本输出里提取结构化结果（置信度 0~1 + 建议答案 + 理由）；解析
 *    失败/缺字段/非数字按低置信语义返回（confidence=0）。
 * 3. {@linkcode decideByThreshold} —— 阈值判定纯函数。`≥threshold` →
 *    自动作答；`<threshold` → 放行真实提问；边界值（=threshold）归入
 *    自动作答；threshold 本身非法时一律放行（fail-open）。
 *
 * ## 设计约束
 *
 * - **不 import `@deepseek-ai/dsh-llm`**：宿主运行时的 `ctx.llm` 由
 *   `inject` 注入，core 只依赖一个本地最小结构面
 *   {@linkcode DecisionLlmLike}（duck-typing）。这样本包保持纯 TS 源码
 *   入口、零运行时依赖，也不会顶替宿主的 dsh-llm 实例。
 * - **消息不经过 createUserMessage**：`GenerateOptions.messages` 接受
 *   `RequestMessage = Message | RequestUserInput`，其中
 *   `RequestUserInput = { role:'user', content, id?:never, source?:never }`
 *   是无会话身份的单次用户输入（dsh-llm types.d.ts）——用普通对象即可，
 *   不需要注册 MessageSourceMap。
 * - **purpose 省略**：本仓对齐的宿主 0.2.1-rc.2 中 `GenerateOptions.purpose`
 *   是封闭联合 `'compaction' | 'session-title'`，无法注册自定义值；0.2.2-rc.1+
 *   才开放 `LlmRequestPurposeMap` 模块合并。省略该字段两版皆合法。
 * - **超时自实现**：不用 `@deepseek-ai/dsh-timeout` 的 `deadline()`（那是
 *   独立 npm 包，引它会动 lock 文件）。用 `AbortController` + `setTimeout`
 *   并融合上游 signal，语义等价（上游取消 + 自有超时 → 同一条 abort 线）。
 */

/** 决策模型路由与调用参数（决策点从配置里取好后传入）。 */
export interface DecisionCallOptions {
  /** 决策模型 provider；空串视为未配置（不发起调用）。 */
  provider: string;
  /** 决策模型 model；空串视为未配置（不发起调用）。 */
  model: string;
  /** 单次调用超时（毫秒），必须 > 0。 */
  timeoutMs: number;
  /** 输出 token 上限；缺省 512（置信度判定输出很小）。 */
  maxTokens?: number;
}

/** 决策点上下文——决策点无关的调用输入。 */
export interface DecisionCallInput {
  /** 决策问题文本（决策点自行拼好，core 不耦合任何提问结构）。 */
  prompt: string;
  /** 可选 system 提示（决策点各自的判定纪律）。 */
  system?: string;
  /** 上游信号（跟随调用方取消；超时与上游取消共用一条 abort 线）。 */
  signal?: AbortSignal;
}

/**
 * 决策模型调用的结构化结果。
 *
 * 约定：除 `ok` 外全部是**降级信号**，调用方据此 fail-open（放行真实提问），
 * 不得把任何非 ok 分支当成决策结论。
 */
export type DecisionOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'model-error'; message: string; code?: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'llm-unavailable' }
  | { kind: 'route-invalid' };

/**
 * 宿主 `ctx.llm` 的本地最小结构面（duck-typing，不引宿主类型）。
 *
 * stream options / call config 都用 `object` 而非 `Record<string, unknown>`：
 * 宿主 `PreparedLlmCall.config: LlmCallConfig` 是 interface（无隐式索引签名）、
 * `stream(options: GenerateOptions)` 参数是具名 interface，`Record` 两侧
 * 都互不兼容会让 3/4 接线处必须 cast；`object` 双向兼容（bivariance）。
 */
export interface DecisionLlmLike {
  prepareCall(
    config: {
      provider: string;
      model: string;
      maxTokens?: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    /** 已落定适配器默认值的调用配置；stream options 必须回填它。 */
    config: object;
    stream(options: object): AsyncIterable<unknown>;
  }>;
}

/** 决策模型建议的单条答案（3/4 ask-gate 按问题 id 消费）。 */
export interface DecisionParseAnswer {
  /** 对应问题的稳定 id。 */
  id: string;
  /** 选中选项的 label 列表（选择题）；空数组＝非选择题或未选。 */
  selected: string[];
  /** 建议的自由文本答案（开放题/备注）。 */
  custom?: string;
}

/** 决策输出的结构化解析结果。 */
export interface DecisionParseResult {
  /** true＝成功解析出置信度；false＝按低置信处理。 */
  ok: boolean;
  /** 置信度 0~1（解析失败时恒为 0）。 */
  confidence: number;
  /** 模型建议答案（可选字段，非字符串则不收）。 */
  suggestedAnswer?: string;
  /** 模型给的理由（可选字段，非字符串则不收）。 */
  reason?: string;
  /**
   * 决策模型按问题给出的结构化答案（可选）。宽松清洗：只保留
   * `id` 为非空字符串且 `selected` 为字符串数组的条目；清洗后为空
   * 则不收。3/4 消费方须自行校验「按 id 全覆盖」才可自动作答。
   */
  answers?: DecisionParseAnswer[];
  /** 原始置信度越界被钳制到 [0,1] 时为 true。 */
  clamped?: boolean;
  /** 解析失败原因（测试锚定与日志用）。 */
  parseError?: string;
}

/** 阈值判定结论。 */
export type DecisionVerdict = 'auto-answered' | 'passed-through';

/** 阈值判定结果（附原因便于测试锚定与轨迹记录）。 */
export interface DecisionThresholdResult {
  verdict: DecisionVerdict;
  /** 判定依据；常规路径省略。 */
  reason?: 'invalid-threshold';
}

/** 决策调用输出 token 的缺省上限。 */
export const DECISION_MAX_TOKENS = 512;

/**
 * 组装一次决策调用的流式选项与用户消息（普通对象，无运行时依赖）。
 *
 * `call.config` 必须整体回填进 stream options，否则宿主以
 * `INVALID_PREPARED_CALL` 拒绝（request 的 call-config 必须与
 * prepareCall 落定值一致）。
 */
export function buildDecisionStreamOptions(
  call: {
    config: object;
  },
  input: DecisionCallInput,
  signal: AbortSignal,
): Record<string, unknown> {
  const messages = [
    {
      role: 'user',
      content: [{ type: 'text', text: input.prompt }],
    },
  ];
  const options: Record<string, unknown> = {
    ...call.config,
    messages,
    signal,
  };
  if (input.system !== undefined && input.system !== '') {
    options.system = input.system;
  }
  return options;
}

/**
 * 决策模型调用封装。任何失败都归一为 {@linkcode DecisionOutcome} 降级
 * 信号，绝不抛穿。
 *
 * @param llm - 宿主 `ctx.llm` 服务（决策点从 ctx 取好后传入）。
 * @param input - 决策点上下文。
 * @param options - 路由与超时参数。
 */
export async function runDecisionCall(
  llm: DecisionLlmLike | undefined,
  input: DecisionCallInput,
  options: DecisionCallOptions,
): Promise<DecisionOutcome> {
  // 路由合法性：provider/model 任一为空＝未配置，不发起调用。
  if (
    typeof options.provider !== 'string' ||
    options.provider === '' ||
    typeof options.model !== 'string' ||
    options.model === ''
  ) {
    return { kind: 'route-invalid' };
  }
  if (!llm || typeof llm.prepareCall !== 'function') {
    return { kind: 'llm-unavailable' };
  }

  // 自有超时 + 上游取消融合成一条 abort 线（不引 dsh-timeout）。
  const controller = new AbortController();
  const timeoutMs =
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? options.timeoutMs
      : 30_000;
  const timer = setTimeout(
    () => controller.abort(new Error('timeout')),
    timeoutMs,
  );
  const onUpstreamAbort = () => controller.abort(input.signal?.reason);
  if (input.signal) {
    if (input.signal.aborted) {
      clearTimeout(timer);
      return { kind: 'aborted' };
    }
    input.signal.addEventListener('abort', onUpstreamAbort, { once: true });
  }

  try {
    let call: Awaited<ReturnType<DecisionLlmLike['prepareCall']>>;
    try {
      call = await llm.prepareCall(
        {
          provider: options.provider,
          model: options.model,
          maxTokens: options.maxTokens ?? DECISION_MAX_TOKENS,
        },
        controller.signal,
      );
    } catch (err) {
      if (input.signal?.aborted) {
        return { kind: 'aborted' };
      }
      if (controller.signal.aborted && !input.signal?.aborted) {
        // 只有本能力超时会走到这里（上游取消已在上面透传）。
        return { kind: 'timeout' };
      }
      return {
        kind: 'model-error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const streamOptions = buildDecisionStreamOptions(
      call,
      input,
      controller.signal,
    );
    let text = '';
    // 宿主把适配器故障规范化为终态 finish chunk（reason.kind='error'|'aborted'）
    // 而非异常——必须读取末个 finish 并据此降级，否则会「带病自动作答」。
    let finishKind: string | undefined;
    let finishFailure: { message?: unknown; code?: unknown } | undefined;
    try {
      for await (const raw of call.stream(streamOptions)) {
        controller.signal.throwIfAborted();
        const chunk = raw as {
          type?: string;
          text?: unknown;
          reason?: {
            kind?: string;
            failure?: { message?: unknown; code?: unknown };
          };
        };
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text;
        }
        if (chunk.type === 'finish' && chunk.reason) {
          finishKind = chunk.reason.kind;
          finishFailure = chunk.reason.failure;
        }
      }
      // 收尾竞态：迭代器正常收尾期间发生 abort（自有超时或上游取消）时，
      // 循环体已检测不到——必须在同一 try 内归一分类，绝不抛穿调用方。
      controller.signal.throwIfAborted();
    } catch (err) {
      // 流中途抛错/收尾竞态：上游取消 → aborted；自有超时 → timeout；其余 → model-error。
      if (input.signal?.aborted) {
        return { kind: 'aborted' };
      }
      if (controller.signal.aborted) {
        return { kind: 'timeout' };
      }
      return {
        kind: 'model-error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 操作性失败以终态 chunk 表达：error → model-error；aborted → aborted；
    // stop / tool-calls / max-tokens 视为正常完成（max-tokens 截断会自然在
    // 解析层落低置信 → 放行，fail-open 不受影响）。
    if (finishKind === 'error') {
      return {
        kind: 'model-error',
        message:
          finishFailure && typeof finishFailure.message === 'string'
            ? finishFailure.message
            : 'decision model reported an error finish',
        code:
          finishFailure && typeof finishFailure.code === 'string'
            ? finishFailure.code
            : undefined,
      };
    }
    if (finishKind === 'aborted') {
      return { kind: 'aborted' };
    }

    // 正常完成：文本为空也视为 ok，交由解析层按低置信处理
    // （对决策而言「空回复」与「低置信」后果一致）。
    return { kind: 'ok', text };
  } finally {
    clearTimeout(timer);
    if (input.signal) {
      input.signal.removeEventListener('abort', onUpstreamAbort);
    }
  }
}

/** 从文本中提取第一段平衡的 JSON 对象字符串（支持 ```json 围栏）。 */
function extractJsonObject(text: string): string | undefined {
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) {
    return fence[1];
  }
  const start = text.indexOf('{');
  if (start < 0) {
    return undefined;
  }
  // 从第一个 { 起做括号计数，取第一个平衡块（容忍字符串内的花括号）。
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return undefined;
}

/** 从解析出的对象里按候选键取第一个字符串字段。 */
function pickString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return undefined;
}

/** 置信度字段的候选键（决策模型输出别名）。 */
const CONFIDENCE_KEYS = [
  'confidence',
  'confidenceScore',
  'confidence_score',
] as const;

/** 建议答案字段的候选键。 */
const SUGGESTED_ANSWER_KEYS = [
  'suggestedAnswer',
  'suggested_answer',
  'answer',
] as const;

/** 理由字段的候选键。 */
const REASON_KEYS = ['reason', 'rationale', 'explanation'] as const;

/**
 * 置信度解析纯函数：从决策模型文本输出提取结构化结果。
 *
 * 解析规则：
 * - 优先取 ```json 围栏内的 JSON，其次取文本中第一个平衡的 `{...}` 块；
 * - `confidence` 必须是有限数字，越界值钳制到 [0,1] 并标记 `clamped`；
 * - 建议答案与理由按候选键宽松提取，非字符串则不收；
 * - 解析失败 / JSON 缺失 / 缺 confidence / confidence 非数字 →
 *   `{ ok:false, confidence:0 }`（低置信语义，调用方按放行处理）。
 */
export function parseDecisionResponse(text: string): DecisionParseResult {
  const fail = (parseError: string): DecisionParseResult => ({
    ok: false,
    confidence: 0,
    parseError,
  });
  if (typeof text !== 'string' || text.trim() === '') {
    return fail('empty-output');
  }
  const json = extractJsonObject(text);
  if (json === undefined) {
    return fail('no-json-object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail('json-parse-failed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('not-an-object');
  }
  const record = parsed as Record<string, unknown>;
  const rawConfidence =
    record[CONFIDENCE_KEYS.find((key) => key in record) ?? ''];
  if (typeof rawConfidence !== 'number' || !Number.isFinite(rawConfidence)) {
    return fail('confidence-not-a-number');
  }
  const clamped = rawConfidence < 0 || rawConfidence > 1;
  const result: DecisionParseResult = {
    ok: true,
    confidence: Math.min(1, Math.max(0, rawConfidence)),
  };
  if (clamped) {
    result.clamped = true;
  }
  const suggestedAnswer = pickString(record, SUGGESTED_ANSWER_KEYS);
  if (suggestedAnswer !== undefined) {
    result.suggestedAnswer = suggestedAnswer;
  }
  const reason = pickString(record, REASON_KEYS);
  if (reason !== undefined) {
    result.reason = reason;
  }
  const answers = extractParseAnswers(record.answers);
  if (answers.length > 0) {
    result.answers = answers;
  }
  return result;
}

/**
 * 宽松清洗决策模型的 `answers` 数组：只保留「id 为非空字符串、
 * selected 为字符串数组」的条目；selected 内非字符串元素剔除、
 * custom 非字符串则丢弃。清洗后全部无效则返回空数组（调用方据此
 * 不收该字段）。
 */
function extractParseAnswers(raw: unknown): DecisionParseAnswer[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const answers: DecisionParseAnswer[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = record.id;
    if (typeof id !== 'string' || id.trim() === '') {
      continue;
    }
    const selected = Array.isArray(record.selected)
      ? record.selected.filter(
          (label): label is string => typeof label === 'string',
        )
      : [];
    const custom = record.custom;
    answers.push({
      id,
      selected,
      ...(typeof custom === 'string' && custom.trim() !== '' ? { custom } : {}),
    });
  }
  return answers;
}

/**
 * 阈值判定纯函数。
 *
 * - `confidence >= threshold` → `auto-answered`（边界值归入自动作答）；
 * - `confidence < threshold` → `passed-through`（放行真实提问）；
 * - threshold 非有限、≤0 或 >1 一律放行并标记原因——阈值配置坏了宁可
 *   多问用户（fail-open），也不能静默自动作答。
 */
export function decideByThreshold(
  confidence: number,
  threshold: number,
): DecisionThresholdResult {
  if (
    typeof threshold !== 'number' ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    threshold > 1
  ) {
    return { verdict: 'passed-through', reason: 'invalid-threshold' };
  }
  if (confidence >= threshold) {
    return { verdict: 'auto-answered' };
  }
  return { verdict: 'passed-through' };
}

/** 一次完整决策（调用 → 解析 → 判定）的报告。 */
export interface DecisionReport {
  /** 模型调用结果（含全部降级信号分支）。 */
  call: DecisionOutcome;
  /** 置信度解析结果（调用失败时恒为低置信）。 */
  parse: DecisionParseResult;
  /** 阈值判定结论（fail-open：任何非 ok 调用都放行）。 */
  threshold: DecisionThresholdResult;
}

/**
 * 一次完整决策：调用 → 解析 → 判定。
 *
 * fail-open 语义总闸：模型调用任何非 ok 分支（报错/超时/中止/未配置）都
 * 直接放行真实提问，不产生自动作答。
 */
export async function decide(
  llm: DecisionLlmLike | undefined,
  input: DecisionCallInput,
  options: DecisionCallOptions,
  threshold: number,
): Promise<DecisionReport> {
  const call = await runDecisionCall(llm, input, options);
  if (call.kind !== 'ok') {
    return {
      call,
      parse: { ok: false, confidence: 0 },
      threshold: { verdict: 'passed-through' },
    };
  }
  const parse = parseDecisionResponse(call.text);
  return {
    call,
    parse,
    threshold: decideByThreshold(parse.confidence, threshold),
  };
}
