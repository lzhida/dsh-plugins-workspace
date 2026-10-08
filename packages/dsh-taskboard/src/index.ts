/**
 * dsh-taskboard 插件入口(教学版)。
 *
 * 复刻 https://github.com/cloader/dsh-taskboard#readme 的核心契约:
 * - 10 个 taskboard_* agent 工具;
 * - 代码级协议闸(agent 永远到不了 done、被持有时不可抢、跨项目不可认领);
 * - 乐观并发(ifVersion);
 * - DoD 验收清单(check 必带 evidence note);
 * - 结构化执行报告;
 * - system-prompt section 写明协议(认领纪律、done-gate、retry)。
 *
 * 与原版的差异(教学版简化):
 * - 无 Web UI(看板 UI 由宿主插件或下游实现);
 * - 无 cron 调度器(只记录 execution spec);
 * - 无 worktree 隔离执行(只挂载台账 + 工具);
 * - 无资产存储 / 多 workspace 镜像 / 数据目录迁移;
 * - 无 webServer 路由(SSE 由宿主层实现);
 * - 无外部会话自动同步。
 *
 * 加载链:
 * 1. 构造 TaskStore(file 落 DSH_HOME/dsh-taskboard.json);
 * 2. await store.load()(eager first load,避免空台账假象);
 * 3. 注册 system-prompt section;
 * 4. 注册 10 个 taskboard_* 工具;
 * 5. effect 卸载时一次性清理(disposeTools + disposeSection)。
 */

import type { Context } from '@deepseek-ai/cordis';
// 类型导入:激活 cordis Context 增强(ctx.tools / ctx.systemPrompt),编译后零运行时依赖。
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';

import { taskboardSection } from './protocol.ts';
import { defaultLedgerPath, isExistsError, TaskStore } from './store.ts';
import { createTaskboardTools } from './tools.ts';

/** Cordis 插件名(loader 依赖)。 */
export const name = 'dsh-taskboard';

/**
 * 依赖注入:tools(工具注册)+ systemPrompt(协议 section)。
 * production 还会 inject workspaceRegistry(以提供 ctx.workspaceId 解析),
 * 教学版从 agent.session.header.cwd 抽取。
 */
export const inject = ['tools', 'systemPrompt'];

/** DSH 主目录:DSH_HOME 优先,回退 ~/.dsh。 */
function dshHomeDir(): string {
  return process.env['DSH_HOME'] ?? join(os.homedir(), '.dsh');
}

/**
 * 插件入口。
 * @param ctx - cordis 上下文(tools + systemPrompt 已注入)
 */
export async function apply(ctx: Context): Promise<void> {
  // e2e 契约:装载日志 `[name] ` 前缀格式,e2e 运行器按此结构化匹配。
  console.log(`[${name}] plugin loaded`);

  // 1. 初始化 store(file 落 DSH_HOME/dsh-taskboard.json,内存模式兜底)
  const home = dshHomeDir();
  try {
    await mkdir(home, { recursive: true });
  } catch (error) {
    // 目录已存在(EEXIST)视为成功 — 不阻塞。其它错误(权限等)重抛,便于宿主诊断;
    // store.flush 阶段也会再尝试创建,所以 mkdir 失败不等于致命。
    if (!isExistsError(error)) throw error;
  }
  const file = defaultLedgerPath(home);
  const store = new TaskStore({ file, now: () => Date.now() });
  await store.load();

  // 2. 注册 system-prompt section(协议约束)
  const disposeSection = ctx.systemPrompt.section(taskboardSection());
  ctx.effect(() => disposeSection, 'dsh-taskboard: protocol section');

  // 3. 注册 10 个 taskboard_* 工具
  const { registerAll } = createTaskboardTools({ store });
  // ctx.tools.register 的 disposer 经 cordis 自动附着到 effect 作用域。
  ctx.effect(
    () => registerAll((tool) => ctx.tools.register(tool)),
    'dsh-taskboard: tools registration',
  );
}
