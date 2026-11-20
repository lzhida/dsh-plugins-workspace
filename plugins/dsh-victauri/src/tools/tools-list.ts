/**
 * 服务端动态工具发现工具（`victauri_tools_list`）。
 *
 * 目的：让模型能查询 Victauri 服务端**当前实际**的工具面，消除「服务端新增了
 * 工具、插件侧看不到」的盲区；同时把插件静态暴露面与服务端清单的差异以告警形式
 * 呈现（告警不阻断）。
 *
 * 与既有桥接工具的关系：
 * - 本工具**不走** POST /api/tools/{name} 的执行通道，而是只读调用
 *   `client.listTools()`（GET /api/tools）；
 * - **不做动态注册**——工具面保持静态（standalone 20 + compound 15 + CLI 桥 1 +
 *   CLI 探测 1 + 本工具 1），由契约测试锁定数量与唯一性，避免服务端工具面漂移
 *   打穿参数 schema 契约；
 * - 差异告警只提示不阻断：服务端有而插件没暴露 → `not_exposed`（插件版本落后）；
 *   插件暴露而服务端没有 → `missing_on_server`（服务端较旧或该工具已下线）。
 *
 * 关于 `client.health()`：**有意不接线到工具面**——连接建立路径
 * （`connectAuto` → `info()`）已做带认证探活，失败以 `no-instance` /
 * `no-live-instance` 结构化错误返回，比 `health()` 的布尔更可诊断；本工具调用
 * 成功本身即证明服务在线，再加一个探针只会多一次往返与一个工具位。`health()`
 * 保留为 client 公开 API（单测覆盖），不作为「已实现未接线」的悬空项。
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { VictauriClientLike } from '../client.ts';
import { isVictauriError } from '../errors.ts';
import type { JsonValue } from '../json.ts';
import { COMPOUND_TOOL_SPECS } from './compound/catalog.ts';
import { SELF_CHECK_HINT } from './standalone/bridge.ts';
import { REST_TOOL_SPECS } from './standalone/catalog.ts';

/** dsh 侧工具全名。 */
export const TOOLS_LIST_TOOL_NAME = 'victauri_tools_list';

/** 单条工具描述截断长度（include_descriptions=true 时生效）。 */
export const TOOL_DESCRIPTION_MAX_CHARS = 200;

/**
 * 差异告警类别——**工具发现域自有词汇表**（not_exposed / missing_on_server），
 * 描述的是「某个上游工具在本插件暴露面与服务端清单之间的差异」。
 *
 * 与另外两套词汇表**相互独立、不可互相比较**：
 * - `src/errors.ts` 的 `VictauriErrorKind`——**REST 桥接错误信封**封闭词汇表，
 *   描述调用失败的原因（no-instance / http-error / tool-error …）；
 * - `src/tools/cli-status.ts` 的 `CliStatusError.kind`——**CLI 探测域**自有
 *   词汇表（not_found / cli-error / timeout）。
 *
 * 注意：本工具 `ToolsListResult.error` 字段里的 `kind` 是**自由字符串**
 * （类型上写作 `string`），沿用 REST 桥接信封的取值，也可能取兜底值 `unknown`——
 * 它本身不构成第四套封闭词汇表。
 */
export type ToolsListWarningKind =
  /** 服务端提供、插件未暴露（插件版本落后于服务端）。 */
  | 'not_exposed'
  /** 插件暴露、服务端未提供（服务端版本较旧或该工具已下线）。 */
  | 'missing_on_server';

/** 单条差异告警。 */
export interface ToolsListWarning {
  kind: ToolsListWarningKind;
  name: string;
  message: string;
}

/** 工具发现结果（返回给模型的结构化值）。 */
export interface ToolsListResult {
  /** 服务端工具名清单（按服务端返回顺序去重）。 */
  tools: string[];
  /** 服务端工具条数。 */
  server_count: number;
  /** 插件侧静态暴露的服务端工具条数（standalone + compound）。 */
  exposed_count: number;
  /** 工具面完全一致（无差异告警）。 */
  in_sync: boolean;
  /** 差异告警（空数组 = 一致）。 */
  warnings: ToolsListWarning[];
  /** 工具描述（include_descriptions=true 时才有）。 */
  descriptions?: Record<string, string>;
  /** 失败时的结构化错误；成功为 null。 */
  error: { kind: string; message: string; hint: string } | null;
}

/** 运行期依赖：惰性取连接（与桥接工具同一 client 实例）。 */
export interface ToolsListDeps {
  getClient: () => Promise<VictauriClientLike>;
}

/**
 * 插件侧静态暴露的服务端工具名（standalone 20 + compound 15）。
 *
 * 这份名单是「插件能调用什么」的事实源；服务端清单是「服务端有什么」的事实源；
 * 两者比对即差异告警。
 */
