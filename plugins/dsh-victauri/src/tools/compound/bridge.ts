/**
 * compound 批桥接：COMPOUND_TOOL_SPECS → REST 桥工具（复用 standalone bridge 工厂）。
 *
 * 复合工具与 standalone 共用同一条透传路径（callTool + 错误归一 + toRecord），
 * 无别名/截图特判需求——ARG_ALIASES 只覆盖 eval_js/query_db，不命中本批。
 */
import type { VictauriClient } from '../../client.ts';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import { COMPOUND_TOOL_SPECS, COMPOUND_TOOL_COUNT } from './catalog.ts';
import {
  createStandaloneTools,
  type BridgeDeps,
} from '../standalone/bridge.ts';

export type { BridgeDeps };

/** 构建 15 个 compound 桥工具（deps 注入连接获取函数）。 */
export function createCompoundTools(deps: BridgeDeps): ToolDefinition[] {
  return createStandaloneTools(COMPOUND_TOOL_SPECS, deps);
}

/** 供装配层复用的重导出（保持 compound 批自包含入口）。 */
export { COMPOUND_TOOL_SPECS, COMPOUND_TOOL_COUNT };

/** 客户端类型重导出（装配方类型标注用）。 */
export type { VictauriClient };
