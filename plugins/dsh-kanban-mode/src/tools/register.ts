/**
 * 看板模式工具的注册入口。
 *
 * 机制：工具规格照 vendored sdk 垫片（plugins/dsh-taskboard/src/host/sdk.ts）
 * 的 defineTool 结构兼容重实现（见 define-tool.ts），经宿主 tools.register
 * 逐个注册——与上游 registerTaskboardTools 的注册面完全同形
 * （ToolDefinition{name,description,parameters,output:{schema,render},execute}）。
 *
 * 工具集：三个看板只读/调度工具（kanban_*）+ 一个收割工具
 * （taskboard_harvest，收敛任务分支成果回目标分支；工具名不挂 kanban_ 前缀，
 * 因为它服务的是宿主根层的 taskboard_* 工具族，与之同形同源）。
 *
 * 降级口径（对齐 src/index.ts 既有容错风格）：tools 服务缺失 → console.warn
 * 后跳过全部工具注册（预设与 skill 注册互不连累）；单个工具 register 抛错
 * → 只 warn 该工具，其余照常注册；全部成功 → 打固定成功日志。
 *
 * @module dsh-kanban-mode/tools/register
 */

import { buildHarvestTool } from './harvest.ts';
import { buildPlanCheckTool } from './plan-check.ts';
import { buildReadyCardsTool } from './ready-cards.ts';
import { buildScheduleRunTool } from './schedule-run.ts';
import { describeError } from '../skill/register.ts';

/** 工具注册名（与实现文件一一对应）。 */
export const KANBAN_TOOL_NAMES = [
  'kanban_ready_cards',
  'kanban_plan_check',
  'kanban_schedule_run',
  'taskboard_harvest',
] as const;

/** 宿主 tools 服务的本地窄接口（照上游 ToolContextFace.register 面）。 */
export interface ToolsService {
  /** 注册一个工具定义（结构由宿主 registry 消费）。 */
  register(tool: unknown): unknown;
}

/** 工具注册上下文（本地窄接口：tools 注入 + ctx.get 软读取面）。 */
export interface KanbanToolsContext {
  /** 宿主 tools 注册表；服务缺失时本模块降级为「只打日志」。 */
  tools?: ToolsService;
  /** cordis Context 的服务软读取（工具 execute 时惰性取板服务用）。 */
  get?(name: string): unknown;
}

/**
 * 把看板模式工具注册到宿主 tools 注册表。
 *
 * 降级口径：tools 服务缺失 → console.warn 后 return（不注册、不抛）；
 * 单个工具注册失败 → warn 该工具后继续注册其余工具；全部成功 →
 * `[dsh-kanban-mode] registered N kanban tools`。
 * @param ctx - 插件上下文（tools 注入 + 软读取面）。
 */
export function registerKanbanTools(ctx: KanbanToolsContext): void {
  const tools = ctx.tools;
  if (tools === undefined) {
    console.warn('[dsh-kanban-mode] tools 服务不可用，跳过看板模式工具注册');
    return;
  }
  const definitions = [
    buildReadyCardsTool(ctx),
    buildPlanCheckTool(),
    buildScheduleRunTool(ctx),
    buildHarvestTool(ctx),
  ];
  let registered = 0;
  for (const definition of definitions) {
    try {
      tools.register(definition);
      registered += 1;
    } catch (error) {
      console.warn(
        `[dsh-kanban-mode] 注册工具 ${definition.name} 失败：${describeError(error)}`,
      );
    }
  }
  console.log(`[dsh-kanban-mode] registered ${registered} kanban tools`);
}
