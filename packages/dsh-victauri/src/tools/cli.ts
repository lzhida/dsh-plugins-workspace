import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types';

import {
  CLI_ACTIONS,
  isCliAction,
  runVictauriCli,
  CLI_DEFAULT_TIMEOUT_MS,
  type CliRunOptions,
  type CliRunResult,
} from '../cli.ts';
import { buildActionHint, buildCliToolDescription } from '../cli-hints.ts';
import { parseDoctorReportFromStreams } from '../cli-doctor.ts';
import { getCliStatus } from './cli-status.ts';

/**
 * 宿主侧工具预算（也是 timeout_ms 的实际上限，M-10a）：
 * 超过它的 timeout_ms 会被夹到本值——避免「宿主已放弃工具调用、
 * 子进程却按更大的超时定时器继续跑」的无界窗口。
 */
export const CLI_MAX_TIMEOUT_MS = 300_000;

/** 输出被截断时由 runVictauriCli 追加的标记。 */
const TRUNCATION_MARKER = '[truncated]';

/** CLI 输出预览：头部保留的字符数。 */
export const PREVIEW_HEAD_CHARS = 3000;
/** CLI 输出预览：尾部保留的字符数。 */
export const PREVIEW_TAIL_CHARS = 3000;
/** CLI 输出预览总上限（与 standalone/render.ts 的 RENDER_MAX_CHARS 对齐）。 */
export const PREVIEW_MAX_CHARS = 6000;

/**
 * CLI 输出预览截断：头尾双保留 + 省略标记。
 *
 * 只留头部会把尾部丢掉（真实报错往往在最后一行），故保留头尾各 3000 字符，
 * 中间用省略标记 + 省略字符数说明；按码点（Array.from）切片，避免切碎多字节字符。
 */
export function renderPreview(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= PREVIEW_MAX_CHARS) return text;
  const head = chars.slice(0, PREVIEW_HEAD_CHARS).join('');
  const tail = chars.slice(chars.length - PREVIEW_TAIL_CHARS).join('');
  const omitted = chars.length - PREVIEW_HEAD_CHARS - PREVIEW_TAIL_CHARS;
  return `${head}\n…(截断,省略中间 ${omitted} 字符,共 ${chars.length} 字符)\n${tail}`;
}

/** victauri_cli 工具工厂选项（cliPath / version / 依赖注入,均不暴露给模型）。 */
export interface VictauriCliToolOptions {
  /** victauri 可执行文件路径;默认按平台解析。 */
  cliPath?: string;
  /** 已知 CLI 版本;缺省时按需探测（60s 缓存）。 */
  version?: string | null;
  /** 版本探测实现（测试注入;默认走 victauri_cli_status 的探测）。 */
  probeVersion?: (cliPath?: string) => Promise<string | null>;
  /** CLI 执行实现（测试注入;默认走 runVictauriCli）。 */
  run?: (options: CliRunOptions) => Promise<CliRunResult>;
}

/**
 * 解析本次执行使用的 CLI 版本（版本感知的来源）。
 *
 * 优先级:显式注入 > 注入的探测实现 > victauri_cli_status 的探测（60s 缓存）。
 */
async function resolveCliVersion(
  options: VictauriCliToolOptions,
): Promise<string | null> {
  if (options.version !== undefined) return options.version;
  if (options.probeVersion !== undefined) {
    return await options.probeVersion(options.cliPath);
  }
  const status = await getCliStatus(options.cliPath);
  return status.version;
}

/** 是否只捕获到部分输出（超时强杀或输出被截断）。 */
function isPartialOutput(result: CliRunResult): boolean {
  if (result.timedOut) return true;
  return (
    result.stdout.includes(TRUNCATION_MARKER) ||
    result.stderr.includes(TRUNCATION_MARKER)
  );
}

