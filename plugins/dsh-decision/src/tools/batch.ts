/**
 * decision_batch 工具（决策工具系列 4/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §3.4（batch）、§7（每行独立判定）、
 * §8.2（每行进账本，questionId = {组questionId}#{行号}）、§1.1（信封）、
 * §11（Tool 设计纪律 D1–D6）。
 *
 * 硬纪律：1–5 组 × 1–20 条文本；并发上限 5（worker pool，不随行数线性放大）；
 * 失败行原样上报（text 不改、错误码不猜、不填默认值）；整批永不因单行失败整体失败；
 * 结果等长同序（index 对应输入下标）；每行独立走统一调用层（记账/预算闸/兜底挂点）。
 */

import {
  defineTool,
  type InferValue,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';

import {
  decisionError,
  type DecisionErrorEnvelope,
  type DecisionErrorCode,
} from '../systemone/errors.ts';
import type { JsonValue, SystemOneQuestion } from '../systemone/types.ts';
import { runDecisionCall, type DecisionCallDeps } from '../runtime/call.ts';
import {
  checkModelReady,
  checkToolEnabled,
  type VerifySnapshot,
} from '../runtime/guard.ts';
import type { ResolvedToolsConfig } from '../config/decision-tools.ts';
import {
  DECIDE_CHOICE_MAX,
  DECIDE_CHOICE_MIN,
  DECIDE_INSTRUCTIONS_MAX,
  DECIDE_SCORE_LEVELS_MAX,
  DECIDE_SCORE_LEVELS_MIN,
  mapAnswerToDecideAnswer,
  type DecideAnswer,
  type DecideQuestionPlan,
} from './decide.ts';
import { buildJudgementPrompt, type JudgementPromptParts } from './prompt.ts';

// ── 常量与 schema ───────────────────────────────────────────────────

export const BATCH_TOOL = 'decision_batch';
export const BATCH_GROUPS_MIN = 1;
export const BATCH_GROUPS_MAX = 5;
export const BATCH_TEXTS_MIN = 1;
export const BATCH_TEXTS_MAX = 20;
export const BATCH_CONCURRENCY = 5;

export const BATCH_DESCRIPTION = [
  'Classify or tag 1..20 texts per group (1..5 groups) with one typed decision question per group; return one verdict per row, never prose.',
  'Never guess, rewrite, or drop a failing row: keep its original text and original error code; the batch stays ok=true with row-level status.',
  'Actions: 1) validate group/text bounds; 2) run rows through a bounded worker pool (max 5 concurrent); 3) map answers to typed values.',
  'Constraints: 1..5 groups, 1..20 texts each; concurrency never exceeds 5; results are equal-length and in input order.',
  'Output is bounded: groupIndex/questionId + per-row index/text/status/answer-or-error. Failure to validate input returns { ok:false, error }.',
].join(' ');

export const BATCH_PARAMETERS = {
  groups: {
    type: 'array' as const,
    required: true as const,
    description: `1..${BATCH_GROUPS_MAX} judgement groups; each has { question?, texts: string[] } where texts has ${BATCH_TEXTS_MIN}..${BATCH_TEXTS_MAX} items.`,
    items: {
      type: 'object' as const,
      additionalProperties: true as const,
      properties: {
        questionId: { type: 'string' as const },
        question: {
          type: 'object' as const,
          additionalProperties: true as const,
          properties: {
            type: {
              type: 'string' as const,
              enum: ['noul', 'choice', 'score'],
            },
            instructions: { type: 'string' as const },
            criteria: {
              oneOf: [
                {
                  type: 'object' as const,
                  additionalProperties: true as const,
                  properties: {},
                },
                { type: 'array' as const },
              ] as const,
            },
          },
        },
        texts: {
          type: 'array' as const,
          required: true as const,
          items: { type: 'string' as const },
        },
      },
    },
  },
};

const BATCH_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true as const,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    results: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: true as const,
        properties: {
          groupIndex: { type: 'integer' as const, required: true as const },
          questionId: { type: 'string' as const },
          rows: {
            type: 'array' as const,
            required: true as const,
            items: {
              type: 'object' as const,
              additionalProperties: true as const,
              properties: {
                index: { type: 'integer' as const, required: true as const },
                text: { type: 'string' as const, required: true as const },
                status: {
                  type: 'string' as const,
                  enum: ['ok', 'error'],
                  required: true as const,
                },
                answer: {
                  // 行成功时是判定对象、失败时为 null——宿主按 schema 校验，
                  // 声明成纯 object 会把 null 判成 invalid output（2026-11-28 活体实测）。
                  oneOf: [
                    {
                      type: 'object' as const,
                      additionalProperties: true as const,
                      properties: {},
                    },
                    { type: 'null' as const },
                  ] as const,
                },
                error: {
                  oneOf: [
                    {
                      type: 'object' as const,
                      additionalProperties: true as const,
                      properties: {},
                    },
                    { type: 'null' as const },
                  ] as const,
                },
              },
            },
          },
        },
      },
    },
    concurrency: { type: 'integer' as const },
    degraded: { type: 'boolean' as const },
    error: {
      type: 'object' as const,
      additionalProperties: true as const,
      properties: {
        code: { type: 'string' as const, required: true as const },
        message: { type: 'string' as const, required: true as const },
        retryable: { type: 'boolean' as const, required: true as const },
        details: {
          type: 'object' as const,
          additionalProperties: true as const,
          properties: {},
        },
      },
    },
  },
};

