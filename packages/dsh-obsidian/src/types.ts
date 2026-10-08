/**
 * dsh-obsidian 公共类型定义。
 *
 * 设计要点:
 * - Obsidian CLI 的命令是 `obsidian <command> [options]`,其中 options
 *   形如 `key=value`(无空格),这是 Obsidian 官方约定的语法;
 *   我们不发明新语法,只是把这条约定在 dsh 工具层做参数化抽象。
 * - 命令族别(Family)用于 system-prompt section 归类,以及危险等级控制。
 * - "危险等级"用作协议闸的依据:写入类(destructive=warn)在 system
 *   prompt 里要求 agent 二次确认,执行类(execute)直接走宿主权限闸。
 */

/** Obsidian CLI 子命令族。 */
export type ObsidianCommandFamily =
  | 'file'
  | 'daily'
  | 'search'
  | 'property'
  | 'plugin-snippet'
  | 'command'
  | 'vault';

/**
 * 单条命令的危险等级:
 * - read — 纯读取(读 vault、读笔记、读属性、列命令等),无副作用;
 * - write — 写入 vault(create / append / prepend / set property),可恢复;
 * - destructive — 破坏性(delete / plugin:disable / snippet:disable),需要协议闸确认;
 * - execute — 在 Obsidian 进程内执行任意命令(`obsidian command id=...`),
 *   行为取决于被执行的命令,危险等级未知 — 走宿主权限审批。
 */
export type ObsidianDangerLevel = 'read' | 'write' | 'destructive' | 'execute';

/** 单条 CLI 命令的元信息。 */
export interface ObsidianCommandSpec {
  /** Obsidian CLI 子命令名(去掉 `obsidian` 前缀,只保留动词+可选冒号后的对象)。 */
  readonly name: string;
  /** 族别。 */
  readonly family: ObsidianCommandFamily;
  /** 危险等级(决定 system-prompt 是否要求二次确认,以及是否在 README 标红)。 */
  readonly danger: ObsidianDangerLevel;
  /** 一句话中文说明(供 model 看的语义)。 */
  readonly description: string;
  /** 参数列表(按出现顺序拼接为 `key=value`);若为 readonly 标志,值为空字符串即可。 */
  readonly params: readonly ObsidianCommandParam[];
}

/** 单个参数的元信息。 */
export interface ObsidianCommandParam {
  /** 参数名(原样拼到 `key=` 之前)。 */
  readonly name: string;
  /** 是否必填(用于 schema 校验 + 协议提示)。 */
  readonly required: boolean;
  /** 中文说明(供 model 看的语义)。 */
  readonly description: string;
}

/** 一次 Obsidian CLI 调用的结果。 */
export interface ObsidianCallResult {
  /** Obsidian CLI 进程的退出码(0/非 0;Obsidian 0 = 调用语法 OK,语义错误由 stdout 前缀判定)。 */
  readonly exitCode: number | null;
  /** stdout 文本(已去尾随换行)。 */
  readonly stdout: string;
  /** stderr 文本(已去尾随换行)。 */
  readonly stderr: string;
  /** 本次调用的实际 argv(供调试 + 日志)。 */
  readonly argv: readonly string[];
  /** 调用的耗时(毫秒)。 */
  readonly durationMs: number;
}

/** Obsidian CLI 自定义错误。 */
export class ObsidianError extends Error {
  constructor(
    message: string,
    readonly code: ObsidianErrorCode,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ObsidianError';
  }
}

/** 错误码。 */
export type ObsidianErrorCode =
  | 'OBSIDIAN_CLI_NOT_FOUND' // 找不到 obsidian 二进制
  | 'OBSIDIAN_INVALID_INPUT' // 我们的 schema 校验失败
  | 'OBSIDIAN_SPAWN_FAILED' // spawn 本身失败(权限等)
  | 'OBSIDIAN_TIMEOUT' // 超时
  | 'OBSIDIAN_NONZERO_EXIT' // 子进程退出码非 0
  | 'OBSIDIAN_PROTOCOL_ERROR'; // stdout 以 "Error:" 开头(Obsidian 约定的错误前缀)

/** 错误码 → 文案(供工具 result 渲染)。 */
export const OBSIDIAN_ERROR_MESSAGES: Readonly<
  Record<ObsidianErrorCode, string>
> = {
  OBSIDIAN_CLI_NOT_FOUND:
    '在 PATH 上找不到 `obsidian` 可执行文件。请确认 Obsidian 已安装并且 `obsidian` 命令(由 Obsidian 应用安装)已在 PATH 中;或在工具调用前用 `obsidian` 命令手动验证。',
  OBSIDIAN_INVALID_INPUT: '参数校验失败。',
  OBSIDIAN_SPAWN_FAILED: '无法启动 obsidian 子进程。',
  OBSIDIAN_TIMEOUT: 'obsidian 命令执行超时。',
  OBSIDIAN_NONZERO_EXIT: 'obsidian 命令退出码非 0。',
  OBSIDIAN_PROTOCOL_ERROR: 'obsidian 返回语义错误(见 stdout)。',
};

/** Obsidian CLI 把"语义错误"统一以前缀 "Error:" 开头返回 stdout(退出码 0)。 */
export const OBSIDIAN_ERROR_PREFIX = 'Error:';

/** 单条 stdout 文本上限(避免单条巨大响应阻塞 model 上下文)。 */
export const OBSIDIAN_STDOUT_CAP = 20_000;
/** stderr 文本上限。 */
export const OBSIDIAN_STDERR_CAP = 4_000;
/** 默认单次调用超时(30s)。 */
export const OBSIDIAN_DEFAULT_TIMEOUT_MS = 30_000;
/** 硬上限(10 min)。 */
export const OBSIDIAN_MAX_TIMEOUT_MS = 600_000;
