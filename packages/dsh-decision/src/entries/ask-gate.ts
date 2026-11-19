/**
 * ask-gate 插件行（决策门控系列 1/4）。
 *
 * ## 它在包里的角色
 *
 * `@zhidal/dsh-decision` 是**决策域组合包**：包内每个「决策点」是一个独立
 * 插件行，命名规则为 `<决策点>-gate`（本卡只有 `ask-gate`）。
 *
 * - 本文件 = **插件行 ask-gate**：接管模型侧的提问工具 `ask_user_question`。
 *
 * ## 1/4 阶段做什么、不做什么
 *
 * 做：注册一个与**出厂 legacy 模式 schema 兼容**的同名工具
 * `ask_user_question`，执行路径直通宿主 `ctx.userQuestions.ask()`，
 * 因此提问照常发给用户、答案照常回传，行为与出厂完全一致。
 *
 * 不做（留给 2/4、3/4）：门控判定逻辑、决策模型调用、tool-gate/route-gate。
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
 * 本行**原样透传**，不吞不改、不改写文案。
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { resolveConfig, type ResolvedConfig } from '../core/config.ts';
import {
  askThroughUserQuestions,
  type AskGateQuestion,
} from '../services/ask-gate.ts';

/** Cordis 插件名（loader 依赖）；与包内决策点成员名一致。 */
export const name = 'ask-gate';

/** 依赖注入：工具注册表 + 宿主提问服务。 */
export const inject: string[] = ['tools', 'userQuestions'];

/** 工具名：与出厂 ask_user_question 同名（本行接管该工具面）。 */
export const ASK_USER_QUESTION_TOOL = 'ask_user_question';

/**
 * 工具描述：与出厂 legacy 模式逐字一致，保证模型侧行为不因换实现而漂移。
 */
export const ASK_USER_QUESTION_DESCRIPTION =
  'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.';

/** 工具入参 schema：与出厂 legacy 模式逐字兼容（含 additionalProperties）。 */
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

/** 工具出参 schema：与出厂 legacy 模式逐字兼容。 */
export const ASK_USER_QUESTION_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false as const,
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
  //    总开关默认关闭＝不介入＝直通原版提问；1/4 阶段即使开启也仍然直通
  //    （门控判定留给 2/4），因此这里两条分支行为一致。
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
          // 默认路径：完全直通，行为与出厂一致。
          return askThroughUserQuestions(userQuestions, questions, exec);
        }
        // 2/4 起在此插入门控判定（放行 / 改写 / 转决策模型）；1/4 仍直通。
        return askThroughUserQuestions(userQuestions, questions, exec);
      },
    }),
  );

  console.log(`[${name}] registered 1 tool (${ASK_USER_QUESTION_TOOL})`);
}

// re-export：loader 通过 `plugin.Config` 读 schemastery schema 生成设置面板
// （collectConfigSchemas）；不 re-export 会让设置面板不渲染本插件字段。
export { resolveConfig, Config } from '../core/config.ts';
export type { ResolvedConfig } from '../core/config.ts';
