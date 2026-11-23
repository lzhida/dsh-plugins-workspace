/**
 * 板错误码与错误类型——工具层与板服务层共用的唯一真源。
 *
 * 为什么放在本地层：本地扩展（src/local/）不得依赖 host/tools.ts（那会把宿主
 * @deepseek-ai/* 的类型拉进本包的严格 tsconfig 检查范围），因此错误码与错误
 * 类型定义在这里，由上游 host/tools.ts 反向引用本文件，保证「同一份码表」。
 */

/** 稳定错误码：错误消息以该码开头，供路由层结构化映射。 */
export const ERR = {
  notReady: 'taskboard_not_ready',
  notFound: 'not_found',
  versionConflict: 'version_conflict',
  workspaceMismatch: 'workspace_mismatch',
  invalidTransition: 'invalid_transition',
  forbidden: 'forbidden',
  requiresAgent: 'unauthorized_actor',
  invalidInput: 'invalid_input',
} as const;

/** 失败码类型（ERR 各值的联合）。 */
export type BoardErrorCode = (typeof ERR)[keyof typeof ERR];

/**
 * 带稳定错误码的失败：消息形状为 `Error: <code>: <detail>`，与上游
 * ToolError 逐字一致（不覆写 name，name 仍为 'Error'）。
 */
export class BoardError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`Error: ${code}: ${detail}`);
  }
}
