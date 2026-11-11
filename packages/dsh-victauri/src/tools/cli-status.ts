/**
 * victauri CLI 探测工具（`victauri_cli_status`）。
 *
 * 目标：让模型在调用 CLI 之前就能主动获知 CLI 是否可用——
 * 存在与否、版本号、**实际命中路径**、CLI 子命令口径（CLI_ACTIONS）；
 * CLI 缺失时拿到结构化 `not_found` + 安装指引（scoop / mise / cargo），
 * 而不是等首次调用 spawn ENOENT 才报 VictauriError('cli-error')。
 *
 * 与既有 CLI 桥（`src/tools/cli.ts`）的关系：
 * - 本文件只做「探测」，不改 `victauri_cli` 的子命令透传行为；
 * - 不改 `src/cli.ts` 的 spawn / 超时机制，只复用 `resolveCliPath` /
 *   `runVictauriCli` / `CLI_ACTIONS`；
 * - 独立文件 + 装配入口 import 注册（不堆进既有文件）。
 */

import { existsSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types';
import { defineTool } from '@deepseek-ai/dsh-tools';

import {
  CLI_ACTIONS,
  resolveCliPath,
  runVictauriCli,
  type CliRunOptions,
  type CliRunResult,
} from '../cli.ts';

/** 探测超时（毫秒）：`--version` 是秒级操作，给 10s 余量。 */
export const CLI_STATUS_TIMEOUT_MS = 10_000;

/** 探测结果缓存 TTL（毫秒）：避免同一会话内反复 spawn。 */
export const CLI_STATUS_CACHE_TTL_MS = 60_000;

/**
 * CLI 缺失时的安装指引（三种装法都给出，模型可直接照做）。
 *
 * 口径固定包含 `scoop install victauri` / `mise install victauri` /
 * `cargo install victauri` 三条字面量，便于验收按文本核对。
 */
export const CLI_INSTALL_HINT =
  '安装指引: ① scoop install victauri; ' +
  '② mise install victauri（等价 mise use -g victauri，mise shims 已在 PATH 时可直接命中）; ' +
  '③ cargo install victauri。' +
  '也可在本插件配置 cliPath 指向可执行文件绝对路径后重试。';

/** Windows PATHEXT 缺省口径（环境变量缺失时用）。 */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** 探测状态：CLI 可用 / 未找到 / 其他失败。 */
export type CliStatusState = 'available' | 'not_found' | 'error';

/**
 * 探测失败时的结构化错误（kind 可判别，hint 含安装指引）。
 *
 * `kind` 是**CLI 探测域自有词汇表**（not_found / cli-error / timeout），
 * 描述的是「victauri CLI 本身装没装、跑不跑得起来」，与
 * `src/errors.ts` 的 REST 桥接错误信封词汇表（no-instance / http-error /
 * tool-error / timeout …）**不互通、不可互相比较**。
 *
 * 例：本表的 `not_found`（CLI 没找到）与 REST 桥接域的 `no-instance`
 * （找不到活的 victauri 实例）是两回事，名字相近但语义不同。
 */
export type CliStatusError = {
  kind: 'not_found' | 'cli-error' | 'timeout';
  message: string;
  hint: string;
};

/** 探测结果（返回给模型的结构化值）。 */
export interface CliStatusResult {
  /** available = CLI 可用；not_found = 未安装/不在 PATH；error = 其他失败。 */
  status: CliStatusState;
  /** CLI 版本号（解析自 `--version` 输出；解析不出为 null）。 */
  version: string | null;
  /** `--version` 原始输出（去空白）。 */
  version_output: string;
  /** 实际命中的可执行文件绝对路径；未命中为 null。 */
  cli_path: string | null;
  /** 本次请求解析到的路径（配置注入值或平台默认名）。 */
  requested_path: string;
  /** requested_path 来源：config = 配置注入；platform_default = 平台默认。 */
  source: 'config' | 'platform_default';
  /** CLI 子命令口径（CLI_ACTIONS 原样透出）。 */
  actions: string[];
  /** 失败时的结构化错误；available 时为 null。 */
  error: CliStatusError | null;
}

/** 探测依赖（测试可注入替身；生产走默认实现）。 */
export interface CliStatusDeps {
  /** 执行 `--version` 的运行器（默认 `runVictauriCli`）。 */
  run?: (options: CliRunOptions) => Promise<CliRunResult>;
  /** 可执行文件定位器（默认 `locateExecutable`）。 */
  locate?: (cliPath: string) => string | null;
  /** 探测参数（默认 `['--version']`）。 */
  args?: string[];
  /** 探测超时毫秒（默认 `CLI_STATUS_TIMEOUT_MS`）。 */
  timeoutMs?: number;
}

/** 候选文件名：裸名 + 各 PATHEXT 后缀（已带同名后缀的不重复追加）。 */
function candidateNames(base: string, exts: readonly string[]): string[] {
  const names = [base];
  for (const ext of exts) {
    if (ext === '') continue;
    if (base.toLowerCase().endsWith(ext.toLowerCase())) continue;
    names.push(base + ext);
  }
  return names;
}

/**
 * 在 PATH 中定位可执行文件的**实际命中路径**。
 *
 * - 含路径分隔符 → 按路径解析（相对路径按 cwd 解析），文件不存在返回 null；
 * - 裸名 → 逐个 PATH 目录 × PATHEXT 后缀组合探测（Windows 下 Node 的 spawn
 *   不做 PATHEXT 解析，必须显式带 `.exe` 才能命中 scoop / mise shim）。
 *
 * @param cliPath - 配置注入路径或平台默认名（`victauri.exe` / `victauri`）。
 * @returns 命中的绝对路径；未命中返回 null。
 */
export function locateExecutable(cliPath: string): string | null {
  if (cliPath.includes('/') || cliPath.includes('\\')) {
    const abs = resolve(cliPath);
    return existsSync(abs) ? abs : null;
  }
  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? DEFAULT_PATHEXT).split(';').filter(Boolean)
      : [''];
  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of candidateNames(cliPath, exts)) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 从 `--version` 输出提取版本号（`victauri 0.8.8` → `0.8.8`）。
 *
 * @returns 版本号；未匹配返回 null。
 */
