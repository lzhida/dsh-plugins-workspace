/**
 * 守卫层（决策工具系列 2/11）——fail-closed 显式报错。
 *
 * 契约来源：docs/decision-tools-contract.md §0/§1.3/§4。
 *
 * 与 ask-gate 的 fail-open 相反：本行任何模型依赖工具在
 * ①开关关闭 → `tool-disabled`、②配置不全 → `model-not-configured`、
 * ③未验证或验证已过期 → `model-verify-failed` 时都必须拒绝并原样报错，
 * 不猜、不降级、不放行。
 *
 * 错误优先级（契约 §1.3 定稿）：先判开关，再判模型配置。
 * 纯本地三工具（usage/history/calibrate）只受开关约束。
 */

import {
  DEFAULT_GATE_ALLOW_THRESHOLD,
  type DecisionToolName,
  LOCAL_ONLY_TOOLS,
  type ResolvedToolsConfig,
  toolSwitchOf,
} from '../config/decision-tools.ts';
import {
  decisionError,
  type DecisionErrorEnvelope,
} from '../systemone/errors.ts';

// ── 验证快照（进程内可信状态）────────────────────────────────────────

export interface VerifySnapshot {
  /** 验证通过时的配置指纹；配置三元组任一变更即失配。 */
  fingerprint: string;
  /** 验证成功时间（ISO）。 */
  verifiedAt: string;
}

/**
 * 配置指纹：FNV-1a 32bit 之上再叠长度，仅在内存比对用，
 * 绝不写日志/账本（apiKey 只参与散列，不落原文）。
 */
export function fingerprintOf(config: {
  systemoneBaseUrl: string;
  systemoneApiKey: string;
  systemoneModel: string;
}): string {
  const text = `${config.systemoneBaseUrl}${config.systemoneModel}${config.systemoneApiKey}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}

// ── 开关守卫 ─────────────────────────────────────────────────────────

/** 开关关闭 → tool-disabled；开启 → null（放行进入下一道守卫）。 */
export function checkToolEnabled(
  config: ResolvedToolsConfig,
  tool: DecisionToolName,
): DecisionErrorEnvelope | null {
  if (!toolSwitchOf(config, tool)) {
    return decisionError(
      'tool-disabled',
      `工具 ${tool} 未启用：请在设置页打开对应工具开关后重试`,
      { details: { tool } },
    );
  }
  return null;
}

// ── 模型守卫 ─────────────────────────────────────────────────────────

/**
 * 纯本地工具（契约 §1.3）：usage / history / calibrate 只读本地账本，
 * 不发模型调用，因此不受「模型已配置且已验证」约束——只受开关约束。
 */
export function isLocalOnlyTool(tool: DecisionToolName): boolean {
  return LOCAL_ONLY_TOOLS.includes(tool);
}

/** 该工具是否需要决策模型（纯本地工具返回 false）。 */
export function requiresModel(tool: DecisionToolName): boolean {
  return !isLocalOnlyTool(tool);
}

/** 配置三元组是否齐全。 */
export function isModelConfigured(config: ResolvedToolsConfig): boolean {
  return (
    config.systemoneBaseUrl !== '' &&
    config.systemoneApiKey !== '' &&
    config.systemoneModel !== ''
  );
}

/**
 * 模型依赖检查（fail-closed）：
 * 1. 三元组任一为空 → `model-not-configured`；
 * 2. 进程内没有「当前配置指纹」的验证成功记录 → `model-verify-failed`
 *    （含从未验证、重启后失忆、验证后改配置三种情形——一律要求重新验证）。
 * 通过返回 null。
 */
export function checkModelReady(
  config: ResolvedToolsConfig,
  snapshot: VerifySnapshot | undefined,
): DecisionErrorEnvelope | null {
  if (!isModelConfigured(config)) {
    return decisionError(
      'model-not-configured',
      '决策模型未配置完整（baseUrl / API key / model 任一为空），请先在设置页配置并验证',
    );
  }
  if (!snapshot || snapshot.fingerprint !== fingerprintOf(config)) {
    return decisionError(
      'model-verify-failed',
      '决策模型尚未验证或验证已过期（配置变更后需重新验证），请先在设置页通过「验证」后再使用',
    );
  }
  return null;
}

// ── gate 阈值 ────────────────────────────────────────────────────────

/**
 * gate 的允许阈值读取（契约 §6.7；3/11 gate 工具消费）。
 * resolveToolsConfig 已保证落域，这里只兜底语义默认。
 */
export function gateAllowThresholdOf(config: ResolvedToolsConfig): number {
  const value = config.gateAllowThreshold;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_GATE_ALLOW_THRESHOLD;
}