export const BATCH_OUTPUT = {
  schema: BATCH_OUTPUT_SCHEMA,
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
};

export type BatchOutput = InferValue<typeof BATCH_OUTPUT_SCHEMA>;

// ── 入参校验（纯函数，可单测） ───────────────────────────────────────

export type BatchQuestionType = 'noul' | 'choice' | 'score';

export interface BatchQuestionPlan {
  id: string;
  type: BatchQuestionType;
  source: SystemOneQuestion;
  options: string[];
  levels: number;
}

export interface BatchGroupPlan {
  groupIndex: number;
  questionId: string;
  question: BatchQuestionPlan;
  texts: string[];
}

export interface BatchPlan {
  groups: BatchGroupPlan[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): DecisionErrorEnvelope {
  return decisionError('invalid-arguments', message);
}

/**
 * 校验单组 question（复用 decide.ts 的题型规则），返回可被 mapAnswerToDecideAnswer
 * 消费的 DecideQuestionPlan 形状（id 固定为 `q`，由调用层为每行重映射 id）。
 */
export function planBatchQuestion(
  raw: unknown,
  label: string,
):
  | {
      ok: true;
      question: {
        type: BatchQuestionType;
        source: SystemOneQuestion;
        options: string[];
        levels: number;
      };
    }
  | { ok: false; error: DecisionErrorEnvelope } {
  if (!isPlainObject(raw))
    return { ok: false, error: invalid(`${label} 必须是对象`) };
  const type = raw.type;
  if (type !== 'noul' && type !== 'choice' && type !== 'score') {
    return {
      ok: false,
      error: invalid(`${label} 的 type 必须是 noul / choice / score`),
    };
  }
  const instructions = raw.instructions;
  if (typeof instructions !== 'string' || instructions.trim() === '') {
    return { ok: false, error: invalid(`${label} 缺少 instructions`) };
  }
  if (instructions.length > DECIDE_INSTRUCTIONS_MAX) {
    return {
      ok: false,
      error: invalid(
        `${label} 的 instructions 超过 ${DECIDE_INSTRUCTIONS_MAX} 字符上限`,
      ),
    };
  }
  const criteria = raw.criteria;
  if (type === 'choice') {
    if (!isPlainObject(criteria)) {
      return {
        ok: false,
        error: invalid(`${label} 是 choice 题，必须给选项映射`),
      };
    }
    const options = Object.keys(criteria);
    if (
      options.length < DECIDE_CHOICE_MIN ||
      options.length > DECIDE_CHOICE_MAX
    ) {
      return {
        ok: false,
        error: invalid(
          `${label} 候选取值必须在 ${DECIDE_CHOICE_MIN}–${DECIDE_CHOICE_MAX} 之间`,
        ),
      };
    }
    for (const option of options) {
      if (option.trim() === '' || typeof criteria[option] !== 'string') {
        return {
          ok: false,
          error: invalid(`${label} 选项必须是「非空名 → 文字描述」`),
        };
      }
    }
    return {
      ok: true,
      question: {
        type,
        source: {
          type,
          instructions,
          criteria: criteria as JsonValue,
        },
        options,
        levels: 0,
      },
    };
  }
  if (type === 'score') {
    if (
      !Array.isArray(criteria) ||
      criteria.length < DECIDE_SCORE_LEVELS_MIN ||
      criteria.length > DECIDE_SCORE_LEVELS_MAX
    ) {
      return {
        ok: false,
        error: invalid(
          `${label} 必须是 ${DECIDE_SCORE_LEVELS_MIN}–${DECIDE_SCORE_LEVELS_MAX} 档数组`,
        ),
      };
    }
    for (const level of criteria) {
      if (typeof level !== 'string' || level.trim() === '') {
        return { ok: false, error: invalid(`${label} 档位必须是非空文字`) };
      }
    }
    return {
      ok: true,
      question: {
        type,
        source: { type, instructions, criteria: criteria as JsonValue },
        options: [],
        levels: criteria.length,
      },
    };
  }
  if (criteria !== undefined) {
    if (!isPlainObject(criteria)) {
      return {
        ok: false,
        error: invalid(`${label} 的 noul criteria 必须是对象`),
      };
    }
    for (const key of Object.keys(criteria)) {
      if (typeof criteria[key] !== 'string') {
        return {
          ok: false,
          error: invalid(`${label} 的 noul criteria 取值必须是文字`),
        };
      }
    }
  }
  return {
    ok: true,
    question: {
      type,
      source: {
        type,
        instructions,
        ...(criteria === undefined ? {} : { criteria: criteria as JsonValue }),
      },
      options: [],
      levels: 0,
    },
  };
}

/** 校验 batch 入参；任何不合规返回 invalid-arguments，不抛错。 */
export function planBatch(
  args: unknown,
): { ok: true; plan: BatchPlan } | { ok: false; error: DecisionErrorEnvelope } {
  if (!isPlainObject(args)) {
    return { ok: false, error: invalid('batch 入参必须是对象（groups）') };
  }
  const rawGroups = args.groups;
  if (
    !Array.isArray(rawGroups) ||
    rawGroups.length < BATCH_GROUPS_MIN ||
    rawGroups.length > BATCH_GROUPS_MAX
  ) {
    return {
      ok: false,
      error: invalid(
        `groups 必须有 ${BATCH_GROUPS_MIN}–${BATCH_GROUPS_MAX} 组`,
      ),
    };
  }
  const groups: BatchGroupPlan[] = [];
  for (let index = 0; index < rawGroups.length; index += 1) {
    const raw = rawGroups[index];
    if (!isPlainObject(raw)) {
      return { ok: false, error: invalid(`第 ${index} 组必须是对象`) };
    }
    const questionId =
      typeof raw.questionId === 'string' && raw.questionId.trim() !== ''
        ? raw.questionId
        : `g${index}`;
    const questionResult = planBatchQuestion(
      raw.question,
      `第 ${index} 组 question`,
    );
    if (!questionResult.ok) return { ok: false, error: questionResult.error };
    const texts = raw.texts;
    if (
      !Array.isArray(texts) ||
      texts.length < BATCH_TEXTS_MIN ||
      texts.length > BATCH_TEXTS_MAX
    ) {
      return {
        ok: false,
        error: invalid(
          `第 ${index} 组 texts 必须有 ${BATCH_TEXTS_MIN}–${BATCH_TEXTS_MAX} 条`,
        ),
      };
    }
    if (texts.some((text) => typeof text !== 'string')) {
      return {
        ok: false,
        error: invalid(`第 ${index} 组 texts 必须全是字符串`),
      };
    }
    groups.push({
      groupIndex: index,
      questionId,
      question: { id: 'q', ...questionResult.question },
      texts: texts as string[],
    });
  }
  return { ok: true, plan: { groups } };
}

// ── 单行判定 ────────────────────────────────────────────────────────

interface RowInput {
  group: BatchGroupPlan;
  index: number;
  text: string;
  signal?: AbortSignal;
}

interface RowOutput {
  index: number;
  text: string;
  status: 'ok' | 'error';
  answer: DecideAnswer | null;
  error: {
    code: DecisionErrorCode;
    message: string;
    retryable: boolean;
  } | null;
}

function buildBatchState(
  group: BatchGroupPlan,
  rowQid: string,
  text: string,
): JsonValue {
  const source = group.question.source;
  const parts: JudgementPromptParts = {
    purpose: source.instructions,
    constraints: [
      'Judge only the single TEXT below; never infer across other rows.',
      'Return only a typed value; never echo the input text or add prose.',
    ],
    actions: [`${rowQid}: ${source.type} judgement on the TEXT below`],
    detail: `TEXT: ${text}`,
  };
  return { message: buildJudgementPrompt(parts) } as JsonValue;
}

async function runRow(
  input: RowInput,
  deps: DecisionCallDeps,
): Promise<RowOutput> {
  const { group, index, text } = input;
  // 每行独立账本条目，questionId = {组questionId}#{行号}（契约 §8.2）。
  const rowQid = `${group.questionId}#${index}`;
  const result = await runDecisionCall(deps, {
    tool: BATCH_TOOL,
    state: buildBatchState(group, rowQid, text),
    questions: { [rowQid]: group.question.source },
    questionSummaries: { [rowQid]: text },
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (!result.ok) {
    return {
      index,
      text, // 原样上报，绝不改写
      status: 'error',
      answer: null,
      error: {
        code: result.error.code,
        message: result.error.message,
        retryable: result.error.retryable,
      },
    };
  }
  const qidAnswer = result.answers[rowQid];
  const decideQuestion: DecideQuestionPlan = {
    id: rowQid,
    type: group.question.type,
    instructions: group.question.source.instructions,
    criteria: group.question.source.criteria,
    options: group.question.options,
    levels: group.question.levels,
  };
  const answer = mapAnswerToDecideAnswer(decideQuestion, qidAnswer);
  if (answer.status === 'dropped') {
    return {
      index,
      text,
      status: 'error',
      answer: null,
      error: {
        code: 'model-invalid-response',
        message: '分值或取值非法/缺失，行被丢弃',
        retryable: true,
      },
    };
  }
  return { index, text, status: 'ok', answer, error: null };
}

/** 有界并发 worker pool：并发数 ≤ limit，结果等长同序。 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const effective = Math.max(1, Math.min(limit, items.length));
  async function loop(): Promise<void> {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await worker(items[current], current);
    }
  }
  const workers = Array.from({ length: effective }, () => loop());
  await Promise.all(workers);
  return results;
}

function errorBody(error: DecisionErrorEnvelope): Record<string, JsonValue> {
  return { ok: false, error: error as unknown as JsonValue };
}

function unexpectedErrorBody(thrown: unknown): Record<string, JsonValue> {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return errorBody(
    decisionError('model-call-failed', `工具内部异常：${message}`, {
      details: { stage: 'unexpected' },
    }),
  );
}

// ── 主流程 ──────────────────────────────────────────────────────────

export async function runBatch(
  args: unknown,
  exec: { signal?: AbortSignal },
  deps: DecisionCallDeps,
): Promise<Record<string, JsonValue>> {
  const planned = planBatch(args);
  if (!planned.ok) return errorBody(planned.error);

  // 预检守卫（契约 §1.3，fail-closed）：批量工具先整体过一道守卫，
  // 不把「未配置/未验证」摊到每一行的账本里刷屏。
  let config: ResolvedToolsConfig;
  try {
    config = deps.readConfig();
  } catch {
    return errorBody(
      decisionError('model-call-failed', '读取决策配置失败', {
        details: { stage: 'read-config' },
      }),
    );
  }
  let snapshot: VerifySnapshot | undefined;
  try {
    snapshot = deps.getVerifySnapshot();
  } catch {
    return errorBody(
      decisionError(
        'model-verify-failed',
        '验证状态读取失败，请先在设置页重新验证',
      ),
    );
  }
  const guardError =
    checkToolEnabled(config, BATCH_TOOL) ?? checkModelReady(config, snapshot);
  if (guardError) return errorBody(guardError);

  // 展平成 (组, 行) 任务列表，一次有界并发调度所有行。
  const tasks: RowInput[] = [];
  for (const group of planned.plan.groups) {
    for (let index = 0; index < group.texts.length; index += 1) {
      tasks.push({
        group,
        index,
        text: group.texts[index],
        ...(exec.signal === undefined ? {} : { signal: exec.signal }),
      });
    }
  }
  const rows = await mapBounded(tasks, BATCH_CONCURRENCY, (task) =>
    runRow(task, deps),
  );

  let cursor = 0;
  let degraded = false;
  const results = planned.plan.groups.map((group) => {
    const groupRows = rows.slice(cursor, cursor + group.texts.length);
    cursor += group.texts.length;
    if (groupRows.some((row) => row.status === 'error')) degraded = true;
    return {
      groupIndex: group.groupIndex,
      questionId: group.questionId,
      rows: groupRows as unknown as JsonValue,
    };
  });

  return {
    ok: true,
    results: results as unknown as JsonValue,
    concurrency: BATCH_CONCURRENCY,
    degraded,
  };
}

/** 创建 decision_batch 工具定义（deps 由插件入口注入）。 */
export function createBatchTool(deps: DecisionCallDeps): ToolDefinition {
  return defineTool({
    name: BATCH_TOOL,
    description: BATCH_DESCRIPTION,
    parameters: BATCH_PARAMETERS,
    output: BATCH_OUTPUT,
    async execute(args: unknown, exec: ToolRunContext): Promise<BatchOutput> {
      try {
        return (await runBatch(
          args,
          { signal: exec.signal },
          deps,
        )) as unknown as BatchOutput;
      } catch (thrown) {
        return unexpectedErrorBody(thrown) as unknown as BatchOutput;
      }
    },
  }) as ToolDefinition;
}