export function parseCliVersion(output: string): string | null {
  const match = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(output);
  return match ? match[0] : null;
}

/** spawn 失败文案是否表示「可执行文件不存在」。 */
function isNotFoundMessage(message: string): boolean {
  return /ENOENT/i.test(message) || /not found/i.test(message);
}

/**
 * 探测 CLI 状态（核心逻辑，与工具外壳解耦，便于单测）。
 *
 * 流程：解析请求路径 → PATH 定位实际命中路径 → `runVictauriCli --version` →
 * 归一为结构化结果。CLI 不存在时返回 `not_found`（含安装指引），不抛栈。
 *
 * @param cliPath - 配置注入的可执行文件路径；undefined = 平台默认。
 * @param deps - 可注入的运行器 / 定位器（默认生产实现）。
 */
export async function probeCliStatus(
  cliPath?: string,
  deps: CliStatusDeps = {},
): Promise<CliStatusResult> {
  const requested = resolveCliPath(cliPath);
  const source: CliStatusResult['source'] =
    cliPath === undefined ? 'platform_default' : 'config';
  const locate = deps.locate ?? locateExecutable;
  const run = deps.run ?? runVictauriCli;
  const located = locate(requested);
  const target = located ?? requested;
  const args = deps.args ?? ['--version'];
  const timeoutMs = deps.timeoutMs ?? CLI_STATUS_TIMEOUT_MS;
  const base = {
    requested_path: requested,
    source,
    actions: [...CLI_ACTIONS],
  };

  try {
    const result = await run({
      args,
      cliPath: target,
      timeoutMs,
    });
    const versionOutput = (result.stdout || result.stderr).trim();
    if (result.timedOut) {
      return {
        ...base,
        status: 'error',
        version: null,
        version_output: versionOutput,
        cli_path: located,
        error: {
          kind: 'timeout',
          message: `victauri --version timed out after ${timeoutMs}ms`,
          hint: CLI_INSTALL_HINT,
        },
      };
    }
    if (result.exitCode !== 0) {
      return {
        ...base,
        status: 'error',
        version: null,
        version_output: versionOutput,
        cli_path: located,
        error: {
          kind: 'cli-error',
          message: `victauri --version exited with code ${String(result.exitCode)}: ${versionOutput.slice(0, 200)}`,
          hint: CLI_INSTALL_HINT,
        },
      };
    }
    return {
      ...base,
      status: 'available',
      version: parseCliVersion(versionOutput),
      version_output: versionOutput,
      cli_path: located ?? requested,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isNotFoundMessage(message)) {
      return {
        ...base,
        status: 'not_found',
        version: null,
        version_output: '',
        cli_path: null,
        error: {
          kind: 'not_found',
          message:
            `victauri CLI 未找到（尝试路径: ${requested}）。` +
            `安装指引: scoop install victauri / mise install victauri / cargo install victauri。`,
          hint: CLI_INSTALL_HINT,
        },
      };
    }
    return {
      ...base,
      status: 'error',
      version: null,
      version_output: '',
      cli_path: located,
      error: { kind: 'cli-error', message, hint: CLI_INSTALL_HINT },
    };
  }
}

