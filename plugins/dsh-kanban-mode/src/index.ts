/**
 * dsh-kanban-mode 插件入口：向宿主 agentPresets 注册表注册「看板模式」预设，
 * 并向宿主 skills 注册表注册内嵌建卡 skill（kanban-task-create）。
 *
 * 为什么是编程式注册而不是 cordis.patch.yml 里的声明式预设行：
 *   - 宿主 `@deepseek-ai/dsh-agent-preset-registry` 的 `register()` 对重复 id 直接抛
 *     `Duplicate agent preset: <id>`。声明式预设行与编程式注册互斥，同一个 id 只能
 *     有一条路径，所以本包在 patch 里**只插插件行**，预设在运行时注册；
 *   - 声明式 YAML 的 `!!js <expr>` 在编程式注册里用 `{ __jsExpr: '<expr>' }` 表达，
 *     语义一致（loader 的 Entry._resolveDisabled 与 internal/config 插值都认这个节点）。
 *
 * 内嵌 skill 为什么也在根层注册而不是塞进预设行集：根层注册的 skill 对预设
 * 会话同样可见（宿主工具 / 技能分层机制），dsh-patent 即此先例；预设里再挂
 * 一个 skill 入口行反而会在预设作用域重复注册。
 *
 * 宿主服务一律用**本地窄接口**声明（不 import 宿主 @deepseek-ai 运行时包）：
 * 构建产物因此零运行时 @deepseek-ai 引用，实体安装不会顶替宿主版本。
 *
 * @module dsh-kanban-mode
 */

import {
  buildKanbanPresetConfig,
  KANBAN_PRESET_ID,
  KANBAN_PRESET_NAME,
} from './preset-def.ts';
import {
  describeError,
  registerKanbanTaskCreateSkill,
} from './skill/register.ts';
import type { SkillsService } from './skill/register.ts';
import { registerKanbanTools } from './tools/register.ts';
import type { ToolsService } from './tools/register.ts';
import { createHarvestWatcher } from './harvest/watcher.ts';

/** 插件名（宿主 loader 依赖的标识）。 */
export const name = 'dsh-kanban-mode';

/** 依赖的宿主服务：预设注册表 + skill 注册表 + tools 注册表（缺失时降级，不崩）。 */
export const inject = ['agentPresets', 'skills', 'tools'] as const;

/** 宿主 agentPresets 服务的本地窄接口。 */
export interface AgentPresetsService {
  /** 注册一个预设定义；重复 id 会抛 `Duplicate agent preset: <id>`。 */
  register(definition: unknown): Promise<unknown>;
}

/** 插件上下文（本地窄接口，只声明本插件真正用到的服务）。 */
export interface KanbanModeContext {
  /** 预设注册表；服务缺失时降级为「只打日志」。 */
  agentPresets?: AgentPresetsService;
  /** skill 注册表；服务缺失时内嵌 skill 只 warn 不注册。 */
  skills?: SkillsService;
  /** 宿主 tools 注册表；服务缺失时三工具只 warn 不注册。 */
  tools?: ToolsService;
  /** cordis Context 的服务软读取（工具 execute 时惰性取板服务用）。 */
  get?(name: string): unknown;
  /**
   * cordis 副作用注册（验收联动 watcher 的启停走这条路径）。
   *
   * 回调立即执行，返回的清理函数在插件卸载时被 cordis 自动调用——
   * watcher 的停表就挂在这里。
   */
  effect?(fn: () => (() => void) | void): void;
}

/**
 * 挂载本插件：注册「看板模式」预设 + 内嵌建卡 skill + 看板模式三工具。
 *
 * 降级口径：`agentPresets` 服务缺失 → warn 后继续（skill / 工具注册独立
 * 进行）；预设注册抛错（典型是 id 已被占用）→ 只 warn，不把异常抛给宿主
 * 启动流程；skills / tools 服务缺失或注册失败 → 同样只 warn（见
 * skill/register.ts 与 tools/register.ts）。
 * 三个注册互不连累：一方不可用不影响其余照常注册。
 *
 * 预设内容全部内置，本插件不读取 loader 投影的用户配置，因此不声明第二个参数。
 * @param ctx - 插件上下文（agentPresets + skills + tools 注入）。
 */
export async function apply(ctx: KanbanModeContext): Promise<void> {
  console.log(`[${name}] plugin loaded`);
  const presets = ctx.agentPresets;
  if (presets === undefined) {
    console.warn(
      `[${name}] agentPresets 服务不可用，跳过「${KANBAN_PRESET_NAME}」预设注册`,
    );
  } else {
    try {
      await presets.register(buildKanbanPresetConfig());
      console.log(
        `[${name}] preset registered: ${KANBAN_PRESET_ID} (${KANBAN_PRESET_NAME})`,
      );
    } catch (error) {
      console.warn(
        `[${name}] 注册「${KANBAN_PRESET_NAME}」预设失败：${describeError(error)}`,
      );
    }
  }
  // 内嵌 skill 注册：发生在预设注册之后、独立于预设注册成败；
  // skills.register 无清理函数，不需要 ctx.effect 包裹（对齐 dsh-patent 先例），
  // 注册失败仅 console.warn 不抛。
  await registerKanbanTaskCreateSkill(ctx);
  // 看板模式三工具注册：独立于预设 / skill 注册成败；工具 execute 时才
  // 惰性软读取 dsh-taskboard 板服务，注册期不解析（见 tools/board-contract.ts）。
  registerKanbanTools(ctx);
  // 验收联动 watcher：任务状态「进入」done → 自动收割；「进入」canceled →
  // 自动丢弃。板服务在轮询时软读取（注册期不解析），服务缺席时静默降级。
  startHarvestWatcher(ctx);
}

/**
 * 接线验收联动 watcher（启动 / 停止）。
 *
 * 为什么挂 ctx.effect：cordis 会在插件卸载时自动调用返回的清理函数，
 * 停表不必手写卸载钩子（对齐仓库既有 ctx.effect 用法）。
 *
 * 板服务与项目注册表都在 watcher 的**轮询时**软读取——注册期解析会让
 * watcher 在板服务尚未就绪时直接报废。
 */
function startHarvestWatcher(ctx: KanbanModeContext): void {
  try {
    const watcher = createHarvestWatcher({ context: ctx });
    ctx.effect?.(() => {
      watcher.start();
      return () => {
        watcher.stop();
      };
    });
  } catch (error) {
    console.warn(
      `[${name}] 验收联动 watcher 启动失败：${describeError(error)}`,
    );
  }
}

export {
  BOARD_CONTEXT_ENTRY_NAME,
  BOARD_CONTEXT_ROW_ID,
  buildKanbanPresetConfig,
  KANBAN_PRESET_DESCRIPTION,
  KANBAN_PRESET_ID,
  KANBAN_PRESET_NAME,
  KANBAN_PRESET_ORDER,
  standardPluginRows,
  type PresetDefinition,
  type PresetPluginRow,
} from './preset-def.ts';
export {
  buildKanbanTaskCreateSkillSpec,
  describeError,
  registerKanbanTaskCreateSkill,
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
  type BundledSkillSpec,
  type SkillsService,
} from './skill/register.ts';
export {
  KANBAN_TOOL_NAMES,
  registerKanbanTools,
  type KanbanToolsContext,
  type ToolsService,
} from './tools/register.ts';
