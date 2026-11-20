/**
 * dsh-victauri 插件入口。
 *
 * 主通道 REST 直连（discovery 自动发现 → POST /api/tools/{name}）+
 * 辅通道 victauri CLI spawn；39 个 dsh 工具 = 20 standalone + 15 compound
 * + 1 CLI 桥 + 1 CLI 探测 + 1 工具发现 + 1 桥接体检（口径见 docs/TOOLS.md
 * 与 src/tools/contract.test.ts）。
 *
 * 依赖注入：tools（工具注册表）+ skills（宿主 skill 注册表，注册内嵌
 * victauri-fullstack-debug 调试套路）。连接惰性建立——首次工具调用才
 * discovery 探活，Tauri app 未启动不影响插件装载。
 *
 * 本插件没有任何浏览器 UI 或 HTTP 路由：开发调试入口是 39 个工具
 * （victauri_doctor 做桥接体检）与 skill 指引。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { JsonValue } from './json.ts';
import {
  connectAuto,
  VictauriClient,
  type VictauriClientLike,
  type VictauriToolInfo,
} from './client.ts';
import { resolveConfig, type ResolvedVictauriConfig } from './config.ts';
import { scanInstances } from './discovery.ts';
import {
  isVictauriError,
  VictauriError,
  VictauriHttpError,
  VictauriTimeoutError,
} from './errors.ts';
import {
  SKILL_CONTENT,
  SKILL_DESCRIPTION,
  SKILL_NAME,
} from './skill-content.ts';
import { createVictauriCliTool } from './tools/cli.ts';
import { createVictauriCliStatusTool } from './tools/cli-status.ts';
import { createToolsListTool } from './tools/tools-list.ts';
import { createVictauriDoctorTool } from './tools/doctor.ts';
import {
  COMPOUND_TOOL_SPECS,
  createCompoundTools,
} from './tools/compound/index.ts';
import {
  createStandaloneTools,
  REST_TOOL_SPECS,
} from './tools/standalone/index.ts';

/** Cordis 插件名（loader 依赖）；与包名 kebab 段、patch 行 id 一致。 */
export const name = 'dsh-victauri';

/**
 * 依赖注入：工具注册表 + 宿主 skill 注册表。
 *
 * 两者都是硬依赖（cordis 的 inject 语义：所声明的服务未全部就绪时插件整体
 * 不装载）——宿主必然提供 tools/skills，故可安全声明；本插件没有 web 面，
 * 不声明任何其他服务。
 */
export const inject: string[] = ['tools', 'skills'];

/**
 * 全量工具数（20 standalone + 15 compound + 1 CLI 桥 + 1 CLI 探测 +
 * 1 工具发现 + 1 桥接体检）。
 */
export const TOTAL_TOOL_COUNT =
  REST_TOOL_SPECS.length + COMPOUND_TOOL_SPECS.length + 4;

/**
 * 按配置建立 REST 客户端（portOverride 固定端口优先，否则 connectAuto）。
 */
async function makeClient(
  config: ResolvedVictauriConfig,
): Promise<VictauriClient> {
  if (config.portOverride !== null) {
    const candidates = (
      await scanInstances({ identifier: config.appIdentifier ?? undefined })
    ).filter((instance) => instance.port === config.portOverride);
    for (const instance of candidates) {
      try {
        const client = VictauriClient.fromInstance(instance, {
          timeoutMs: config.requestTimeoutMs,
        });
        await client.info();
        return client;
      } catch {
        // 该候选不活，继续下一个。
      }
    }
    throw new VictauriError(
      'no-live-instance',
      `no live victauri instance on port ${config.portOverride}${config.appIdentifier ? ` (identifier ${config.appIdentifier})` : ''}`,
    );
  }
  const { client } = await connectAuto({
    identifier: config.appIdentifier ?? undefined,
    timeoutMs: config.requestTimeoutMs,
  });
  return client;
}

/**
 * S-2 重发现触发矩阵（backlog-A 设计提案 §3，用户已批准）：按错误形态判定
 * 是否复位共享连接。
 * - `VictauriHttpError` 401/403（auth）→ 复位：token 失配意味着实例重启过或
 *   换了 token 文件，下次调用重新 discovery 自然读到新值；
 * - `VictauriError('http-error')`（fetch 网络层失败：连接拒绝/DNS 等）→ 复位：
 *   实例可能已退出或换端口；
 * - `VictauriTimeoutError` → 不复位：eval 长任务超时常见，服务仍在线；
 * - 其余（invalid-params/not-found/rate-limited/5xx/tool-error/timeout/
 *   非结构化异常）→ 不复位，避免放大故障或形成复位循环。
 */
export function shouldResetClient(err: unknown): boolean {
  if (err instanceof VictauriHttpError) {
    return err.status === 401 || err.status === 403;
  }
  if (err instanceof VictauriTimeoutError) return false;
  return isVictauriError(err) && err.kind === 'http-error';
}

