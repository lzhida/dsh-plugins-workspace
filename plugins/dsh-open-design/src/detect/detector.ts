/**
 * dsh-open-design 探测模块（二）：探测本机 Open Design 安装环境与 sidecar 管道端点。
 *
 * 探测顺序：
 *   ① 管道枚举——列出 `\\.\pipe` 下的管道名，与静态候选摘要比对；命中即 method='pipe'。
 *   ② PowerShell 兜底——`Get-CimInstance Win32_Process` 列出 Open Design 进程及其命令行，
 *      从 `--od-stamp-*` 标记还原语义戳，从命令行首段还原可执行文件路径；method='powershell'。
 *   ③ 两条路都没命中——method='none'，不抛错，由上层决定是否提示用户手工配置。
 *
 * 所有外部依赖（管道枚举、PowerShell 调用、用户名、数据目录）均可注入，便于单测。
 * 路径语义统一走 `path.win32`（Open Design 是 Windows 应用，路径与主机无关）。
 */
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { win32 } from 'node:path';

import type { DetectedEnvironment, SidecarStamp } from '../config.ts';
import {
  buildStampCandidates,
  computePipeEndpoint,
  parseStampFlags,
  PIPE_PREFIX,
  PIPE_ROOT,
} from './stamp.ts';

/** 探测选项（全部可注入）。 */
export interface DetectOptions {
  /** 哈希主体：Windows 用户名；缺省取 os.userInfo().username。 */
  principal?: string;
  /** 数据根目录（%APPDATA%）；缺省取环境变量 APPDATA。 */
  appDataDir?: string;
  /** 列出命名管道名；缺省读取 `\\.\pipe` 目录。 */
  listPipes?: () => string[];
  /** 执行 PowerShell 脚本并返回标准输出；缺省 spawn powershell。 */
  runPowerShell?: (script: string) => Promise<string>;
  /** namespaces 目录；缺省按 appDataDir 推导。 */
  namespaceDir?: string;
  /** PowerShell 单次调用超时（毫秒）。 */
  timeoutMs?: number;
}

/** 探测进程列表用的 PowerShell 脚本。 */
export const POWERSHELL_PROCESS_SCRIPT =
  'Get-CimInstance Win32_Process -Filter "Name=\'Open Design.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';

/** PowerShell 单次调用默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** PowerShell 失败后的重试次数（总尝试次数 = 1 + retry）。 */
const POWERSHELL_RETRY = 1;

const APP_DIR_NAME = 'Open Design';
const NAMESPACES_DIR_NAME = 'namespaces';
const DATA_DIR_NAME = 'data';
const DAEMON_CLI_SEGMENTS = [
  'resources',
  'app',
  'prebundled',
  'daemon',
  'daemon-cli.mjs',
];

/** 进程表条目（只取需要的两个字段）。 */
interface ProcessEntry {
  ProcessId?: number;
  CommandLine?: string;
}

/** 从进程列表里挑出的语义戳与可执行文件路径。 */
interface ProcessProbe {
  stamp: SidecarStamp;
  exePath: string;
}

/**
 * 探测一次 Open Design 安装环境。
 *
 * @returns 探测结果快照；未命中任何来源时 method='none'（不抛错）。
 */
