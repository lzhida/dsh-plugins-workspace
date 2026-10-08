/**
 * dsh-obsidian 插件入口。
 *
 * 职责:
 * - 导出 loader 依赖的 name / apply / inject 三符号;
 * - apply() 内:
 *   1. 打印 `[dsh-obsidian] plugin loaded`(e2e 契约,见 dsh-plugin-dev skill);
 *   2. 注册 system-prompt section(tool:obsidian, 唯一名,order=2960);
 *   3. 注册 9 个 obsidian_* 工具(读/写/搜/daily/properties/vault/通用 run);
 *   4. effect 卸载时一次性清理(disposeTools + disposeSection)。
 *
 * 设计选择:
 * - 不在加载阶段 spawn 一次 `obsidian --version` 探活 — 那样会污染
 *   用户进程路径上的 obsidian,实际缺它时由 tool 第一次调用暴露
 *   OBSIDIAN_CLI_NOT_FOUND,model 看到错误码再走"提示用户安装"流程;
 * - defaultVault 暂不接 settings.yaml — 教学版只暴露 `vault` 参数,
 *   由调用方显式指定;后续若要全局默认,挂 ctx.settings 即可;
 * - 不实现 e2e 的 kill 子进程收割(所有 spawn 走 AbortSignal,
 *   子进程生命周期绑定 exec.signal,卸载由 cordis effect 兜底);
 * - type-only imports 走 import type,verbatimModuleSyntax 兼容;
 *   运行时仅依赖 @deepseek-ai/dsh-tools / dsh-system-prompt / cordis。
 */

import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';

import { obsidianSection } from './protocol.ts';
import { createObsidianTools } from './tools.ts';

/** Cordis 插件名(loader 依赖);与 cordis.patch.yml 的 id 对齐。 */
export const name = 'dsh-obsidian';

/** 依赖注入:tools(工具注册)+ systemPrompt(协议 section)。 */
export const inject = ['tools', 'systemPrompt'];

/** 插件入口。 */
export function apply(ctx: Context): void {
  // e2e 契约:装载日志 `[name] ` 前缀格式,e2e 运行器按此结构化匹配。
  console.log(`[${name}] plugin loaded`);

  // 1. 注册 system-prompt section(命令清单 + 安全约束)
  const disposeSection = ctx.systemPrompt.section(obsidianSection());
  ctx.effect(() => disposeSection, 'dsh-obsidian: protocol section');

  // 2. 注册 9 个 obsidian_* 工具
  const { registerAll } = createObsidianTools();
  // ctx.tools.register 的 disposer 由 cordis effect 自动接管;
  // 这里必须返回 cleanup 函数(cordis effect 签名不接受 void)。
  ctx.effect(() => {
    const disposers: Array<() => void> = [];
    registerAll((tool) => {
      const dispose = ctx.tools.register(tool);
      disposers.push(dispose);
    });
    return () => {
      for (const d of disposers) d();
    };
  }, 'dsh-obsidian: tools registration');
}
