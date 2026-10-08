/**
 * dsh-obsidian 工具层:把 Obsidian CLI 的高频子命令包成 dsh 工具。
 *
 * 选择标准(本插件第一版覆盖 7 个高频工具):
 * - read   : 读单条笔记 — 读 vault 最高频入口;
 * - create : 创建笔记 — 配合 read 闭环;
 * - append : 追加内容 — 写 vault 最高频入口(配合 daily 工具);
 * - search : 全文搜索 — 任何 vault 操作的预热;
 * - daily  : 日常笔记读/写 — 用户最常用的入口;
 * - properties : 列/读属性 — 配合 property:set 做元数据操作;
 * - vault  : vault 元信息 — 启动时定位当前 vault;
 *
 * 余下命令(daily:prepend / file:move / file:delete / property:set /
 * property:remove / plugin:* / snippet:* / command / open /
 * search:open / folders / reload / search:context / tags / file / files /
 * vaults / daily:path)由 obsidian_run(自由子命令)工具统一覆盖,避免
 * 每条子命令都写一遍 defineTool,同时为后续"暴露全部命令"留单一入口。
 *
 * 设计选择:
 * - 工厂函数接收 runner + 错误渲染器(便于单测注入假体 runner);
 * - 工具 execute 签名沿用 dsh-tools 公开类型 ToolRunContext;
 * - output.render 把结构化结果投影为 model 可见文本(教学版对齐
 *   dsh-taskboard 的做法);
 * - 错误一律 `[CODE] message` 文本(模型可解析);
 * - 所有写入类工具的 description 都明确写"会修改 vault",由 model
 *   自主决定是否再向用户确认(工具本身不强制
 *   二次确认闸,避免与宿主权限闸重复)。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { findCommand } from './commands.ts';
import {
  type ObsidianCallResult,
  OBSIDIAN_DEFAULT_TIMEOUT_MS,
  OBSIDIAN_ERROR_MESSAGES,
  type ObsidianErrorCode,
  ObsidianError,
} from './types.ts';
import {
  type ObsidianInvocation,
  type ObsidianRunnerOptions,
  runObsidian,
} from './runner.ts';

/** 工具构造参数:runner 选项 + 错误格式器。 */
export interface ObsidianToolsOptions {
  /** 传给 runObsidian 的 options(executable/spawner/env/now)。 */
  readonly runnerOptions?: ObsidianRunnerOptions;
  /**
   * 默认 vault 名(每次 invoke 时如未传 vault 且该值非空,
   * 自动注入到 argv,等价于 Obsidian CLI 的 `vault=<name>`)。
   * 生产场景通常从 settings.yaml 读;教学版给一个空默认。
   */
  readonly defaultVault?: string;
  /**
   * 错误格式器(把 ObsidianError 渲染成 model 可见文本)。
   * 默认用 [CODE] message 格式,与 dsh-taskboard 对齐。
   */
  readonly formatError?: (err: ObsidianError) => string;
}

/** 把 ObsidianError 渲染为模型可见的 [CODE] message 文本。 */
export function defaultFormatError(err: ObsidianError): string {
  return err.message;
}

/** 默认错误消息(OBSIDIAN_ERROR_MESSAGES 一份的镜像,这里只用作类型稳定锚点)。 */
export const ERROR_MESSAGES: Readonly<Record<ObsidianErrorCode, string>> =
  OBSIDIAN_ERROR_MESSAGES;

/** 工具结果的可读文本 — 头部命令名 + body。 */
function renderResult(r: ObsidianCallResult): string {
  const head = r.argv.join(' ');
  if (!r.stdout && !r.stderr) return `${head}\n(exit 0, no output)`;
  const parts: string[] = [
    `$ ${head}`,
    `exit: ${r.exitCode ?? 'null'}`,
    `(${r.durationMs}ms)`,
  ];
  if (r.stdout) parts.push('', '--- stdout ---', r.stdout);
  if (r.stderr) parts.push('', '--- stderr ---', r.stderr);
  return parts.join('\n');
}

/**
 * 统一 execute 包装器:把 spec 查找 / runner 输出 / 异常归一为 model 可见文本。
 *
 * 注意:此函数是工具 execute 的唯一入口,所有错误都收敛在它内部,
 * 让工具 layer 永远不会 throw(只 return string)— 避免 dsh-tools wrapper
 * 把 throw 转成 `ToolArgsError` 类的内部错误,破坏我们 `[CODE] message`
 * 错误码约定。spec 找不到、参数缺失、spawn 失败、协议错误 — 全部归一。
 */
