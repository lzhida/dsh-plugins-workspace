/**
 * decision-tools 插件行入口（决策工具系列）。
 *
 * 卡的演进：
 * - 2/11 落「行骨架 + systemone client + 统一调用层 + 配置面」，注册 0 个工具；
 * - 3/11 注册 decision_decide 与 decision_gate；
 * - 4/11 注册 decision_rerank 与 decision_batch（共 4 个）；
 * - 5/11 注册 decision_locate 与 decision_usage + 账本落盘 + 真实预算闸（共 6 个）；
 * - 8/11 注册 decision_history 与 decision_recheck（共 8 个）；
 * - 10/11 注册 decision_calibrate 与 decision_arbiter（共 10 个）；
 * - 6/11–10/11 在同一 apply 内继续追加 ctx.tools.register(...) 并更新计数日志。
 *
 * 硬契约：未配置 / 未验证 / 调用失败一律显式报错（fail-closed，契约 §0），
 * 与 ask-gate 的 fail-open 相反。
 *
 * README「组合包扩展约定」遵照执行：导出 name / apply / inject 并
 * re-export Config（不 re-export 会被宿主设置面板整块丢弃）。
 */

import type { Context } from '@deepseek-ai/cordis';
import { homedir } from 'node:os';

import {
  Config,
  resolveToolsConfig,
  type ResolvedToolsConfig,
} from '../config/index.ts';
import {
  createDecisionToolsRuntime,
  type DecisionToolsRuntime,
} from '../services/decision-tools.ts';
import { createDecideTool, DECIDE_TOOL } from '../tools/decide.ts';
import { createGateTool, GATE_TOOL } from '../tools/gate.ts';
import { createRerankTool, RERANK_TOOL } from '../tools/rerank.ts';
import { createBatchTool, BATCH_TOOL } from '../tools/batch.ts';
import { createLocateTool, LOCATE_TOOL } from '../tools/locate.ts';
import { createUsageTool, USAGE_TOOL } from '../tools/usage.ts';
import { createHistoryTool, HISTORY_TOOL } from '../tools/history.ts';
import { createRecheckTool, RECHECK_TOOL } from '../tools/recheck.ts';
import { createCalibrateTool, CALIBRATE_TOOL } from '../tools/calibrate.ts';
import { createArbiterTool, ARBITER_TOOL } from '../tools/arbiter.ts';
import type { DecisionLlmLike } from '../core/decision.ts';
import {
  createFileLedger,
  createPassthroughBudgetGate,
  createWindowedBudgetGate,
  resolveLedgerPath,
  type LedgerSink,
} from '../runtime/index.ts';
import {
  createVerifyRoute,
  createVerifyRouteHandler,
  type WebServerLike,
} from '../web/verify-route.ts';

export const name = 'decision-tools';

/** tools 必备；llm 兜底裁判是 7/11 的事，届时软取 ctx.get?.('llm') 不进 inject。 */
export const inject: string[] = ['tools'];

/**
 * 当前运行时（统一调用层 + 验证快照持有者）。
 *
 * 必须**唯一且被持有**——工具注册与 6/11 设置页的「验证」按钮要共用同一个
 * 实例（验证快照写在运行时里，两个实例就等于两份快照，验证状态自相矛盾）。
 */
let runtimeRef: DecisionToolsRuntime | null = null;

/** 取当前运行时（未 apply 时为 null）。 */
export function getRuntime(): DecisionToolsRuntime | null {
  return runtimeRef;
}

