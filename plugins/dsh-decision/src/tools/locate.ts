/**
 * decision_locate：图像内找目标 → 归一化坐标框（决策工具系列 5/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §3.5（入参/出参/定稿口径）、
 * §2.5（图像 assets + 占位符 + TypeSafe-Danger-Zone-Images 头 + box
 * 坐标语义：四条边是图像高度(top/bottom)与宽度(left/right)的分数 0..1）、
 * §2.6（上游 400 含 box/asset 字样 → model-unsupported-capability）、
 * §11（Tool 设计纪律 D1/D2/D4/D5）。
 *
 * fail-closed：上游不支持 box（题被丢弃 / 400）、返回非 box 答案、坐标
 * 越界或倒置，一律返回契约错误码——绝不夹取坐标，绝不瞎猜。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';
import type {
  InferValue,
  ToolDefinition,
  ToolRunContext,
} from '@deepseek-ai/dsh-tools';

import type { DecisionToolName, ResolvedToolsConfig } from '../config/index.ts';
import {
  checkToolEnabled,
  runDecisionCall,
  type DecisionCallDeps,
} from '../runtime/index.ts';
import {
  decisionError,
  type DecisionErrorEnvelope,
} from '../systemone/errors.ts';
import type {
  JsonValue,
  SystemOneAsset,
  SystemOneParsedAnswer,
  SystemOneQuestion,
} from '../systemone/types.ts';
import { buildJudgementPrompt, estimatePromptTokens } from './prompt.ts';

export const LOCATE_TOOL = 'decision_locate' as const;

export const LOCATE_TARGET_MAX = 300;
export const LOCATE_IMAGE_FORMATS = ['png', 'jpg', 'jpeg'] as const;
export type LocateImageFormat = (typeof LOCATE_IMAGE_FORMATS)[number];

/**
 * 图像占位符（契约 §2.5）：出现在 instructions 里的占位符会被上游替换
 * 成 assets 里的图像。选一个不太可能撞上普通文本的串，避免误替换。
 */
export const LOCATE_IMAGE_PLACEHOLDER = 'DECISION-LOCATE-IMAGE-01';

export const LOCATE_DEFAULT_QUESTION_ID = 'target';

export const LOCATE_DESCRIPTION = [
  'Purpose: locate a described target inside a provided image and return a normalized bounding box.',
  'Constraints: never guess coordinates; never clamp out-of-range coordinates; if the model or deployment cannot process images, the tool returns a structured error instead of a box.',
  'Actions: exactly one box question over one image; output only the box, derived center/width/height and confidence.',
  'Output is bounded: { ok, box{top,bottom,left,right}, center{x,y}, width, height, confidence, decisionId, source } or { ok:false, error } — never image data, never reasoning prose.',
].join(' ');

export const LOCATE_PARAMETERS = {
  image: {
    type: 'object' as const,
    required: true as const,
    description:
      '待定位图像。format 仅接受 png/jpg/jpeg；dataBase64 必须是标准 base64（可带 data URI 前缀，工具层剥掉），≤16MiB。',
    additionalProperties: true as const,
    properties: {
      format: {
        type: 'string' as const,
        required: true as const,
        description: '图像格式：png | jpg | jpeg。',
      },
      dataBase64: {
        type: 'string' as const,
        required: true as const,
        description: '图像 base64 内容；标准字母表 + 等号补位，无换行。',
      },
    },
  },
  target: {
    type: 'string' as const,
    required: true as const,
    description: '要找的目标描述（≤300 字符），例如「红色灭火器」。',
  },
  questionId: {
    type: 'string' as const,
    description: `可选，账本条目的问题标识，缺省 ${LOCATE_DEFAULT_QUESTION_ID}。`,
  },
} as const;

const LOCATE_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true as const,
  properties: {
    ok: { type: 'boolean' as const, required: true as const },
    box: {
      type: 'object' as const,
      additionalProperties: false as const,
      description:
        '归一化坐标框（0..1；top/bottom 为高度分数，left/right 为宽度分数）。',
      properties: {
        top: { type: 'number' as const, required: true as const },
        bottom: { type: 'number' as const, required: true as const },
        left: { type: 'number' as const, required: true as const },
        right: { type: 'number' as const, required: true as const },
      },
    },
    center: {
      type: 'object' as const,
      additionalProperties: false as const,
      description: 'box 中心点（归一化 0..1）。',
      properties: {
        x: { type: 'number' as const, required: true as const },
        y: { type: 'number' as const, required: true as const },
      },
    },
    width: { type: 'number' as const, description: 'right − left（归一化）.' },
    height: { type: 'number' as const, description: 'bottom − top（归一化）.' },
    confidence: {
      oneOf: [{ type: 'number' as const }, { type: 'null' as const }] as const,
      description: '上游置信度；缺失时为 null（不臆造）。',
    },
    decisionId: {
      oneOf: [{ type: 'string' as const }, { type: 'null' as const }] as const,
      description: '账本条目 id（recheck 可复检）。',
    },
    source: {
      type: 'string' as const,
      description: 'decision-model | llm-fallback-judge。',
    },
    error: {
      type: 'object' as const,
      additionalProperties: true as const,
      description: '失败信封 { code, message, retryable, details }。',
      properties: {},
    },
  },
} as const;