/** 探测缓存项。 */
interface CacheEntry {
  at: number;
  result: CliStatusResult;
}

/** 探测缓存（按请求路径分键，TTL 见 CLI_STATUS_CACHE_TTL_MS）。 */
const cache = new Map<string, CacheEntry>();

/** 清空探测缓存（单测用；生产也可在配置变更后手动调用）。 */
export function resetCliStatusCache(): void {
  cache.clear();
}

/**
 * 带缓存的探测：同一路径在 TTL 内复用上次结果。
 *
 * @param cliPath - 配置注入路径；undefined = 平台默认。
 * @param force - true 时跳过缓存强制重新探测。
 */
export async function getCliStatus(
  cliPath?: string,
  force = false,
): Promise<CliStatusResult> {
  const key = resolveCliPath(cliPath);
  if (!force) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CLI_STATUS_CACHE_TTL_MS) {
      return hit.result;
    }
  }
  const result = await probeCliStatus(cliPath);
  cache.set(key, { at: Date.now(), result });
  return result;
}

/** 渲染探测结果（模型可见文本）。 */
function renderCliStatus(value: CliStatusResult): ContentBlock[] {
  const lines: string[] = [];
  if (value.status === 'available') {
    lines.push(
      `victauri CLI 可用${value.version ? `（版本 ${value.version}）` : '（版本未知）'}`,
    );
    lines.push(`路径: ${value.cli_path ?? value.requested_path}`);
  } else if (value.status === 'not_found') {
    lines.push('victauri CLI 未找到');
    lines.push(`尝试路径: ${value.requested_path}`);
  } else {
    lines.push('victauri CLI 探测失败');
    lines.push(`尝试路径: ${value.requested_path}`);
  }
  lines.push(`子命令: ${value.actions.join(' ')}`);
  if (value.error) {
    lines.push(`错误(${value.error.kind}): ${value.error.message}`);
    lines.push(value.error.hint);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * `victauri_cli_status` 工具工厂。
 *
 * cliPath 仅注入（配置 / 测试），不暴露给模型——与 `victauri_cli` 同口径。
 */
export function createVictauriCliStatusTool(
  options: { cliPath?: string } = {},
) {
  return defineTool({
    name: 'victauri_cli_status',
    description: [
      '探测本机 victauri CLI 是否可用（辅通道健康诊断）。',
      '返回：status(available/not_found/error)、版本号、实际命中路径、CLI 子命令口径。',
      'CLI 未安装时返回 status=not_found 并附安装指引（scoop / mise / cargo install victauri），',
      '可在调用 victauri_cli 之前先探测，避免首次调用才报 spawn ENOENT。',
      '结果默认缓存 60s；传 refresh=true 可强制重新探测。',
    ].join(' '),
    parameters: {
      refresh: {
        type: 'boolean',
        description: '跳过缓存强制重新探测（默认 false）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: {
            type: 'string',
            enum: ['available', 'not_found', 'error'],
            required: true,
            description:
              '探测结论：available=CLI 可用；not_found=未安装/不在 PATH；error=其他失败',
          },
          version: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            required: true,
            description: 'CLI 版本号（解析自 --version 输出；解析不出为 null）',
          },
          version_output: {
            type: 'string',
            required: true,
            description: '--version 原始输出（去空白）',
          },
          cli_path: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            required: true,
            description: '实际命中的可执行文件绝对路径；未命中为 null',
          },
          requested_path: {
            type: 'string',
            required: true,
            description: '本次请求解析到的路径（配置注入值或平台默认名）',
          },
          source: {
            type: 'string',
            enum: ['config', 'platform_default'],
            required: true,
            description:
              'requested_path 来源：config=配置注入；platform_default=平台默认',
          },
          actions: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: `CLI 子命令口径（${CLI_ACTIONS.join('/')}）`,
          },
          error: {
            oneOf: [
              { type: 'object', additionalProperties: true },
              { type: 'null' },
            ],
            required: true,
            description:
              '失败时的结构化错误 {kind,message,hint}；available 时为 null',
          },
        },
      },
      render: (_args, value) =>
        renderCliStatus(value as unknown as CliStatusResult),
    },
    timeoutMs: 30_000,
    execute: async (args) => {
      const refresh = args.refresh === true;
      return await getCliStatus(options.cliPath, refresh);
    },
  });
}

/** 常规装配用的默认 victauri_cli_status 工具（PATH 上的 victauri）。 */
export const victauriCliStatusTool = createVictauriCliStatusTool();
