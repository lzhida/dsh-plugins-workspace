/**
 * ask-gate 插件行（决策门控系列 1/4 骨架 + 3/4 门控接线）。
 *
 * ## 它在包里的角色
 *
 * `@zhidal/dsh-decision` 是**决策域组合包**：包内每个「决策点」是一个独立
 * 插件行，命名规则为 `<决策点>-gate`（本卡只有 `ask-gate`）。
 *
 * - 本文件 = **插件行 ask-gate**：接管模型侧的提问工具 `ask_user_question`。
 *
 * ## 执行路径
 *
 * - 总开关关闭（默认）：与**出厂 legacy 模式 schema 兼容**的同名工具
 *   直通宿主 `ctx.userQuestions.ask()`，行为与出厂完全一致。
 * - 总开关开启：先让决策模型（2/4 决策 core）评估提问的置信度——
 *   **≥ 阈值自动作答**（答案带 `[decision auto-answer]` 前缀标注来源，
 *   并落账 `presentationMeta` {confidence, decision, rationale}）；
 *   **< 阈值或任何降级**（llm 服务缺失 / provider+model 未配置 /
 *   调用失败 / 超时 / 被中止 / 解析失败 / 建议答案未覆盖全部问题）
 *   一律放行真实提问（fail-open），同样落账 meta 并打降级日志。
 * - 决策模型调用是**纯旁路**：不写会话、不注册 MessageSourceMap、
 *   不经宿主 agent 状态机（见 core/decision.ts 头注释）。
 *
 * ## 为什么必须让位出厂行
 *
 * 宿主工具注册面（`ToolRuntime.register`）语义：同一层内重复注册同名工具
 * 会直接失败。所以本行要与出厂 `@deepseek-ai/dsh-tool-ask-user` 共存，
 * 必须在 bundle 层让位（见 `cordis.patch.yml` 的 `- id: tool-ask-user` +
 * `disabled: true`）。让位后提问能力由本行提供，schema 与错误语义保持一致。
 *
 * ## 错误语义
 *
 * 宿主服务在提问前会校验并抛错：signal 已中止 → `ASK_ABORTED`；问题为空 →
 * `EMPTY_QUESTIONS`；传入 agent 但不是活体 → `CALLER_NOT_LIVE`；agent 不在
 * `agents.roots()` 内（被别的活体 agent 持有的子代理）→ `DELEGATED_CALLER`。
 * 本行**原样透传**，不吞不改、不改写文案。决策评估阶段的错误绝不抛穿：
 * 全部归入放行路径（见 core/decision.ts 六分支）。
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { resolveConfig, type ResolvedConfig } from '../core/config.ts';
import { decide, type DecisionLlmLike } from '../core/decision.ts';
import {
  askThroughUserQuestions,
  buildAutoAnswers,
  buildAutoMeta,
  buildDecisionPrompt,
  buildDegradedMeta,
  DECISION_SYSTEM_PROMPT,
  type AskGateQuestion,
  type PresentationMeta,
} from '../services/ask-gate.ts';

/** Cordis 插件名（loader 依赖）；与包内决策点成员名一致。 */
export const name = 'ask-gate';

/** 依赖注入：工具注册表 + 宿主提问服务。 */
export const inject: string[] = ['tools', 'userQuestions'];

/** 工具名：与出厂 ask_user_question 同名（本行接管该工具面）。 */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question';

/**
 * 工具描述：与出厂 legacy 模式的描述**不完全逐字一致**——首句沿用出厂文案，
 * 后半句补充本实现对「每题带稳定 id」的要求（id 会在答案里回显）。
 * 结构约束（必填性 / additionalProperties）与出厂一致；文案差异会让模型侧
 * 行为有轻微漂移，详见 README「已知限制」。
 */
export const ASK_USER_QUESTION_DESCRIPTION =
  'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.';