export type LocateOutput = InferValue<typeof LOCATE_OUTPUT_SCHEMA>;

export const LOCATE_OUTPUT = {
  schema: LOCATE_OUTPUT_SCHEMA,
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
};

// ── 输入校验与请求组装 ───────────────────────────────────────────────

export interface LocatePlan {
  format: LocateImageFormat;
  dataBase64: string;
  target: string;
  questionId: string;
}

function isBase64Body(text: string): boolean {
  return /^[A-Za-z0-9+/=]+$/.test(text);
}

/** 剥掉可选的 data URI 前缀（契约 §2.5 上线格式必须无前缀）。 */
export function stripDataUriPrefix(dataBase64: string): string {
  const marker = ';base64,';
  const index = dataBase64.indexOf(marker);
  if (dataBase64.toLowerCase().startsWith('data:') && index >= 0) {
    return dataBase64.slice(index + marker.length);
  }
  return dataBase64;
}

export function planLocate(
  args: unknown,
):
  { ok: true; plan: LocatePlan } | { ok: false; error: DecisionErrorEnvelope } {
  if (typeof args !== 'object' || args === null) {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'locate 入参必须是对象'),
    };
  }
  const raw = args as {
    image?: unknown;
    target?: unknown;
    questionId?: unknown;
  };
  const image = raw.image as
    { format?: unknown; dataBase64?: unknown } | undefined;
  if (typeof image !== 'object' || image === null) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        'image 必须是 { format, dataBase64 } 对象',
      ),
    };
  }
  const format = image.format;
  if (
    typeof format !== 'string' ||
    !(LOCATE_IMAGE_FORMATS as readonly string[]).includes(format)
  ) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        'image.format 仅接受 png / jpg / jpeg',
      ),
    };
  }
  const rawBase64 = image.dataBase64;
  if (typeof rawBase64 !== 'string' || rawBase64.trim() === '') {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        'image.dataBase64 必须是非空 base64 字符串',
      ),
    };
  }
  const dataBase64 = stripDataUriPrefix(rawBase64);
  if (/\s/.test(dataBase64) || !isBase64Body(dataBase64)) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        'image.dataBase64 必须是标准 base64（无换行、无 data: 前缀内容）',
      ),
    };
  }
  const target = raw.target;
  if (typeof target !== 'string' || target.trim() === '') {
    return {
      ok: false,
      error: decisionError('invalid-arguments', 'target 不能为空'),
    };
  }
  if (target.length > LOCATE_TARGET_MAX) {
    return {
      ok: false,
      error: decisionError(
        'invalid-arguments',
        `target 最多 ${LOCATE_TARGET_MAX} 字符（实际 ${target.length}）`,
      ),
    };
  }
  const questionId =
    typeof raw.questionId === 'string' && raw.questionId.trim() !== ''
      ? raw.questionId
      : LOCATE_DEFAULT_QUESTION_ID;
  return {
    ok: true,
    plan: {
      format: format as LocateImageFormat,
      dataBase64,
      target,
      questionId,
    },
  };
}

export function buildLocateQuestions(
  plan: LocatePlan,
): Record<string, SystemOneQuestion> {
  return {
    [plan.questionId]: {
      type: 'box',
      instructions: `Locate the following target inside the ${LOCATE_IMAGE_PLACEHOLDER} image and answer with its bounding box: ${plan.target}`,
    },
  };
}

export function buildLocateAssets(
  plan: LocatePlan,
): Record<string, SystemOneAsset> {
  return {
    [LOCATE_IMAGE_PLACEHOLDER]: {
      type: 'image',
      format: plan.format,
      data_base64: plan.dataBase64,
    },
  };
}

export function buildLocateState(): string {
  return buildJudgementPrompt({
    purpose:
      'Return the normalized bounding box of a described target in an image.',
    constraints: [
      'Answer only with the box question; never output reasoning prose.',
      'Coordinates are fractions of image height (top/bottom) and width (left/right) in 0..1.',
    ],
    actions: [
      'Inspect the image referenced by the placeholder in the question instructions.',
      'Answer the single box question with the target bounding box.',
    ],
    detail: LOCATE_IMAGE_PLACEHOLDER,
  });
}

/**
 * D6 留痕用途：描述文案再优化时用它量首回合 prompt token 差
 * （与 decide/gate 的 estimate* 同口径，本卡未接入运行时，属预留导出）。
 */
export function estimateLocatePromptTokens(plan: LocatePlan): number {
  const state = buildLocateState();
  const question = buildLocateQuestions(plan);
  const instructions = question[plan.questionId]?.instructions ?? '';
  return estimatePromptTokens(state) + estimatePromptTokens(instructions);
}