async function runAndRender(
  commandName: string,
  args: Readonly<Record<string, string | boolean | undefined>>,
  callOptions: { vault?: string; timeoutMs?: number; signal?: AbortSignal },
  options: ObsidianToolsOptions,
): Promise<string> {
  const spec = findCommand(commandName);
  if (!spec) {
    const e = new ObsidianError(
      `[OBSIDIAN_INVALID_INPUT] 未知命令 ${commandName}`,
      'OBSIDIAN_INVALID_INPUT',
      { command: commandName },
    );
    return (options.formatError ?? defaultFormatError)(e);
  }
  const invocation: ObsidianInvocation = {
    spec,
    args,
    vault: callOptions.vault,
    timeoutMs: callOptions.timeoutMs ?? OBSIDIAN_DEFAULT_TIMEOUT_MS,
    signal: callOptions.signal,
  };
  try {
    const r = await runObsidian(invocation, options.runnerOptions);
    return renderResult(r);
  } catch (err) {
    if (err instanceof ObsidianError) {
      const fmt = options.formatError ?? defaultFormatError;
      return fmt(err);
    }
    const message = err instanceof Error ? err.message : String(err);
    return `[OBSIDIAN_SPAWN_FAILED] ${message}`;
  }
}

/** 工厂:创建 obsidian_* 工具集。返回 registerAll 钩子,由 apply() 调 ctx.tools.register。 */
export function createObsidianTools(options: ObsidianToolsOptions = {}): {
  registerAll(register: (tool: ReturnType<typeof defineTool>) => unknown): void;
} {
  // 把 defaultVault 抽到局部,避免每个工具都读 options。
  const defaultVault = options.defaultVault;

  const obsidianRead = defineTool({
    name: 'obsidian_read',
    description:
      '读取 Obsidian vault 中的指定笔记正文(path 必填;可选 vault 选择其它 vault)。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'vault 内相对路径(不含 .md 后缀)。',
      },
      vault: {
        type: 'string',
        description: '目标 vault 名;省略则用当前激活 vault。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : String(value),
        },
      ],
    },
    async execute(args, exec) {
      const a = args as { path: string; vault?: string };
      return runAndRender(
        'read',
        { path: a.path },
        { vault: a.vault ?? defaultVault, signal: exec.signal },
        options,
      );
    },
  });

  const obsidianCreate = defineTool({
    name: 'obsidian_create',
    description:
      '在 Obsidian vault 中创建一篇新笔记(写入操作)。已存在时需把 overwrite 设为 true 才覆盖,否则按协议失败。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'vault 内相对路径。',
      },
      content: {
        type: 'string',
        required: true,
        description: '笔记正文(支持 Markdown)。',
      },
      overwrite: { type: 'boolean', description: '存在时覆盖(默认 false)。' },
      vault: { type: 'string', description: '目标 vault 名。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : String(value),
        },
      ],
    },
    async execute(args, exec) {
      const a = args as {
        path: string;
        content: string;
        overwrite?: boolean;
        vault?: string;
      };
      return runAndRender(
        'create',
        { path: a.path, content: a.content, overwrite: a.overwrite === true },
        { vault: a.vault ?? defaultVault, signal: exec.signal },
        options,
      );
    },
  });

  const obsidianAppend = defineTool({
    name: 'obsidian_append',
    description:
      '向 Obsidian vault 中的现有笔记末尾追加内容(写入操作)。不会创建新笔记;若笔记不存在,Obsidian 会返回 Error。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'vault 内相对路径。',
      },
      content: { type: 'string', required: true, description: '追加的正文。' },
      vault: { type: 'string', description: '目标 vault 名。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : String(value),
        },
      ],
    },
    async execute(args, exec) {
      const a = args as { path: string; content: string; vault?: string };
      return runAndRender(
        'append',
        { path: a.path, content: a.content },
        { vault: a.vault ?? defaultVault, signal: exec.signal },
        options,
      );
    },
  });

  const obsidianSearch = defineTool({
    name: 'obsidian_search',
    description:
      '在 Obsidian vault 内搜索关键词(只读),返回匹配行。可用 path 限定子文件夹。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '搜索关键词或正则。',
      },
      path: { type: 'string', description: '限定子文件夹(可选)。' },
      vault: { type: 'string', description: '目标 vault 名。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : String(value),
        },
      ],
    },
    async execute(args, exec) {
      const a = args as { query: string; path?: string; vault?: string };
      return runAndRender(
        'search',
        { query: a.query, path: a.path },
        { vault: a.vault ?? defaultVault, signal: exec.signal },
        options,
      );
    },
  });

  const obsidianDailyRead = defineTool({
    name: 'obsidian_daily',
    description:
      '读取今日 Obsidian daily note 的正文(只读)。等价于 `obsidian daily:read`。',
    parameters: {
      vault: { type: 'string', description: '目标 vault 名。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : String(value),
        },
      ],
    },
    async execute(args, exec) {
      const a = args as { vault?: string };
      return runAndRender(
        'daily:read',
        {},
        { vault: a.vault ?? defaultVault, signal: exec.signal },
        options,
      );
    },
  });

  const obsidianDailyAppend = defineTool({
    name: 'obsidian_daily_append',
    description: '向今日 Obsidian daily note 末尾追加内容(写入操作)。',
    parameters: {
      content: { type: 'string', required: true, description: '追加的正文。' },
      vault: { type: 'string', description: '目标 vault 名。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : String(value),
        },
      ],
    },
    async execute(args, exec) {
      const a = args as { content: string; vault?: string };
      return runAndRender(
        'daily:append',
        { content: a.content },
        { vault: a.vault ?? defaultVault, signal: exec.signal },
        options,
      );
    },
  });

  const obsidianProperties = defineTool({
    name: 'obsidian_properties',
    description:
      '列出 Obsidian 笔记的 front-matter 属性(只读);带 file 时列单条笔记的全部属性,省略时列 vault 全局统计。',
    parameters: {
      file: { type: 'string', description: '限定单一文件(可选)。' },
      vault: { type: 'string', description: '目标 vault 名。' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : String(value),
        },
      ],
    },
    async execute(args, exec) {
      const a = args as { file?: string; vault?: string };
      return runAndRender(
        'properties',
        { file: a.file },
        { vault: a.vault ?? defaultVault, signal: exec.signal },
        options,
      );
    },
  });

  const obsidianVault = defineTool({
    name: 'obsidian_vault',
    description:
      '查看当前 Obsidian vault 的元信息(路径、插件数、笔记数等;只读)。等价于 `obsidian vault`。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : String(value),
        },
      ],
    },
    async execute(_args, exec) {
      return runAndRender(
        'vault',
        {},
        { vault: defaultVault, signal: exec.signal },
        options,
      );
    },
  });

  /**
   * 自由子命令工具:把 commands.ts 里所有命令暴露为单一入口,
   * 覆盖未单独 defineTool 的子命令(daily:prepend / file:move /
   * file:delete / property:* / plugin:* / snippet:* / command /
   * open / search:open / folders / reload / search:context / tags /
   * file / files / vaults / daily:path / daily:read / daily:append 等)。
   * model 知道完整命令名才能调,description 强制写明 command 必填
   * 且必须取自 commands.ts 的清单(防虚构)。
   */
  const obsidianRun = defineTool({
    name: 'obsidian_run',
    description:
      '通用入口:执行任意 Obsidian CLI 子命令(教学版工具集未单独导出的命令走这里)。' +
      'command 必填,必须取自 `commands.ts` 的命令清单(见 system-prompt section);' +
      'args 按命令的 params 顺序拼 `key=value`,布尔标志用 true 触发。',
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Obsidian CLI 子命令名(如 `file:move`、`property:set`)。',
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description:
          '参数对象(键名 = 参数名,值 = string | boolean;布尔 true 拼为 `name=true`)。',
      },
      vault: { type: 'string', description: '目标 vault 名。' },
      timeoutMs: {
        type: 'number',
        description: '超时(毫秒,默认 30000,上限 600000)。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value === 'string' ? value : String(value),
        },
      ],
    },
    async execute(args, exec) {
      const a = args as {
        command: string;
        args?: Record<string, string | boolean>;
        vault?: string;
        timeoutMs?: number;
      };
      return runAndRender(
        a.command,
        a.args ?? {},
        {
          vault: a.vault ?? defaultVault,
          timeoutMs: a.timeoutMs,
          signal: exec.signal,
        },
        options,
      );
    },
  });

  /** tools 注册集合(全部 9 个)。 */
  const allTools = [
    obsidianRead,
    obsidianCreate,
    obsidianAppend,
    obsidianSearch,
    obsidianDailyRead,
    obsidianDailyAppend,
    obsidianProperties,
    obsidianVault,
    obsidianRun,
  ];

  return {
    /** 把全部 tools 一次性注册到 ctx.tools(注册 disposer 由 ctx.effect 负责)。 */
    registerAll(register) {
      for (const t of allTools) register(t);
    },
  };
}