export async function detectOnce(
  options: DetectOptions = {},
): Promise<DetectedEnvironment> {
  const principal = options.principal ?? defaultPrincipal();
  const appDataDir = options.appDataDir ?? process.env.APPDATA ?? '';
  const namespaceDir =
    options.namespaceDir ?? defaultNamespaceDirFor(appDataDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const listPipes = options.listPipes ?? defaultListPipes;
  const runPowerShell =
    options.runPowerShell ??
    ((script: string) => runPowerShellScript(script, timeoutMs));

  // ① 管道枚举：候选摘要与现存管道名比对。
  const candidates = buildStampCandidates({ principal, namespaceDir });
  const pipes = safeListPipes(listPipes);
  const pipeHit = candidates.find((candidate) =>
    pipes.includes(PIPE_PREFIX + candidate.digest),
  );

  // ② PowerShell：既用于兜底还原语义戳，也用于补齐可执行文件路径。
  const probe = await queryProcesses(runPowerShell, timeoutMs);

  if (pipeHit) {
    return finalize(
      'pipe',
      pipeHit.stamp,
      pipeHit.endpoint,
      probe?.exePath ?? '',
      appDataDir,
    );
  }
  if (probe) {
    return finalize(
      'powershell',
      probe.stamp,
      computePipeEndpoint(principal, probe.stamp),
      probe.exePath,
      appDataDir,
    );
  }
  return {
    method: 'none',
    stamp: null,
    endpoint: '',
    installDir: '',
    dataDir: '',
    daemonCliPath: '',
  };
}

/** 组装最终探测结果：补齐安装目录、数据目录与守护脚本路径。 */
function finalize(
  method: 'pipe' | 'powershell',
  stamp: SidecarStamp,
  endpoint: string,
  exePath: string,
  appDataDir: string,
): DetectedEnvironment {
  const installDir = exePath ? win32.dirname(exePath) : '';
  const dataDir = appDataDir
    ? win32.join(
        appDataDir,
        APP_DIR_NAME,
        NAMESPACES_DIR_NAME,
        stamp.namespace,
        DATA_DIR_NAME,
      )
    : '';
  const daemonCliPath = installDir
    ? win32.join(installDir, ...DAEMON_CLI_SEGMENTS)
    : '';
  return { method, stamp, endpoint, installDir, dataDir, daemonCliPath };
}

/** 调用 PowerShell 列出进程；失败重试一次，仍失败返回 null。 */
async function queryProcesses(
  runPowerShell: (script: string) => Promise<string>,
  timeoutMs: number,
): Promise<ProcessProbe | null> {
  for (let attempt = 0; attempt <= POWERSHELL_RETRY; attempt += 1) {
    let raw: string;
    try {
      raw = await withTimeout(
        runPowerShell(POWERSHELL_PROCESS_SCRIPT),
        timeoutMs,
      );
    } catch {
      continue; // 调用失败（超时/非零退出）→ 重试
    }
    // 输出拿到了但解析不出来就不必重试
    return analyzeProcesses(raw);
  }
  return null;
}

/** 解析 PowerShell 输出的进程列表，优先取 app='daemon' 的进程。 */
function analyzeProcesses(raw: string): ProcessProbe | null {
  const parsed: ProcessProbe[] = [];
  for (const entry of parseProcessEntries(raw)) {
    const commandLine = entry.CommandLine ?? '';
    const stamp = parseStampFlags(commandLine);
    if (!stamp) continue;
    parsed.push({ stamp, exePath: extractExePath(commandLine) });
  }
  if (parsed.length === 0) return null;
  const daemon = parsed.find((item) => item.stamp.app === 'daemon');
  return daemon ?? parsed[0];
}

/** 解析 ConvertTo-Json 输出：可能是对象、数组或空串。 */
function parseProcessEntries(raw: string): ProcessEntry[] {
  const text = raw.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || parsed === undefined) return [];
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter(
    (item): item is ProcessEntry => typeof item === 'object' && item !== null,
  );
}

/** 从命令行取可执行文件路径：优先第一个引号段，其次首个空白分段。 */
function extractExePath(commandLine: string): string {
  const quoted = /"([^"]+)"/.exec(commandLine);
  if (quoted?.[1]) return quoted[1];
  return commandLine.trim().split(/\s+/)[0] ?? '';
}

/** 默认管道枚举：读取 `\\.\pipe` 目录（Windows 专属，失败返回空数组）。 */
function defaultListPipes(): string[] {
  try {
    return readdirSync(PIPE_ROOT);
  } catch {
    return [];
  }
}

/** 管道枚举失败（注入实现抛错）时降级为空数组。 */
function safeListPipes(listPipes: () => string[]): string[] {
  try {
    return listPipes() ?? [];
  } catch {
    return [];
  }
}

/** 默认主体名：Windows 用户名。 */
function defaultPrincipal(): string {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
}

/** 按数据根目录推导 namespaces 目录。 */
function defaultNamespaceDirFor(appDataDir: string): string {
  if (!appDataDir) return '';
  return win32.join(appDataDir, APP_DIR_NAME, NAMESPACES_DIR_NAME);
}

/** 给 Promise 加超时；超时后 reject（底层 Promise 继续跑，但错误已被消费）。 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`PowerShell 调用超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 默认 PowerShell 调用：spawn powershell，收集标准输出。 */
function runPowerShellScript(
  script: string,
  timeoutMs: number,
): Promise<string> {
  const executable = process.platform === 'win32' ? 'powershell' : 'pwsh';
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      executable,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`PowerShell 调用超时（${timeoutMs}ms）`));
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(`PowerShell 退出码 ${code ?? 'null'}：${stderr.trim()}`),
        );
      }
    });
  });
}