// ── 坐标解析（fail-closed，绝不夹取）────────────────────────────────

export interface LocateBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function isUnit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

/**
 * 校验并解析 box：四边都在 0..1 且 bottom≥top、right≥left；越界/倒置
 * 一律 invalid（契约 §3.5：原样透传 + 派生，不得夹取掩盖错误）。
 */
export function parseLocateBox(
  answer: SystemOneParsedAnswer | undefined,
):
  | { ok: true; box: LocateBox; confidence: number | null }
  | { ok: false; reason: string } {
  if (answer === undefined) {
    return { ok: false, reason: '上游未返回该题（dropped）' };
  }
  if (answer.kind !== 'box') {
    return {
      ok: false,
      reason: `返回题型不符（期望 box，实际 ${answer.kind}）`,
    };
  }
  const { top, bottom, left, right } = answer.box;
  if (!isUnit(top) || !isUnit(bottom) || !isUnit(left) || !isUnit(right)) {
    return { ok: false, reason: '坐标超出 0..1 归一化值域' };
  }
  if (bottom < top || right < left) {
    return { ok: false, reason: '坐标框倒置（bottom<top 或 right<left）' };
  }
  return {
    ok: true,
    box: { top, bottom, left, right },
    confidence: answer.confidence,
  };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function deriveBoxGeometry(box: LocateBox): {
  center: { x: number; y: number };
  width: number;
  height: number;
} {
  return {
    center: {
      x: round4((box.left + box.right) / 2),
      y: round4((box.top + box.bottom) / 2),
    },
    width: round4(box.right - box.left),
    height: round4(box.bottom - box.top),
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────

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

export async function runLocate(
  args: unknown,
  exec: { signal?: AbortSignal },
  deps: DecisionCallDeps,
): Promise<Record<string, JsonValue>> {
  const planned = planLocate(args);
  if (!planned.ok) return errorBody(planned.error);
  const plan = planned.plan;

  const config: ResolvedToolsConfig = deps.readConfig();
  const disabled = checkToolEnabled(config, LOCATE_TOOL as DecisionToolName);
  if (disabled !== null) return errorBody(disabled);

  const state = buildLocateState();
  const questions = buildLocateQuestions(plan);
  const assets = buildLocateAssets(plan);

  const result = await runDecisionCall(deps, {
    tool: LOCATE_TOOL,
    state,
    questions,
    assets,
    questionSummaries: {
      [plan.questionId]: `定位目标：${plan.target}`,
    },
    ...(exec.signal === undefined ? {} : { signal: exec.signal }),
  });
  if (!result.ok) {
    // 契约 §3.5：上游不支持（400 含 box/asset 字样由 client 归一为
    // model-unsupported-capability）→ 原样透传，不产出坐标。
    return errorBody(result.error);
  }

  const answer = result.answers[plan.questionId];
  const parsed = parseLocateBox(answer);
  if (!parsed.ok) {
    // 区分「上游没给这一题」（= 部署不支持 box → model-unsupported-capability）
    // 与「上游给了但形状非法/题型不符」（= model-invalid-response 可重试）。
    const invalidByUpstream = result.invalidAnswers.some(
      (item) => item.questionId === plan.questionId,
    );
    const unsupported = answer === undefined && !invalidByUpstream;
    return errorBody(
      decisionError(
        unsupported ? 'model-unsupported-capability' : 'model-invalid-response',
        unsupported
          ? '上游未回答定位题：当前决策模型或部署可能不支持图像 box 题型'
          : `定位结果不可用：${parsed.reason}`,
        {
          retryable: !unsupported,
          details: {
            questionId: plan.questionId,
            reason: parsed.reason,
            dropped: unsupported,
          },
        },
      ),
    );
  }

  const geometry = deriveBoxGeometry(parsed.box);
  return {
    ok: true,
    box: { ...parsed.box } as unknown as JsonValue,
    center: geometry.center as unknown as JsonValue,
    width: geometry.width,
    height: geometry.height,
    confidence: parsed.confidence,
    decisionId: result.decisionIds[plan.questionId] ?? null,
    source: result.source,
  } as Record<string, JsonValue>;
}

/** 创建 decision_locate 工具定义（deps 由插件入口注入）。 */
export function createLocateTool(deps: DecisionCallDeps): ToolDefinition {
  return defineTool({
    name: LOCATE_TOOL,
    description: LOCATE_DESCRIPTION,
    parameters: LOCATE_PARAMETERS,
    output: LOCATE_OUTPUT,
    async execute(args: unknown, exec: ToolRunContext): Promise<LocateOutput> {
      try {
        const result = await runLocate(args, { signal: exec.signal }, deps);
        return result as unknown as LocateOutput;
      } catch (thrown) {
        return unexpectedErrorBody(thrown) as unknown as LocateOutput;
      }
    },
  }) as ToolDefinition;
}