export function exposedServerToolNames(): string[] {
  return [
    ...REST_TOOL_SPECS.map((spec) => spec.name),
    ...COMPOUND_TOOL_SPECS.map((spec) => spec.name),
  ];
}

/**
 * 比对服务端清单与插件暴露面，产出差异告警（纯函数，便于单测）。
 *
 * @param serverNames - 服务端返回的工具名（调用方需先去重）。
 * @param exposedNames - 插件暴露的服务端工具名。
 */
export function diffToolNames(
  serverNames: readonly string[],
  exposedNames: readonly string[],
): ToolsListWarning[] {
  const server = new Set(serverNames);
  const exposed = new Set(exposedNames);
  const warnings: ToolsListWarning[] = [];
  for (const name of serverNames) {
    if (exposed.has(name)) continue;
    warnings.push({
      kind: 'not_exposed',
      name,
      message: `服务端提供工具 '${name}'，但本插件未暴露（插件版本落后于服务端，无法直接调用）`,
    });
  }
  for (const name of exposedNames) {
    if (server.has(name)) continue;
    warnings.push({
      kind: 'missing_on_server',
      name,
      message: `插件暴露工具 '${name}'，但服务端未提供（服务端版本较旧或该工具已下线）`,
    });
  }
  return warnings;
}

/** 渲染工具发现结果（模型可见文本）。 */
function renderToolsList(value: ToolsListResult): ContentBlock[] {
  const lines: string[] = [];
  if (value.error) {
    lines.push(
      `victauri 工具发现失败(${value.error.kind}): ${value.error.message}`,
    );
    lines.push(value.error.hint);
    return [{ type: 'text', text: lines.join('\n') }];
  }
  lines.push(
    `服务端工具面 ${value.server_count} 个；插件暴露 ${value.exposed_count} 个` +
      (value.in_sync ? '（一致）' : '（存在差异，见下方告警）'),
  );
  for (const name of value.tools) {
    const description = value.descriptions?.[name];
    lines.push(description ? `- ${name}: ${description}` : `- ${name}`);
  }
  for (const warning of value.warnings) {
    lines.push(`⚠ ${warning.message}`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * `victauri_tools_list` 工具工厂。
 *
 * 只读工具：不执行任何服务端工具，只查询工具面并比对差异。
 */
export function createToolsListTool(deps: ToolsListDeps): ToolDefinition {
  return defineTool({
    name: TOOLS_LIST_TOOL_NAME,
    description: [
      '查询 Victauri 服务端当前实际提供的工具面（只读，GET /api/tools）。',
      '返回服务端工具名清单与条数，并把服务端清单与本插件静态暴露面的差异以 warnings 告警呈现：',
      'not_exposed=服务端提供但插件未暴露（插件版本落后，无法直接调用）；',
      'missing_on_server=插件暴露但服务端未提供（服务端较旧或工具已下线）。',
      '告警只提示不阻断；工具面保持静态注册，服务端新增工具不会自动注册为 dsh 工具。',
      '传 include_descriptions=true 可附带服务端工具描述（默认只返回名称清单以控制上下文占用）。',
    ].join(' '),
    parameters: {
      include_descriptions: {
        type: 'boolean',
        description:
          '附带服务端工具描述（默认 false：只返回名称清单，控制上下文占用）',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) =>
        renderToolsList(value as unknown as ToolsListResult),
    },
    timeoutMs: 30_000,
    execute: async (args) => {
      const includeDescriptions = args.include_descriptions === true;
      const exposed = exposedServerToolNames();
      try {
        const client = await deps.getClient();
        const serverTools = await client.listTools();
        const tools: string[] = [];
        const seen = new Set<string>();
        for (const tool of serverTools) {
          if (seen.has(tool.name)) continue;
          seen.add(tool.name);
          tools.push(tool.name);
        }
        const warnings = diffToolNames(tools, exposed);
        const result: ToolsListResult = {
          tools,
          server_count: tools.length,
          exposed_count: exposed.length,
          in_sync: warnings.length === 0,
          warnings,
          error: null,
        };
        if (includeDescriptions) {
          const descriptions: Record<string, string> = {};
          for (const tool of serverTools) {
            const description =
              typeof tool.description === 'string' ? tool.description : '';
            if (description === '') continue;
            descriptions[tool.name] = description.slice(
              0,
              TOOL_DESCRIPTION_MAX_CHARS,
            );
          }
          result.descriptions = descriptions;
        }
        return result as unknown as Record<string, JsonValue>;
      } catch (err) {
        const kind = isVictauriError(err) ? err.kind : 'unknown';
        const message = err instanceof Error ? err.message : String(err);
        const failure: ToolsListResult = {
          tools: [],
          server_count: 0,
          exposed_count: exposed.length,
          in_sync: false,
          warnings: [],
          error: { kind, message, hint: SELF_CHECK_HINT },
        };
        return failure as unknown as Record<string, JsonValue>;
      }
    },
  });
}
