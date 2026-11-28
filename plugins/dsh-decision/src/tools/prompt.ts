/**
 * 决策工具系列的 prompt 组装与 token 估算。
 *
 * 契约来源：docs/decision-tools-contract.md §11（Tool 设计纪律）。
 * - D1 最小上下文优先：PURPOSE → CONSTRAINTS → ACTIONS → DETAIL，细节后置。
 * - D2 关键约束写在动作前：CONSTRAINTS 段必须排在 ACTIONS 之前。
 * - D5 每条事实只说一次：调用方给的 DETAIL 原文只在这里出现一次。
 * - D6 改完量首回合 prompt token 差：estimatePromptTokens 供测试与评论取证。
 */

import type { JsonValue } from '../systemone/types.ts';

/** 一次判定需要的四段上下文（顺序即拼装顺序，勿随意调整）。 */
export interface JudgementPromptParts {
  /** 一句话说明这次判定要干什么（PURPOSE）。 */
  purpose: string;
  /** 硬约束：模型必须遵守的边界（CONSTRAINTS，排在动作前）。 */
  constraints: string[];
  /** 可执行的动作清单（ACTIONS，每项一句，尽量短）。 */
  actions: string[];
  /** 调用方给的原始上下文（DETAIL，全文只出现一次）。 */
  detail: string;
}

/**
 * 组装判定 prompt。
 *
 * 只做纯字符串拼接，不做任何裁剪或改写——调用方给的 detail 原样保留，
 * 便于审计「模型看到的到底是什么」。
 */
export function buildJudgementPrompt(parts: JudgementPromptParts): string {
  const lines: string[] = [];
  lines.push(`PURPOSE: ${parts.purpose}`);
  lines.push('CONSTRAINTS:');
  for (const constraint of parts.constraints) {
    lines.push(`- ${constraint}`);
  }
  lines.push('ACTIONS:');
  for (const action of parts.actions) {
    lines.push(`- ${action}`);
  }
  lines.push('DETAIL:');
  lines.push(parts.detail);
  return lines.join('\n');
}

/**
 * 把调用方给的 state（字符串或对象）压成一行文本。
 *
 * 对象一律 JSON 序列化——决策模型的 state 接受结构化输入，但我们只用
 * `{ message }` 一种形状，保持与本地真实服务示例同构。
 */
export function stringifyDetail(detail: string | JsonValue): string {
  if (typeof detail === 'string') {
    return detail;
  }
  try {
    return JSON.stringify(detail);
  } catch {
    // 循环引用等不可序列化输入：退化成类型标记，绝不抛错打断工具。
    return '[unserializable detail]';
  }
}

/**
 * 粗估 token 数：ASCII/中文混排下按「4 字符 ≈ 1 token」估算。
 *
 * 只用于 D6 的「首回合 prompt token 差」对比，不追求与真实分词器一致，
 * 因此刻意保持零依赖、可复现。
 */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
