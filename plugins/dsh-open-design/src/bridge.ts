/**
 * Open Design MCP 工具桥：把上游 MCP 工具翻译成宿主可注册的工具定义。
 *
 * 语义对齐宿主的 `@deepseek-ai/dsh-mcp-client` 工具层：
 *
 * - 工具名统一走 `publicToolName`：加 `mcp__<server>__` 前缀、非法字符替换、
 *   超长或被改写时追加 sha256 摘要后缀——**改名而不是丢弃**。
 * - `parameters` 直接透传上游 `inputSchema`（上游 schema 是权威契约，
 *   不做 dsh 风格的二次转换）。
 * - `execute` 里上游返回 `isError: true` 必须抛错，绝不当成成功结果吞掉。
 * - `syncTools` 两阶段：先构建全量工具（单个工具 schema 不受支持时跳过该工具
 *   并记入 skipped，其余照常注册；公开名冲突仍整体放弃、旧工具保持不变），
 *   再统一换装（注销旧 disposer → 注册新工具）。
 */

import { createHash } from 'node:crypto';

import {
  assertSupportedJsonSchema,
  defineTool,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools';
import type { InferValue, ToolDefinition } from '@deepseek-ai/dsh-tools';
import { specTypeSchemas } from '@modelcontextprotocol/client';

/** 上游 MCP 工具的最小描述（本插件只关心这三项）。 */
export interface UpstreamTool {
  /** 上游工具名（MCP 原名）。 */
  name: string;
  /** 上游工具描述。 */
  description?: string;
  /** 上游 inputSchema（原样透传给宿主）。 */
  inputSchema: Record<string, unknown>;
}

/** 调用上游工具的执行器（由连接层注入）。 */
export interface ToolCallExecutor {
  (name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** 宿主工具注册面（ctx.tools.register 的最小接口，便于单测注入）。 */
export interface BridgeTarget {
  /** 注册一个工具定义，返回注销函数。 */
  register(definition: unknown): () => void;
}

/** 一次 syncTools 的结果：注册数与被跳过的上游工具名单。 */
export interface SyncToolsResult {
  /** 实际注册的公开工具数。 */
  registered: number;
  /** 因 schema 不受支持等原因被跳过的上游工具名。 */
  skipped: string[];
}

/** 工具桥句柄。 */
export interface BridgeHandle {
  /** 用上游工具全量替换当前注册的工具，返回注册/跳过统计。 */
  syncTools(tools: UpstreamTool[]): SyncToolsResult;
  /** 注销当前注册的全部工具。 */
  dispose(): void;
}

/**
 * 工具输出 schema（与宿主 dsh-mcp-client 的 createOutput 等价）：
 * 固定 content 数组 + 可选 structuredContent，且 additionalProperties 为 false。
 *
 * `items` 省略即「接受任意 JSON 项」（dsh-tools 类型层直支持，无需依赖
 * `type:'json'` 的编译归一）；`required: true` 是 dsh 的属性级标注，
 * 编译后等价于宿主的顶层 `required: ['content']`。
 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: { type: 'array', required: true },
    structuredContent: { type: 'json' },
  },
} as const;

/** 规范化结果的类型（由输出 schema 推导，避免手抄一份契约）。 */
type McpToolValue = InferValue<typeof OUTPUT_SCHEMA>;

/**
 * 计算公开工具名。
 *
 * - 正常形态：`mcp__<serverName>__<rawName>`；
 * - 含非法字符时把非法字符替换为 `_`，并追加 sha256(serverName\0rawName) 前 12 位；
 * - 长度超过 64 时截断到 51 位并追加同样的摘要后缀（总长恒为 64）。
 *
 * 与宿主实现逐字一致，保证同名 MCP 服务器在宿主里的工具名也一致。
 */
export function publicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
  if (normalized === joined && normalized.length <= 64) return normalized;
  const hash = createHash('sha256')
    .update(`${serverName}\0${rawName}`)
    .digest('hex')
    .slice(0, 12);
  return `${normalized.slice(0, 64 - 12 - 1)}_${hash}`;
}

/**
 * 构建单个工具定义。
 *
 * @param serverName MCP 服务器名（用于公开工具名）。
 * @param upstreamTool 上游工具描述。
 * @param callTool 调用上游工具的执行器。
 */
export function buildToolDefinition(
  serverName: string,
  upstreamTool: UpstreamTool,
  callTool: ToolCallExecutor,
): ToolDefinition {
  const rawName = upstreamTool.name;
  const name = publicToolName(serverName, rawName);
  // 上游 inputSchema 是权威契约：先确认它落在宿主支持的 JSON Schema 子集内，
  // 再原样透传给宿主（不做 dsh 风格的二次转换）。
  const parameters: Record<string, unknown> = upstreamTool.inputSchema;
  const schema: unknown = upstreamTool.inputSchema;
  assertSupportedJsonSchema(schema);

  const definition = defineTool({
    name,
    description: upstreamTool.description ?? `Open Design MCP 工具 ${rawName}`,
    // defineTool 的 parameters 是 dsh DSL（属性映射），编译后恒为「开放对象根」，
    // 承载不了上游的 required / additionalProperties 语义，
    // 故这里只放占位，最终 parameters 由下面的展开覆盖为上游原始 schema。
    parameters: {},
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: extractText(value.content ?? [], rawName) },
      ],
    },
    execute: async (args) => {
      const argsObject = normalizeArgs(args);
      const violations = validateJsonSchemaValue(schema, argsObject, 'args');
      if (violations.length > 0) {
        throw new Error(
          `Tool "${rawName}" received invalid arguments: ${violations.join('; ')}`,
        );
      }
      const rawResult = await callTool(rawName, argsObject);
      const parsed =
        specTypeSchemas.CallToolResult['~standard'].validate(rawResult);
      if (parsed.issues) {
        throw new Error(
          `Tool "${rawName}" returned an invalid MCP result: ${parsed.issues
            .map((issue) => issue.message)
            .join('; ')}`,
        );
      }
      const result = parsed.value;
      // 上游用 isError 表达「调用失败」，必须抛出去，不能当成成功结果吞掉。
      if (result.isError === true) {
        throw new Error(extractText(result.content, rawName));
      }
      const value: McpToolValue = {
        content: result.content as unknown as McpToolValue['content'],
        ...(result.structuredContent !== undefined
          ? {
              structuredContent:
                result.structuredContent as unknown as McpToolValue['structuredContent'],
            }
          : {}),
      };
      return value;
    },
  });

  return { ...definition, parameters };
}