export function apply(ctx: Context, configInput?: unknown): void {
  console.log(`[${name}] plugin loaded`);

  let fallbackResolved: ResolvedToolsConfig;
  try {
    fallbackResolved = resolveToolsConfig(configInput);
  } catch (error) {
    console.error(`[${name}] invalid config, fallback to defaults`, error);
    fallbackResolved = resolveToolsConfig(undefined);
  }

  // 配置热生效：volatile 字段保存即写 configInput，readConfig 现读。
  const readConfig = (): ResolvedToolsConfig => {
    try {
      return resolveToolsConfig(configInput);
    } catch {
      return fallbackResolved;
    }
  };

  // 运行时（统一调用层 + 验证包装）在下游工具与设置页之间共享。
  // 5/11：账本落盘（<DSH_HOME>/plugins/dsh-decision/ledger.jsonl）+
  // 预算闸真实化（账本日窗口聚合；账本关闭时预算无从统计 → 直通并在日志说明）。
  const ledger: LedgerSink | undefined = readConfig().ledgerEnabled
    ? createFileLedger({
        resolvePath: () =>
          resolveLedgerPath({
            dshHome: process.env.DSH_HOME,
            home: homedir(),
          }),
        resolveMaxEntries: () => readConfig().ledgerMaxEntries,
      })
    : undefined;
  if (ledger === undefined && readConfig().budgetEnabled) {
    console.warn(
      `[${name}] 账本已关闭（ledgerEnabled=false），预算闸退化为直通——硬预算需要账本统计用量`,
    );
  }
  const budget =
    ledger === undefined
      ? createPassthroughBudgetGate()
      : createWindowedBudgetGate({ readConfig, ledger });

  // 7/11：裁判走宿主大模型通道。llm 服务软取（不进 inject——部分宿主形态缺
  // llm 服务，硬 inject 会让整个插件行 PENDING）；缺服务时裁判回
  // arbiter-unavailable，绝不猜模型。
  const llm = (ctx as { get?: (key: string) => unknown }).get?.('llm') as
    DecisionLlmLike | undefined;

  // 7/11：会话当前模型（宿主内部投影，best-effort）。调研结论见卡评论：
  // ctx.llm 没有「当前会话模型」API，真源在 SessionController 的
  // modelSelection 投影（pending 优先 → lastUsed → 最近一次请求头）。
  const resolveSessionModel = (
    exec: unknown,
  ): { provider: string; model: string } | undefined => {
    try {
      const session = (exec as { agent?: { session?: unknown } } | undefined)
        ?.agent?.session as
        | {
            requestHeader?: () =>
              { config?: { provider?: string; model?: string } } | undefined;
          }
        | undefined;
      if (!session) return undefined;
      const projections = (
        ctx as {
          sessionProjections?: {
            stateOf(
              session: unknown,
              key: string,
            ): {
              state?: {
                pending?: { provider?: string; model?: string } | null;
                lastUsed?: { provider?: string; model?: string } | null;
              };
            };
          };
        }
      ).sessionProjections;
      const projected = projections?.stateOf(session, 'modelSelection');
      const header = session.requestHeader?.();
      const pick = (
        candidate: { provider?: string; model?: string } | null | undefined,
      ): { provider: string; model: string } | undefined => {
        if (!candidate) return undefined;
        const { provider, model } = candidate;
        if (
          typeof provider !== 'string' ||
          typeof model !== 'string' ||
          provider === '' ||
          model === ''
        ) {
          return undefined;
        }
        return { provider, model };
      };
      return (
        pick(projected?.state?.pending) ??
        pick(projected?.state?.lastUsed) ??
        pick(header?.config)
      );
    } catch {
      // 宿主投影形态可能变化：取不到就返回 undefined（裁判随后回
      // arbiter-unavailable），绝不猜模型。
      return undefined;
    }
  };

  const runtime = createDecisionToolsRuntime(readConfig, {
    ledger,
    budget,
    llm,
    resolveSessionModel,
  });
  runtimeRef = runtime;

  // 工具注册：与 ask-gate 行同一范式（直接 ctx.tools.register；tools 服务
  // 随插件 fiber 卸载自动清理，无需手写反注册）。
  ctx.tools.register(createDecideTool(runtime.deps));
  ctx.tools.register(createGateTool(runtime.deps));
  ctx.tools.register(createRerankTool(runtime.deps));
  ctx.tools.register(createBatchTool(runtime.deps));
  ctx.tools.register(createLocateTool(runtime.deps));
  ctx.tools.register(createUsageTool({ readConfig, ledger }));
  ctx.tools.register(createHistoryTool({ readConfig, ledger }));
  ctx.tools.register(createRecheckTool(runtime.deps));
  // 10/11：calibrate 纯本地只读账本；arbiter 走 7/11 的裁判通道入口
  // （mode='explicit-arbiter'，自带账本，记账与 auto-fallback 可区分）。
  ctx.tools.register(createCalibrateTool({ readConfig, ledger }));
  ctx.tools.register(createArbiterTool(runtime.judge));
  console.log(
    `[${name}] registered 10 tools (${DECIDE_TOOL}, ${GATE_TOOL}, ${RERANK_TOOL}, ${BATCH_TOOL}, ${LOCATE_TOOL}, ${USAGE_TOOL}, ${HISTORY_TOOL}, ${RECHECK_TOOL}, ${CALIBRATE_TOOL}, ${ARBITER_TOOL})`,
  );

  // 设置页「验证接口」同源路由（6/11）：webServer 缺失时子 fiber PENDING、
  // 静默无路由——client 的验证按钮会报「路由缺失」，主插件不受影响。
  ctx.inject(['webServer'], (webCtx: Context) => {
    const server = (webCtx as Context & { webServer: WebServerLike }).webServer;
    server.register(
      createVerifyRoute(
        createVerifyRouteHandler({
          readConfig,
          markVerified: () => runtime.markVerified(),
        }),
      ),
    );
    console.log(
      `[${name}] registered verify route (POST /dsh-decision/verify)`,
    );
  });
}

export { createDecisionToolsRuntime };
export type { DecisionToolsRuntime, ResolvedToolsConfig };
export { Config, resolveToolsConfig };