/** victauri_cli 工具工厂:cliPath 仅注入(测试/自定义安装路径),不暴露给模型。 */
export function createVictauriCliTool(options: VictauriCliToolOptions = {}) {
  const run = options.run ?? runVictauriCli;
  return defineTool({
    name: 'victauri_cli',
    description: buildCliToolDescription(options.version ?? null),
    parameters: {
      action: {
        type: 'string',
        enum: CLI_ACTIONS,
        required: true,
        description: 'victauri 子命令名',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: '透传给子命令的参数列表(不含子命令名)',
      },
      timeout_ms: {
        type: 'integer',
        description: `子进程超时毫秒(默认 ${CLI_DEFAULT_TIMEOUT_MS};上限 ${CLI_MAX_TIMEOUT_MS}=宿主工具预算,超过会被夹到上限,避免宿主放弃后子进程仍在跑)`,
      },
      cwd: {
        type: 'string',
        description: '子进程工作目录(默认继承宿主)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            required: true,
            description: '实际执行的子命令',
          },
          exit_code: {
            oneOf: [{ type: 'integer' }, { type: 'null' }],
            required: true,
            description: '退出码;null=超时强杀或被信号终止',
          },
          stdout: {
            type: 'string',
            required: true,
            description: '标准输出全文',
          },
          stderr: {
            type: 'string',
            required: true,
            description: '标准错误全文',
          },
          timed_out: {
            type: 'boolean',
            required: true,
            description: '是否因超时被终止',
          },
          partial: {
            type: 'boolean',
            required: true,
            description: '是否只捕获到部分输出(超时强杀或输出被截断)',
          },
          cli_version: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            required: true,
            description:
              '探测到的 CLI 版本;null=未探测到(此时不给版本门控提示)',
          },
          hints: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: {
                type: 'string',
                required: true,
                description: '该子命令的一句话语义(含长驻/交互行为标记)',
              },
              notes: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '版本门控提示(按探测到的 CLI 版本过滤)',
              },
              long_running: {
                type: 'boolean',
                required: true,
                description: '是否长驻子命令(必须配合 timeout_ms)',
              },
              interactive: {
                type: 'boolean',
                required: true,
                description: '是否支持交互式 stdin',
              },
            },
            required: true,
            description: '该子命令的版本感知提示',
          },
          doctor: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  summary: {
                    oneOf: [{ type: 'string' }, { type: 'null' }],
                    required: true,
                    description: 'Summary 行原文;未识别到为 null',
                  },
                  passed: {
                    oneOf: [{ type: 'integer' }, { type: 'null' }],
                    required: true,
                    description: '通过数;未识别到为 null',
                  },
                  total: {
                    oneOf: [{ type: 'integer' }, { type: 'null' }],
                    required: true,
                    description: '检查项总数;未识别到为 null',
                  },
                  failed: {
                    oneOf: [{ type: 'integer' }, { type: 'null' }],
                    required: true,
                    description: '失败数;未识别到为 null',
                  },
                  warnings: {
                    oneOf: [{ type: 'integer' }, { type: 'null' }],
                    required: true,
                    description: '警告数;未识别到为 null',
                  },
                  checks: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        status: {
                          type: 'string',
                          enum: ['PASS', 'FAIL', 'WARN'],
                          required: true,
                          description: '检查项状态',
                        },
                        message: {
                          type: 'string',
                          required: true,
                          description: '检查项正文',
                        },
                        detail: {
                          oneOf: [{ type: 'string' }, { type: 'null' }],
                          required: true,
                          description: '缩进续行(补充说明);无则 null',
                        },
                      },
                    },
                    required: true,
                    description: '检查项明细(按输出顺序)',
                  },
                },
              },
              { type: 'null' },
            ],
            required: true,
            description:
              'doctor 子命令的结构化报告(依次解析 stdout 与 stderr;0.8.8 实测报告写在 stderr);非 doctor 子命令、或两路都识别不到报告时为 null(此时 stdout/stderr 原样保留)',
          },
        },
      },
      render: (_args, value) => {
        const head = [
          `victauri_cli ${value.action} exit=${String(value.exit_code)}`,
          value.timed_out ? '(timed out)' : '',
          value.partial ? '(partial output)' : '',
          value.cli_version === null
            ? '(cli version unknown)'
            : `(cli ${value.cli_version})`,
        ]
          .filter((part) => part !== '')
          .join(' ');
        const blocks: ContentBlock[] = [{ type: 'text', text: head }];
        const doctor = value.doctor;
        if (doctor !== null) {
          const lines = doctor.checks.map(
            (check) =>
              `  [${check.status}] ${check.message}` +
              (check.detail === null ? '' : ` — ${check.detail}`),
          );
          if (doctor.summary !== null) lines.push(`  ${doctor.summary}`);
          if (lines.length > 0) {
            blocks.push({ type: 'text', text: lines.join('\n') });
          }
        }
        const preview = renderPreview(value.stderr || value.stdout);
        if (preview) {
          blocks.push({ type: 'text', text: preview });
        }
        return blocks;
      },
    },
    timeoutMs: CLI_MAX_TIMEOUT_MS,
    execute: async (args) => {
      const { action, args: extraArgs, timeout_ms, cwd } = args;
      if (!isCliAction(action)) {
        // enum 已在参数校验拦截;此处兜底保证类型收窄
        throw new Error(`unknown victauri subcommand: ${action}`);
      }
      const version = await resolveCliVersion(options);
      // M-10a:timeout_ms 夹到宿主预算——宿主在 CLI_MAX_TIMEOUT_MS 放弃本工具调用,
      // 子进程超时不得大于它,否则出现「宿主已放弃、子进程仍在跑」的孤儿窗口。
      const requestedTimeoutMs = timeout_ms ?? CLI_DEFAULT_TIMEOUT_MS;
      // 参数 schema 无 minimum 关键字:0/负数在这里兜底——setTimeout(≤0) 会立即
      // 触发,子进程被秒杀;下限取 1ms,上限取 CLI_MAX_TIMEOUT_MS。
      const result = await run({
        args: [action, ...(extraArgs ?? [])],
        cliPath: options.cliPath,
        timeoutMs: Math.min(
          Math.max(requestedTimeoutMs, 1),
          CLI_MAX_TIMEOUT_MS,
        ),
        ...(cwd !== undefined ? { cwd } : {}),
      });
      const hint = buildActionHint(action, version);
      return {
        action,
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timed_out: result.timedOut,
        partial: isPartialOutput(result),
        cli_version: version,
        hints: {
          summary: hint.summary,
          notes: hint.notes,
          long_running: hint.longRunning,
          interactive: hint.interactive,
        },
        doctor:
          action === 'doctor'
            ? parseDoctorReportFromStreams(result.stdout, result.stderr)
            : null,
      };
    },
  });
}

/** 常规装配用的默认 victauri_cli 工具(PATH 上的 victauri)。 */
export const victauriCliTool = createVictauriCliTool();
