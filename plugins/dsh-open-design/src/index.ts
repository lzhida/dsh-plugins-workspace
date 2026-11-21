/**
 * dsh-open-design 插件入口（Host 插件行）。
 *
 * 插件做三件事：
 *   1. 启动时检测一次 Open Design 安装环境，命中即自动配好 MCP 连接参数；
 *   2. 把上游 Open Design 的 MCP 工具桥接成 dsh 工具（命名空间 `mcp__open-design__*`）；
 *   3. 提供 2 个诊断工具（open_design_status / open_design_redetect），
 *      供用户在界面上查看生效配置、手动重跑探测。
 *
 * 工具数口径（代码注释 / README / docs / 契约测试四处保持一致）：
 *   - 插件自带诊断工具：固定 2 个；
 *   - 上游 Open Design MCP 工具：数量随上游版本浮动，
 *     Open Design 0.27.2 基线为 22 个（UPSTREAM_TOOL_COUNT_BASELINE）。
 */
import type { Context } from '@deepseek-ai/cordis';

import {
  createDiagnosticTools,
  DIAGNOSTIC_TOOL_COUNT,
  REDETECT_TOOL_NAME,
  STATUS_TOOL_NAME,
} from './diag-tools.ts';
import { OpenDesignRuntime, type RuntimeDeps } from './runtime.ts';

/** 插件标识（必须与 cordis.patch.yml 的插件行 id 一致）。 */
export const name = 'dsh-open-design';

/** 依赖注入：需要宿主工具注册面。 */
export const inject: string[] = ['tools'];

/**
 * 插件装配。
 *
 * @param ctx cordis 上下文。
 * @param configInput 配置卡输入（volatile 字段，宿主会补齐默认值）。
 * @param deps 可替换依赖（仅测试用；宿主只传前两个参数）。
 */
export function apply(
  ctx: Context,
  configInput?: unknown,
  deps?: RuntimeDeps,
): void {
  console.log(`[${name}] plugin loaded`);
  const runtime = new OpenDesignRuntime(ctx, configInput, deps);

  ctx.effect(() => {
    const disposers = createDiagnosticTools(runtime).map((definition) =>
      ctx.tools.register(definition),
    );
    console.log(
      `[${name}] registered ${DIAGNOSTIC_TOOL_COUNT} diagnostic tools (${STATUS_TOOL_NAME}, ${REDETECT_TOOL_NAME})`,
    );

    // 连接与上游工具同步是异步的：探测要跑 PowerShell、子进程要握手，
    // 都不能阻塞插件装载。失败只落日志（见 runtime.ts）。
    void runtime.start();

    // 清理返回 Promise：宿主 cordis 会 await Promise 型清理函数，
    // 确保 MCP 子进程（transport.close 的 kill）在插件卸载完成前被收掉，
    // 不留孤儿进程。dispose 内部自带 try/catch，不会向外抛。
    return () => {
      for (const disposer of disposers) {
        if (typeof disposer !== 'function') continue;
        try {
          disposer();
        } catch {
          // 单个工具注销失败不应阻断其余工具的注销。
        }
      }
      return runtime.dispose();
    };
  }, 'dsh-open-design 运行时');
}

export { resolveConfig, Config } from './config.ts';
export {
  DIAGNOSTIC_TOOL_COUNT,
  REDETECT_TOOL_NAME,
  STATUS_TOOL_NAME,
} from './diag-tools.ts';
export { UPSTREAM_TOOL_COUNT_BASELINE } from './runtime.ts';
