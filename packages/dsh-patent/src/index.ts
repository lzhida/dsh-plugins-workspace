/**
 * dsh-patent 插件入口（bundle 唯一插件行）。
 *
 * 「专利交底」预设的工具行：交底书三工具 + 结构化 prompt 段落 + 内嵌方法论
 * skill（patent-disclosure）。预设声明见包内 cordis.patch.yml 的
 * preset-patent 行。
 *
 * 依赖注入：tools（工具注册）+ systemPrompt（section 注册）+ skills（内嵌
 * skill 注册）。由 dsh web/base bundle 与预设组合提供；缺失时停在 PENDING。
 */

import type { Context } from '@deepseek-ai/cordis';
// 类型副作用导入：加载 dsh-skill 的 Context augmentation（ctx.skills）。
import type {} from '@deepseek-ai/dsh-skill';

import { resolveConfig } from './config.ts';
import {
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
} from './skill-content.ts';
import { buildSections } from './sections.ts';
import { buildPatentTools } from './tools.ts';

/** Cordis 插件名（loader 依赖）；与包名 kebab 段、patch 行 id 一致。 */
export const name = 'dsh-patent';

/** 依赖注入：工具注册表 + system-prompt + skill registry。 */
export const inject: string[] = ['tools', 'systemPrompt', 'skills'];

/**
 * 插件入口。
 *
 * @param ctx - cordis 上下文（tools/systemPrompt/skills 已由 inject 保证就绪）。
 * @param configInput - loader 投影的用户配置（volatile 引用嵌套，可 undefined）。
 */
export function apply(ctx: Context, configInput?: unknown): void {
  // e2e 契约：装载日志 `[name] ` 前缀格式，e2e 运行器按此结构化匹配。
  console.log(`[${name}] plugin loaded`);

  // 1. 解析配置；非法输入降级为默认（不抛错、不阻塞宿主）。
  let resolved;
  try {
    resolved = resolveConfig(configInput);
  } catch (err) {
    console.error(`[${name}] invalid config:`, err);
    resolved = resolveConfig(undefined);
  }

  // 2. 结构化 prompt 段落：始终注册——enabled=false 时告知 agent 功能停用，
  //    避免模型面对用户请求凭空造工具。
  ctx.effect(() => {
    const disposers = buildSections(resolved.enabled).map((section) =>
      ctx.systemPrompt.section(section),
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'dsh-patent: prompt sections');

  // 3. enabled=false → 不注册工具与 skill（section 仍在）。
  if (!resolved.enabled) {
    console.log(`[${name}] disabled by config; no tools or skill registered`);
    return;
  }

  // 4. 内嵌方法论 skill（runtime 注册，模型可按需加载；卸载即注销）。
  ctx.effect(() => {
    return ctx.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      source: 'bundled',
      content: SKILL_CONTENT,
      invocation: { modelInvocable: true, userInvocable: true },
    });
  }, 'dsh-patent: skill');

  // 5. 注册工具（disposer 自动附着插件，卸载即注销；config 每次执行现读）。
  const tools = buildPatentTools(
    () => resolveConfig(configInput).disclosureDefaults,
  );
  for (const tool of tools) {
    ctx.tools.register(tool);
  }
  console.log(
    `[${name}] registered ${tools.length} patent tools + skill ${SKILL_NAME}`,
  );
}

// re-export：loader 通过 `plugin.Config` 读 schemastery schema 生成设置面板
//（collectConfigSchemas）；不 re-export 会让设置面板不渲染本插件字段。
export { resolveConfig, Config } from './config.ts';
export type { ResolvedConfig, DisclosureDefaults } from './config.ts';
export { buildDisclosure, resolveBuiltinTemplatePath } from './disclosure.ts';
export { checkDisclosure } from './disclosure-check.ts';
export { checkClaims } from './claims.ts';
export { buildSections } from './sections.ts';
export { buildPatentTools, mergeHeader } from './tools.ts';
export {
  SKILL_NAME,
  SKILL_DESCRIPTION,
  SKILL_CONTENT,
} from './skill-content.ts';
