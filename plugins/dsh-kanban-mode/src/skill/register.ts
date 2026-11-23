/**
 * 内嵌 skill（kanban-task-create）的注册逻辑。
 *
 * 为什么在插件根层注册而不是塞进预设行集：根层注册的 skill 对预设会话同样
 * 可见（宿主工具 / 技能分层机制），dsh-patent 即此先例；预设里再挂一个 skill
 * 入口行反而会在预设作用域重复注册。skills.register 没有返回清理函数，因此
 * 无需 ctx.effect 包裹，直接注册即可。
 *
 * 宿主 skills 服务用本地窄接口声明（不 import 宿主 @deepseek-ai 运行时包），
 * 容错口径与 src/index.ts 一致：服务缺失或注册失败都只 console.warn，不把
 * 异常抛给宿主启动流程。
 *
 * @module dsh-kanban-mode/skill/register
 */

import {
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
} from './skill-content.ts';

// 正文常量转发导出：调用方（入口 / 测试）从本模块取全量 skill 符号。
export {
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
} from './skill-content.ts';

/** 宿主 skills 服务的本地窄接口（dsh-skill 的 skills 注册表）。 */
export interface SkillsService {
  /** 注册一个 skill 规格；返回值 / 返回的 Promise 形状由宿主实现决定。 */
  register(spec: unknown): unknown | Promise<unknown>;
}

/** 内嵌 skill 的注册规格（宿主 dsh-skill 的 register 入参形状）。 */
export interface BundledSkillSpec {
  /** skill 注册名（会话内 `skill` 工具按此加载）。 */
  name: string;
  /** 一句话描述（何时使用；随 name 进入会话 skill 目录）。 */
  description: string;
  /** 来源标记：插件内置（随插件加载出现、随插件卸载注销）。 */
  source: 'bundled';
  /** skill 正文（模型加载后展开的指令全文）。 */
  content: string;
  /** 调用面：模型可按需加载、用户可点名加载。 */
  invocation: { modelInvocable: boolean; userInvocable: boolean };
}

/** skill 注册用的插件上下文（本地窄接口，只声明真正用到的服务）。 */
export interface SkillRegisterContext {
  /** skill 注册表；服务缺失时本模块降级为「只打日志」。 */
  skills?: SkillsService;
}

/**
 * 构造 kanban-task-create skill 的注册规格。
 * @returns 每次调用返回全新对象，避免调用方修改时污染共享常量。
 */
export function buildKanbanTaskCreateSkillSpec(): BundledSkillSpec {
  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  };
}

/**
 * 把任意异常压成一行可读文本（与 src/index.ts 原实现同形，供预设注册与
 * skill 注册两处共用）。
 * @param error - 捕获到的异常。
 * @returns 错误文本。
 */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把内嵌建卡 skill 注册到宿主 skills 注册表。
 *
 * 降级口径：`skills` 服务缺失 → console.warn 后 return（不注册、不抛）；
 * register 抛错（同步或返回的 Promise 被拒）→ console.warn，不把异常抛给
 * 宿主启动流程。
 * @param ctx - 插件上下文（skills 注入）。
 */
export async function registerKanbanTaskCreateSkill(
  ctx: SkillRegisterContext,
): Promise<void> {
  const skills = ctx.skills;
  if (skills === undefined) {
    console.warn(
      `[dsh-kanban-mode] skills 服务不可用，跳过 ${SKILL_NAME} 内嵌 skill 注册`,
    );
    return;
  }
  try {
    await skills.register(buildKanbanTaskCreateSkillSpec());
  } catch (error) {
    console.warn(
      `[dsh-kanban-mode] 注册 ${SKILL_NAME} 内嵌 skill 失败：${describeError(error)}`,
    );
  }
}
