/**
 * dsh-open-design 诊断工具：查看当前生效配置与连接状态、手动重跑探测。
 *
 * 这两个工具与「上游 MCP 工具」是两套东西：
 *   - 上游工具：由 Open Design 的 MCP 服务端提供，数量随上游版本浮动
 *     （Open Design 0.27.2 基线 22 个，见 UPSTREAM_TOOL_COUNT_BASELINE）；
 *   - 诊断工具：插件自带，固定 2 个（本文件）。
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { SidecarStamp } from './config.ts';
import { toJsonRecord, type JsonValue } from './core/json.ts';

/** 诊断工具名（固定两个，README / docs / 契约测试与此保持一致）。 */
export const STATUS_TOOL_NAME = 'open_design_status';
export const REDETECT_TOOL_NAME = 'open_design_redetect';

/** 插件自带诊断工具的数量。 */
export const DIAGNOSTIC_TOOL_COUNT = 2;

/** 诊断快照：当前生效配置 + 探测结果 + 连接状态。 */
export interface DiagnosticReport {
  autoDetect: boolean;
  serverName: string;
  source: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  startupTimeoutMs: number;
  toolCallTimeoutMs: number;
  detectionMethod: string;
  installed: boolean;
  stamp: SidecarStamp | null;
  endpoint: string;
  installDir: string;
  dataDir: string;
  daemonCliPath: string;
  connectionState: string;
  failedAttempts: number;
  maxAttempts: number;
  lastError: string | null;
  upstreamToolCount: number;
  /** 最近一次同步中被跳过的上游工具名单（schema 不受宿主支持等）。 */
  upstreamSkippedTools: string[];
  diagnosticToolCount: number;
  configFile: string;
}

/** 诊断工具依赖的运行时能力（由 runtime.ts 实现）。 */
export interface DiagnosticRuntime {
  /** 取当前生效配置与连接状态的快照。 */
  status(): DiagnosticReport;
  /** 重跑安装环境探测，并按新结果刷新连接。 */
  redetect(): Promise<DiagnosticReport>;
}

/** 统一输出声明：开放 object schema + JSON 文本渲染。 */
function outputSpec(): {
  schema: { type: 'object'; additionalProperties: true };
  render: (
    args: unknown,
    value: unknown,
  ) => Array<{ type: 'text'; text: string }>;
} {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [
      { type: 'text', text: JSON.stringify(value, null, 2) },
    ],
  };
}

/**
 * 构造两个诊断工具。
 *
 * @param runtime 运行时能力提供者。
 */
export function createDiagnosticTools(
  runtime: DiagnosticRuntime,
): ToolDefinition[] {
  return [
    defineTool({
      name: STATUS_TOOL_NAME,
      description:
        '查看 Open Design MCP 插件的当前状态：生效的连接配置（source/command/args/env）、安装环境探测结果、管道端点、MCP 连接状态与已注册的上游工具数量。排查「连不上 / 工具为空 / 端点失效」时先调它。',
      parameters: {},
      output: outputSpec(),
      async execute(): Promise<Record<string, JsonValue>> {
        return toJsonRecord(
          runtime.status() as unknown as Record<string, unknown>,
        );
      },
    }),
    defineTool({
      name: REDETECT_TOOL_NAME,
      description:
        '重新检测 Open Design 的安装环境（推算管道端点、定位可执行文件与守护进程脚本），并按新结果刷新 MCP 连接与已注册的上游工具。Open Design 刚安装/升级后调用一次即可。',
      parameters: {},
      output: outputSpec(),
      async execute(): Promise<Record<string, JsonValue>> {
        const report = await runtime.redetect();
        return toJsonRecord(report as unknown as Record<string, unknown>);
      },
    }),
  ];
}