/**
 * S-2 重发现包装层：包住 VictauriClient，复位类错误（shouldResetClient 判真）
 * 时回调 onReset（apply 里清空共享 clientPromise）并原样重抛——下次工具调用
 * 重新 discovery。与 VictauriClient 同形（VictauriClientLike），桥接工具零改动。
 * 导出仅供单测（reconnect.test.ts）注入桩。
 */
export class ReconnectingVictauriClient implements VictauriClientLike {
  constructor(
    private readonly inner: VictauriClient,
    private readonly onReset: (err: unknown) => void,
  ) {}

  private async withReset<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (shouldResetClient(err)) this.onReset(err);
      throw err;
    }
  }

  callTool(
    toolName: string,
    args?: Record<string, JsonValue>,
    timeoutMsOverride?: number,
  ): Promise<JsonValue> {
    return this.withReset(() =>
      this.inner.callTool(toolName, args, timeoutMsOverride),
    );
  }

  info(): Promise<Record<string, JsonValue>> {
    return this.withReset(() => this.inner.info());
  }

  listTools(): Promise<VictauriToolInfo[]> {
    return this.withReset(() => this.inner.listTools());
  }

  health(): Promise<boolean> {
    return this.withReset(() => this.inner.health());
  }
}

/**
 * 插件入口。
 *
 * @param ctx - cordis 上下文（tools 已由 inject 保证就绪）。
 * @param configInput - loader 投影的用户配置（volatile 引用嵌套，可 undefined）。
 */
export function apply(ctx: Context, configInput?: unknown): void {
  // e2e 契约：装载日志 `[name] ` 前缀格式，e2e 运行器按此结构化匹配。
  console.log(`[${name}] plugin loaded`);

  // 1. 解析配置；非法输入降级为默认（不抛错、不阻塞宿主）。
  let config: ResolvedVictauriConfig;
  try {
    config = resolveConfig(configInput);
  } catch (err) {
    console.error(`[${name}] invalid config:`, err);
    config = resolveConfig(undefined);
  }

  // 2. 惰性共享客户端：首次工具调用才 discovery + 探活；失败重置以便下次重试
  //    （Tauri app 可能是后启动的）。S-2：连接成功后的 401/403/网络层失败同样
  //    复位（ReconnectingVictauriClient 回调清空 clientPromise），下次调用重新
  //    discovery 读到新 token/port。
  let clientPromise: Promise<VictauriClientLike> | undefined;
  const getClient = (): Promise<VictauriClientLike> => {
    clientPromise ??= makeClient(config)
      .then(
        (client) =>
          new ReconnectingVictauriClient(client, () => {
            clientPromise = undefined;
          }),
      )
      .catch((err: unknown) => {
        clientPromise = undefined;
        throw err;
      });
    return clientPromise;
  };

  // 3. 组装 39 工具并按 disabledTools 过滤。
  const tools: ToolDefinition[] = [
    ...createStandaloneTools(REST_TOOL_SPECS, { getClient }),
    ...createCompoundTools({ getClient }),
    createVictauriCliTool(config.cliPath ? { cliPath: config.cliPath } : {}),
    createVictauriCliStatusTool(
      config.cliPath ? { cliPath: config.cliPath } : {},
    ),
    createToolsListTool({ getClient }),
    // 体检工具沿用插件配置：cliPath 决定 CLI 探测目标，appIdentifier 限定实例范围。
    createVictauriDoctorTool({
      cliPath: config.cliPath ?? undefined,
      identifier: config.appIdentifier ?? undefined,
    }),
  ];
  const disabled = new Set(config.disabledTools);
  const enabledTools = tools.filter((tool) => !disabled.has(tool.name));

  // 4. 注册工具（disposer 自动附着插件，卸载即注销）。
  for (const tool of enabledTools) {
    ctx.tools.register(tool);
  }
  console.log(
    `[${name}] registered ${enabledTools.length} victauri tools` +
      (disabled.size > 0 ? ` (${disabled.size} disabled by config)` : ''),
  );

  // 5. 注册内嵌 skill（e2e 契约行已打完，日志另起一行不破坏其格式）。
  ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    source: 'bundled',
    content: SKILL_CONTENT,
    invocation: { modelInvocable: true, userInvocable: true },
  });
  console.log(`[${name}] registered skill ${SKILL_NAME}`);
}

// re-export：loader 通过 `plugin.Config` 读 schemastery schema 生成设置面板
//（collectConfigSchemas）；不 re-export 会让设置面板不渲染本插件字段。
export { resolveConfig, Config } from './config.ts';
// re-export：桥接体检工具契约（纯函数与工厂，单测入口）。
export {
  createVictauriDoctorTool,
  DOCTOR_TOOL_NAME,
  DOCTOR_PROBE_TIMEOUT_MS,
} from './tools/doctor.ts';
export type {
  DoctorCheck,
  DoctorCheckStatus,
  DoctorResult,
  DoctorVerdict,
} from './tools/doctor.ts';
export { PLUGIN_VERSION } from './version.ts';
export type { ResolvedVictauriConfig } from './config.ts';
