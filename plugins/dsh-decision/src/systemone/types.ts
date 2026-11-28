/**
 * systemone 决策接口的类型定义（决策工具系列 2/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §2（systemone 接口定稿）。
 *
 * 设计纪律（契约 §11 D2「参数规则写在参数上」）：
 * 这里只声明形状与取值域，规则说明写在字段注释上，不写进 tool description。
 *
 * 本目录不引入宿主类型（卡 2 要求）：JsonValue 自带最小实现，避免把
 * @deepseek-ai/dsh-util-values 变成运行时依赖。
 */

/** 最小 JSON 值类型（宿主同款形状，本地自带以免引入依赖）。 */
import type { DecisionErrorEnvelope } from './errors.ts';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** 四种题型（契约 §2.3）。 */
export type SystemOneQuestionType = 'noul' | 'choice' | 'score' | 'box';

/**
 * 单题定义。
 * - `noul`：yes/no；criteria 可选 `{ true: …, false: … }`。
 * - `choice`：criteria = 选项名 → 描述映射（1–255 项）。
 * - `score`：criteria = **有序**档位描述数组（2–10 档，建议 3–7）。
 * - `box`：定位题型；criteria 无意义。
 */
export interface SystemOneQuestion {
  type: SystemOneQuestionType;
  instructions: string;
  criteria?: JsonValue;
}

/** 图像资产（契约 §2.5）。key 是请求文本中出现的占位符。 */
export interface SystemOneAsset {
  type: 'image';
  format: 'png' | 'jpg' | 'jpeg';
  data_base64: string;
}

/** 请求体（契约 §2.2）：model + state + questions(map) + assets(可选)。 */
export interface SystemOneCallPayload {
  model: string;
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
  assets?: Record<string, SystemOneAsset>;
}

/** 上游 usage（契约 §2.4）。缺失时整体记 null，不臆造。 */
export interface SystemOneUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/** 解析后的答案（按题型区分；缺失的可选字段一律 null）。 */
export type SystemOneParsedAnswer =
  | {
      kind: 'noul';
      /** P(yes)，取值域 [0,1]。 */
      pYes: number;
      confidence: number | null;
      probabilities: Record<string, number> | null;
    }
  | {
      kind: 'choice';
      choice: string;
      confidence: number | null;
      probabilities: Record<string, number> | null;
    }
  | {
      kind: 'score';
      score: number;
      legend: string[];
      confidence: number | null;
      probabilities: number[] | null;
    }
  | {
      kind: 'box';
      /** 四条边为归一化坐标：top/bottom 是高度分数，left/right 是宽度分数。 */
      box: { top: number; bottom: number; left: number; right: number };
      confidence: number | null;
    };

/** 单题解析失败（该题被判为非法，不影响其他题）。 */
export interface SystemOneInvalidAnswer {
  questionId: string;
  reason: string;
}

/** 上游 usage 归一后的形状。 */
export interface SystemOneNormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

/** 一次成功调用的结果。 */
export interface SystemOneCallOk {
  ok: true;
  model: string | null;
  answers: Record<string, SystemOneParsedAnswer>;
  /** 上游未返回该题（丢弃）——不填默认值（契约 §2.4）。 */
  droppedQuestionIds: string[];
  /** 该题存在但形状非法。 */
  invalidAnswers: SystemOneInvalidAnswer[];
  usage: SystemOneNormalizedUsage | null;
  latencyMs: number;
}

/** 一次失败调用的结果（错误码已在 client 内归一）。 */
export interface SystemOneCallError {
  ok: false;
  error: DecisionErrorEnvelope;
  latencyMs: number;
}

export type SystemOneCallResult = SystemOneCallOk | SystemOneCallError;
