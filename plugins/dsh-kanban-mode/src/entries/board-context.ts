/**
 * 看板上下文子路径入口（独立产物 dist/board-context.js）。
 *
 * 预设行 `'@zhidal/dsh-kanban-mode/board-context'` 指向本入口：预设挂载时，
 * 它向系统提示注册一个 order=185 的段落，内容是看板模式工作法八段。
 *
 * order 取 185 而不是上游 taskboard 的 180（PROTOCOL_SECTION_ORDER）：两段
 * 顺序固定，看板工作法排在任务协议段之后，读起来是「先讲怎么用看板，再讲
 * 看板工具的具体协议」。
 *
 * @module dsh-kanban-mode/board-context
 */

import { buildContext } from '../context-text.ts';

/** 插件名（宿主 loader 依赖的标识）。 */
export const name = 'kanban-board-context';

/** 依赖的宿主服务：系统提示装配器。 */
export const inject = ['systemPrompt'] as const;

/** 系统提示段落的唯一名（重复注册会抛错）。 */
export const SECTION_NAME = 'kanban-mode:context';

/** 系统提示段落的顺序（上游 taskboard 协议段是 180）。 */
export const SECTION_ORDER = 185;

/** 宿主 systemPrompt 服务的本地窄接口。 */
export interface SystemPromptService {
  /** 注册一个提示段落，返回注销函数。 */
  section(definition: {
    name: string;
    order: number;
    text: () => string;
  }): () => void;
}

/** 插件上下文（本地窄接口）。 */
export interface BoardContextContext {
  /** 系统提示装配器；服务缺失时本插件降级为「只打日志」。 */
  systemPrompt?: SystemPromptService;
  /** cordis 生命周期钩子（存在时用它注销段落）。 */
  effect?: (callback: () => void) => void;
}

/**
 * 挂载看板上下文段落。
 *
 * 降级口径：`systemPrompt` 服务缺失 → 只 warn 后 return，不抛。
 *
 * 段落内容全部内置，本入口不读取 loader 投影的用户配置，因此不声明第二个参数。
 * @param ctx - 插件上下文（systemPrompt 注入）。
 */
export function apply(ctx: BoardContextContext): void {
  const systemPrompt = ctx.systemPrompt;
  if (systemPrompt === undefined) {
    console.warn(`[${name}] systemPrompt 服务不可用，跳过看板上下文注入`);
    return;
  }
  const dispose = systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: () => buildContext(),
  });
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => dispose);
  }
}