/** 工具入参 schema：与出厂 legacy 模式的结构约束兼容（含 additionalProperties）。 */
export const ASK_USER_QUESTION_PARAMETERS = {
  questions: {
    type: 'array' as const,
    required: true as const,
    description: 'Questions to ask the user before continuing.',
    items: {
      type: 'object' as const,
      additionalProperties: true as const,
      properties: {
        id: {
          type: 'string' as const,
          required: true as const,
          description: 'Stable id for this question; echoed in the answer.',
        },
        question: {
          type: 'string' as const,
          required: true as const,
          description: 'The specific question to ask the user.',
        },
        header: {
          type: 'string' as const,
          description:
            'Optional short heading for the question, shown above the question text.',
        },
        options: {
          type: 'array' as const,
          description:
            'Optional choices for this question. If provided, the user may pick one (or several when multi_select is true) instead of answering freely.',
          items: {
            type: 'object' as const,
            additionalProperties: true as const,
            properties: {
              label: {
                type: 'string' as const,
                required: true as const,
                description: 'Short user-facing option label.',
              },
              description: {
                type: 'string' as const,
                description: 'One sentence explaining the tradeoff or impact.',
              },
            },
          },
        },
        multi_select: {
          type: 'boolean' as const,
          description:
            'Whether the user may select more than one option. Defaults to false.',
        },
      },
    },
  },
};

/**
 * 工具出参 schema：answers 部分与出厂 legacy 模式逐字兼容；顶层放宽为
 * `additionalProperties: true` 以容纳门控落账扩展 `presentationMeta`
 * （置信度/决策/理由，宿主严格校验下扩展字段的合法通道）。
 */
export const ASK_USER_QUESTION_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: true as const,
    properties: {
      answers: {
        type: 'array' as const,
        required: true as const,
        items: {
          type: 'object' as const,
          additionalProperties: false as const,
          properties: {
            id: { type: 'string' as const, required: true as const },
            selected: {
              type: 'array' as const,
              required: true as const,
              items: { type: 'string' as const },
            },
            custom: { type: 'string' as const },
          },
        },
      },
    },
  },
  render: (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
};

/**
 * 插件入口。
 *
 * @param ctx - cordis 上下文（tools / userQuestions 由 inject 保证就绪）。
 * @param configInput - loader 投影的用户配置（volatile 引用嵌套，可 undefined）。
 */