/**
 * 创建工具桥。
 *
 * @param target 宿主工具注册面。
 * @param serverName MCP 服务器名。
 * @param callTool 调用上游工具的执行器（连接层注入）。
 */
export function createBridge(
  target: BridgeTarget,
  serverName: string,
  callTool?: ToolCallExecutor,
): BridgeHandle {
  let disposers: Array<() => void> = [];
  const executor: ToolCallExecutor = async (name, args) => {
    if (!callTool) {
      throw new Error(
        `[dsh-open-design] MCP 连接不可用，无法调用工具 "${name}"`,
      );
    }
    return await callTool(name, args);
  };

  const disposeAll = (): void => {
    const current = disposers;
    disposers = [];
    for (const disposer of current) {
      try {
        disposer();
      } catch {
        // 单个工具注销失败不应阻断其余工具的注销。
      }
    }
  };

  return {
    syncTools(tools: UpstreamTool[]): SyncToolsResult {
      // 阶段一：先把全量工具定义构建出来。单个工具的 schema 不受宿主支持时
      // 跳过该工具并记入 skipped（宿主 dsh-mcp-client 对上游 schema 是透传的，
      // 本插件多一层校验就必须多一层容错，避免上游一个新关键字拖垮全部工具）；
      // 公开名冲突属于结构性错误，仍整体放弃——旧一代注册保持原样。
      const built: ToolDefinition[] = [];
      const skipped: string[] = [];
      const names = new Set<string>();
      for (const upstreamTool of tools) {
        let definition: ToolDefinition;
        try {
          definition = buildToolDefinition(serverName, upstreamTool, executor);
        } catch (error) {
          skipped.push(upstreamTool.name);
          console.warn(
            `[dsh-open-design] 跳过上游工具 "${upstreamTool.name}"：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          continue;
        }
        if (names.has(definition.name)) {
          throw new Error(
            `上游工具 "${upstreamTool.name}" 与其它工具映射到同一公开工具名 "${definition.name}"`,
          );
        }
        names.add(definition.name);
        built.push(definition);
      }
      // 阶段二：统一换装——先注销旧一代，再注册新一代。
      disposeAll();
      const next: Array<() => void> = [];
      try {
        for (const definition of built) {
          next.push(target.register(definition));
        }
      } catch (error) {
        // 注册冲突：回滚本次已注册的全部工具，避免留下半套工具。
        for (const disposer of next) {
          try {
            disposer();
          } catch {
            // 回滚阶段的注销失败只能记录，无法再补救。
          }
        }
        throw error;
      }
      disposers = next;
      return { registered: next.length, skipped };
    },
    dispose(): void {
      disposeAll();
    },
  };
}

/** 把参数规整成普通对象（非对象一律按空对象处理，让 schema 校验去报错）。 */
function normalizeArgs(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * 从 MCP 内容块里抽出模型可见的纯文本。
 *
 * 图片 / 音频等二进制块在 MVP 里只留占位说明：宿主 dsh-mcp-client 会把它们
 * 投影到 ctx.attachment，本插件暂未实现该投影（见 README 的 MVP 边界说明）。
 */
function extractText(content: readonly unknown[], toolName: string): string {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    parts.push(describeBlock(block as ContentBlockLike));
  }
  if (parts.length === 0) return `(${toolName} 未返回模型可见内容)`;
  return parts.join('\n');
}

/** 内容块的最小结构（只取描述占位文本需要的字段）。 */
interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
  mimeType?: unknown;
  name?: unknown;
  uri?: unknown;
}

/** 把单个内容块描述成一行模型可见文本。 */
function describeBlock(block: ContentBlockLike): string {
  const type = typeof block.type === 'string' ? block.type : 'unknown';
  switch (type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'image':
      return `[图片结果暂不支持：${stringOr(block.mimeType, '未知类型')}]`;
    case 'audio':
      return `[音频结果暂不支持：${stringOr(block.mimeType, '未知类型')}]`;
    case 'resource':
      return `资源内容：${stringOr(block.uri, '未知地址')}`;
    case 'resource_link':
      return `资源链接：${stringOr(block.name, '未命名')}（${stringOr(block.uri, '未知地址')}）`;
    default:
      return `[不支持的 MCP 内容类型：${type}]`;
  }
}

/** 取字符串，缺省时回退到占位文案。 */
function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}