export function apply(ctx: Context, configInput?: unknown): void {
  // e2e 契约：装载日志 `[name] ` 前缀格式，e2e 运行器按此结构化匹配。
  console.log(`[${name}] plugin loaded`);

  // 1. 解析配置；非法输入降级为默认（不抛错、不阻塞宿主）。
  let resolved: ResolvedConfig;
  try {
    resolved = resolveConfig(configInput);
  } catch (err) {
    console.error(`[${name}] invalid config:`, err);
    resolved = resolveConfig(undefined);
  }

  // 2. 配置现读（volatile 引用每次执行重新解析）→ 保存即生效，无需重载。
  const readConfig = (): ResolvedConfig => {
    try {
      return resolveConfig(configInput);
    } catch {
      return resolved; // 保留 last good
    }
  };

  // 3. 注册接管后的提问工具。
  //    总开关默认关闭＝不介入＝直通原版提问；开启后进入门控路径
  //    （决策模型评估 → 置信度阈值 → 自动作答或放行，降级一律放行）。
  ctx.tools.register(
    defineTool({
      name: ASK_USER_QUESTION_TOOL,
      description: ASK_USER_QUESTION_DESCRIPTION,
      parameters: ASK_USER_QUESTION_PARAMETERS,
      output: ASK_USER_QUESTION_OUTPUT,
      async execute(args, exec) {
        const userQuestions = ctx.userQuestions;
        if (!userQuestions) {
          throw new Error(
            `[${name}] host userQuestions service is unavailable; the built-in ask_user_question was replaced by this plugin line but the host service is missing.`,
          );
        }
        const config = readConfig();
        const questions = (args.questions ?? []) as AskGateQuestion[];
        if (!config.enabled) {
          // 默认路径：完全直通，行为与出厂一致，不落账 meta。
          return askThroughUserQuestions(userQuestions, questions, exec);
        }

        // 空问题清单：与出厂行为保持一致（宿主抛 EMPTY_QUESTIONS），
        // 不浪费一次决策模型调用，也不让同一输入在开关两侧语义漂移。
        if (questions.length === 0) {
          return askThroughUserQuestions(userQuestions, questions, exec);
        }

        // 门控路径（总开关开启）：先问决策模型，再按置信度阈值决定
        // 自动作答或放行真实提问。任何降级（模型缺失/配置缺/调用失败/
        // 超时/低置信/答案覆盖不全）都放行真实提问（fail-open），
        // 并在日志与 presentationMeta 里留痕。
        // llm 服务软取：不进 inject（部分宿主形态可能缺 llm 服务，
        // 硬注入会阻塞插件装载、提问能力直接消失）；取不到时决策 core
        // 按 llm-unavailable 降级放行。
        const llm = (ctx as { get?: (key: string) => unknown }).get?.('llm') as
          DecisionLlmLike | undefined;
        const routeReady =
          config.decisionProvider !== '' && config.decisionModel !== '';
        if (!routeReady) {
          console.warn(
            `[${name}] decision model not configured (provider/model empty); passing question through`,
          );
          const result = await askThroughUserQuestions(
            userQuestions,
            questions,
            exec,
          );
          return {
            ...result,
            presentationMeta: buildDegradedMeta('route-not-configured'),
          };
        }

        const report = await decide(
          llm,
          {
            prompt: buildDecisionPrompt(questions),
            system: DECISION_SYSTEM_PROMPT,
            signal: exec.signal,
          },
          {
            provider: config.decisionProvider,
            model: config.decisionModel,
            timeoutMs: config.decisionTimeoutMs,
          },
          config.confidenceThreshold,
        );

        let meta: PresentationMeta;
        if (report.threshold.verdict === 'auto-answered' && report.parse.ok) {
          const auto = buildAutoAnswers(questions, report.parse);
          if (auto !== undefined) {
            meta = buildAutoMeta(report.parse, 'auto-answered');
            console.log(
              `[${name}] decision auto-answered (confidence=${report.parse.confidence.toFixed(2)}, threshold=${config.confidenceThreshold})`,
            );
            return { ...auto, presentationMeta: meta };
          }
          // 模型建议没覆盖全部问题 → 不完整自动作答比多问一次更糟，放行。
          console.warn(
            `[${name}] decision answers incomplete for some questions; passing through`,
          );
          const incompleteMeta = buildAutoMeta(report.parse, 'passed-through');
          meta = {
            ...incompleteMeta,
            rationale: `answers-incomplete: ${incompleteMeta.rationale}`,
          };
        } else {
          // 三条出口必须分开：
          //   - 评估/解析没跑通（parse.ok=false）→ 真正降级，日志带**真实信号**
          //     （parseError 或 call.kind），meta 的 rationale 也是该信号；
          //   - 阈值非法 → 降级（信号 invalid-threshold），fail-open 放行；
          //   - 评估跑通了但把握度不够（低于阈值）→ 不是降级，日志说「低于阈值」，
          //     meta 的 rationale 是模型的 reason。
          // 早先把前两者混在一条 'degraded' 日志里，导致信号位出现 'ok'，读日志的人
          // 会把「评估成功但没把握」误当成「模型调用失败」。
          if (!report.parse.ok) {
            const reason = report.parse.parseError ?? report.call.kind;
            console.warn(
              `[${name}] decision degraded (${reason}, confidence=${report.parse.confidence.toFixed(2)}); passing through`,
            );
            meta = buildDegradedMeta(reason);
          } else if (report.threshold.reason === 'invalid-threshold') {
            console.warn(
              `[${name}] decision degraded (invalid-threshold, confidence=${report.parse.confidence.toFixed(2)}); passing through`,
            );
            meta = buildDegradedMeta('invalid-threshold');
          } else {
            console.warn(
              `[${name}] decision below threshold (confidence=${report.parse.confidence.toFixed(2)}, threshold=${config.confidenceThreshold}); passing through`,
            );
            meta = buildAutoMeta(report.parse, 'passed-through');
          }
        }

        const result = await askThroughUserQuestions(
          userQuestions,
          questions,
          exec,
        );
        return { ...result, presentationMeta: meta };
      },
    }),
  );

  console.log(`[${name}] registered 1 tool (${ASK_USER_QUESTION_TOOL})`);
}

// re-export：loader 通过 `plugin.Config` 读 schemastery schema 生成设置面板
// （collectConfigSchemas）；不 re-export 会让设置面板不渲染本插件字段。
export { resolveConfig, Config } from '../core/config.ts';
export type { ResolvedConfig } from '../core/config.ts';
