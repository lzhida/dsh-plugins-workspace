/**
 * victauri_doctor——桥接体检工具。
 *
 * 目标（用户口径）：「在开发 Tauri 项目时，能自动启用验证」——一条命令回答
 * 「这个工作区现在能不能用 dsh-victauri 插件开发调试 Tauri 应用」：
 *
 * 1. **workspace**：工作区是否 Tauri 项目（探测 `tauri.conf.json`，支持
 *    `<ws>/src-tauri/` 与 `<ws>/` 两种布局）；
 * 2. **dependency**：是否接了 victauri（Cargo.toml 含 `victauri-plugin` 依赖、
 *    `[features]` 是否定义/默认启用 `victauri` 特征）；
 * 3. **live-instance**：本机 discovery 目录里有没有活体实例（带 Bearer 的
 *    `GET /info` 探活，短预算）；区分「完全无目录」与「有目录但全死（陈旧残留）」；
 * 4. **tool-face**：服务端工具清单与本插件静态暴露面是否一致（复用
 *    `tools-list.ts` 的 diffToolNames）；
 * 5. **debug-build**：`src-tauri/target/debug` 是否已有构建产物（提示性检查）；
 * 6. **cli**：victauri CLI 是否可用（复用 cli-status 的探测与安装指引）。
 *
 * 设计约束：
 * - **永不抛错**：任何异常都折进 checks（fail/warn）或结构化字段，工具失败
 *   语义 = 返回体检报告，而不是把异常抛给宿主；
 * - **输出不含敏感物**：实例只报 pid / version / productName，不报 port 与
 *   token；错误摘要**不带 URL**（VictauriTimeoutError 等的 message 含
 *   `http://127.0.0.1:<port>`，一律替换为固定文案）；
 * - workspace 缺省 `process.cwd()`（ToolRunContext 不带工作区路径，模型应
 *   显式传入当前会话工作区的绝对路径）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { VictauriInstance } from '../discovery.ts';
import type { JsonValue } from '../json.ts';
import type { VictauriClientLike } from '../client.ts';
import { scanInstances } from '../discovery.ts';
import { VictauriClient } from '../client.ts';
import { diffToolNames, exposedServerToolNames } from './tools-list.ts';
import { CLI_INSTALL_HINT, probeCliStatus } from './cli-status.ts';

/** 工具名（victauri_ 前缀家族的一员）。 */
export const DOCTOR_TOOL_NAME = 'victauri_doctor';

/** 单实例探活默认预算（毫秒）：与原活体列表口径一致，短预算防挂死。 */
export const DOCTOR_PROBE_TIMEOUT_MS = 2_000;

/** 单条检查项状态。 */
export type DoctorCheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

/** 单条检查项。 */
export interface DoctorCheck {
  /** 稳定 id：workspace / dependency / live-instance / tool-face / debug-build / cli。 */
  id: string;
  /** pass=通过；fail=阻断性问题；warn=提示性问题；skip=前置条件不满足未执行。 */
  status: DoctorCheckStatus;
  /** 人类可读结论。 */
  message: string;
}

/** 体检结论级别。 */
export type DoctorVerdict = 'ready' | 'partial' | 'blocked';

/** 体检报告（工具返回值）。 */
export interface DoctorResult {
  /** 实际探测的工作区绝对路径。 */
  workspace: string;
  /** 工作区是否 Tauri 项目（探测到 tauri.conf.json）。 */
  is_tauri_project: boolean;
  /** ready=全过；partial=有 warn 无 fail；blocked=有 fail。 */
  verdict: DoctorVerdict;
  /** 逐项检查明细。 */
  checks: DoctorCheck[];
  /** 一句话结论。 */
  summary: string;
}

/** 文件系统访问面（可注入以便单测）。 */
export interface DoctorFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string): string[];
  /** 可选：判断路径是否为目录（用于 POSIX 下排除 build/deps 等子目录）。 */
  isDirectory?(path: string): boolean;
}

/** 实例探活客户端工厂（可注入以便单测）。 */
export type DoctorClientFactory = (
  instance: VictauriInstance,
  timeoutMs: number,
) => Pick<VictauriClientLike, 'info' | 'listTools'>;

/** discovery 扫描面（可注入以便单测）。 */
export type DoctorScan = (options: {
  identifier?: string;
}) => VictauriInstance[];

/** CLI 探测面（可注入以便单测）。 */
export type DoctorCliProbe = (cliPath?: string) => Promise<{
  status: 'available' | 'not_found' | 'error';
  version: string | null;
  cli_path: string | null;
  error: { kind: string; message: string; hint: string } | null;
}>;

/** 工具运行期依赖（全部可注入，缺省生产实现）。 */
export interface DoctorDeps {
  fs?: DoctorFs;
  scan?: DoctorScan;
  createClient?: DoctorClientFactory;
  probeCli?: DoctorCliProbe;
  /** workspace 缺省值（缺省 process.cwd()）。 */
  cwd?: string;
  /** 探活预算（缺省 DOCTOR_PROBE_TIMEOUT_MS）。 */
  probeTimeoutMs?: number;
  /** 按 bundle id 过滤 discovery 实例（透传 scanInstances）。 */
  identifier?: string;
  /** victauri CLI 可执行文件路径（缺省按 PATH 命中探测）。 */
  cliPath?: string;
  /** 平台标识（缺省 process.platform；注入以便单测覆盖两平台分支）。 */
  platform?: string;
}

const DEFAULT_FS: DoctorFs = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path) => readdirSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
};

const DEFAULT_CLIENT_FACTORY: DoctorClientFactory = (instance, timeoutMs) =>
  VictauriClient.forPort(instance.port, instance.token, { timeoutMs });

const DEFAULT_SCAN: DoctorScan = (options) =>
  scanInstances(
    options.identifier === undefined ? {} : { identifier: options.identifier },
  );

/**
 * 解析工作区绝对路径：入参优先（绝对与相对都接受，相对按 cwd 解析），
 * 缺省 cwd。
 */
export function resolveWorkspace(raw: string | undefined, cwd: string): string {
  if (typeof raw === 'string' && raw.trim() !== '') {
    return isAbsolute(raw) ? raw : resolve(cwd, raw);
  }
  return cwd;
}

/**
 * 探测 Tauri 项目配置文件：`<ws>/src-tauri/tauri.conf.json` 优先（Tauri v2
 * 标准布局），退回 `<ws>/tauri.conf.json`（历史/单体布局）。返回命中路径或 null。
 */
export function findTauriConf(workspace: string, fs: DoctorFs): string | null {
  const candidates = [
    join(workspace, 'src-tauri', 'tauri.conf.json'),
    join(workspace, 'tauri.conf.json'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Cargo.toml victauri 依赖与特征扫描结果。 */
export interface VictauriDependencyScan {
  /** 命中的 Cargo.toml 绝对路径；两个布局都没找到为 null。 */
  cargoPath: string | null;
  /** 文本里出现 victauri-plugin 依赖。 */
  hasVictauriPluginDep: boolean;
  /** [features] 段定义了 victauri 特征。 */
  featureDefined: boolean;
  /** default 特征里启用了 victauri（未启用时需 --features victauri 或改 default）。 */
  featureEnabledByDefault: boolean;
}

/**
 * 扫描 Cargo.toml 的 victauri 集成特征。
 *
 * **口径声明**：这是正则特征匹配，不是完整 TOML 解析——足够回答「接没接
 * victauri」这一体检问题，但不构成构建配置的事实源；精确配置以 cargo 自己
 * 的解析为准（可用 `victauri_cli(action='doctor')` / `cargo metadata` 深查）。
 */
export function scanVictauriDependency(
  workspace: string,
  fs: DoctorFs,
): VictauriDependencyScan {
  const candidates = [
    join(workspace, 'src-tauri', 'Cargo.toml'),
    join(workspace, 'Cargo.toml'),
  ];
  const cargoPath = candidates.find((path) => fs.existsSync(path)) ?? null;
  if (cargoPath === null) {
    return {
      cargoPath: null,
      hasVictauriPluginDep: false,
      featureDefined: false,
      featureEnabledByDefault: false,
    };
  }
  let text: string;
  try {
    text = fs.readFileSync(cargoPath, 'utf8');
  } catch {
    return {
      cargoPath,
      hasVictauriPluginDep: false,
      featureDefined: false,
      featureEnabledByDefault: false,
    };
  }
  // 依赖声明有两种合法 TOML 形态：`victauri-plugin = { ... }`（内联表）与
  // `[dependencies.victauri-plugin]`（表语法）。改名形态（如 `vp = { package =
  // "victauri-plugin" }`）**识别不到**——这是正则口径的已知局限。
  const hasDep =
    /(^|\n)\s*victauri-plugin\s*=/m.test(text) ||
    /(^|\n)\s*\[dependencies\.victauri-plugin\]/m.test(text);
  const featuresSection = extractTomlSection(text, 'features');
  const featureDefined =
    featuresSection !== null && /(^|\n)\s*victauri\s*=/m.test(featuresSection);
  const defaultLine = featuresSection?.match(
    /(^|\n)\s*default\s*=\s*\[([^\]]*)\]/,
  );
  const featureEnabledByDefault =
    defaultLine !== null &&
    defaultLine !== undefined &&
    /["']victauri["']/.test(defaultLine[2] ?? '');
  return {
    cargoPath,
    hasVictauriPluginDep: hasDep,
    featureDefined,
    featureEnabledByDefault,
  };
}

/** 提取 TOML `[section]` 段文本（到下一个 `[` 段头或文件尾）；没有该段返回 null。 */
function extractTomlSection(text: string, section: string): string | null {
  const header = new RegExp(`(^|\\n)\\s*\\[${section}\\]\\s*(\\n|$)`);
  const match = header.exec(text);
  if (match === null) return null;
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const nextSection = /\n\s*\[/.exec(rest);
  const end = nextSection === null ? rest.length : nextSection.index;
  return rest.slice(0, end);
}

/**
 * 从检查项聚合结论：有 fail → blocked；无 fail 有 warn → partial；否则 ready。
 * skip 不影响结论（纯函数，单测锁定）。
 */
export function verdictFrom(checks: readonly DoctorCheck[]): DoctorVerdict {
  if (checks.some((check) => check.status === 'fail')) return 'blocked';
  if (checks.some((check) => check.status === 'warn')) return 'partial';
  return 'ready';
}

/** 一句话结论（纯函数，单测锁定文案前缀）。 */
export function summarizeResult(result: {
  verdict: DoctorVerdict;
  is_tauri_project: boolean;
  checks: readonly DoctorCheck[];
}): string {
  const passCount = result.checks.filter((c) => c.status === 'pass').length;
  const failCount = result.checks.filter((c) => c.status === 'fail').length;
  const warnCount = result.checks.filter((c) => c.status === 'warn').length;
  const skipCount = result.checks.filter((c) => c.status === 'skip').length;
  const base = `体检 ${result.checks.length} 项：${passCount} 通过 / ${failCount} 阻断 / ${warnCount} 提示 / ${skipCount} 跳过`;
  if (result.verdict === 'ready')
    return `${base}。桥接就绪，可以直接开发调试。`;
  if (result.verdict === 'blocked') {
    return result.is_tauri_project
      ? `${base}。存在阻断项，请先修复 fail 项（见 checks）。`
      : `${base}。当前工作区不是 Tauri 项目，请在 Tauri 项目根调用并把 workspace 指向项目根。`;
  }
  return `${base}。桥接可用，但建议处理 warn 项（见 checks）。`;
}

/** 单个活体实例的概要（不含 port/token）。 */
export interface LiveInstanceSummary {
  pid: number;
  identifier: string | null;
  product_name: string | null;
  version: string | null;
}

/**
 * 探活一批实例：并发调用 `GET /info`（带 Bearer），归一为活体清单 + 全灭清单。
 * 错误一律替换为固定文案（上游错误的 message 含 `http://127.0.0.1:<port>`，
 * 不外泄）。
 */
export async function probeInstances(
  instances: readonly VictauriInstance[],
  createClient: DoctorClientFactory,
  timeoutMs: number,
): Promise<{ live: LiveInstanceSummary[]; dead: number[] }> {
  const live: LiveInstanceSummary[] = [];
  const dead: number[] = [];
  await Promise.all(
    instances.map(async (instance) => {
      try {
        const client = createClient(instance, timeoutMs);
        const info = await client.info();
        live.push({
          pid: instance.pid,
          identifier: instance.identifier,
          product_name:
            typeof info['product_name'] === 'string'
              ? info['product_name']
              : instance.productName,
          version:
            typeof info['version'] === 'string'
              ? info['version']
              : instance.version,
        });
      } catch {
        // 探活失败（超时/拒绝连接/token 失配）→ 视为死实例，不给原因细节
        //（避免把含端口的 URL 带进输出）。
        dead.push(instance.pid);
      }
    }),
  );
  live.sort((a, b) => a.pid - b.pid);
  dead.sort((a, b) => a - b);
  return { live, dead };
}

/**
 * 组装体检报告（核心编排，依赖全部可注入）。
 *
 * 检查顺序与短路规则：workspace fail → dependency/live-instance/tool-face/
 * debug-build 全部 skip（非 Tauri 工作区下它们没有意义）；cli 检查始终执行
 *（与工作区无关，装了 CLI 才能深查项目）。
 */
export async function runDoctorChecks(
  workspace: string,
  options: DoctorDeps = {},
): Promise<DoctorResult> {
  const fs = options.fs ?? DEFAULT_FS;
  const scan = options.scan ?? DEFAULT_SCAN;
  const createClient = options.createClient ?? DEFAULT_CLIENT_FACTORY;
  const probeCli = options.probeCli ?? probeCliStatus;
  const probeTimeoutMs = options.probeTimeoutMs ?? DOCTOR_PROBE_TIMEOUT_MS;

  const checks: DoctorCheck[] = [];

  // 1. 工作区是否 Tauri 项目。
  const confPath = findTauriConf(workspace, fs);
  const isTauriProject = confPath !== null;
  if (isTauriProject) {
    checks.push({
      id: 'workspace',
      status: 'pass',
      message: `是 Tauri 项目（${confPath}）`,
    });
  } else {
    checks.push({
      id: 'workspace',
      status: 'fail',
      message:
        '工作区没有 tauri.conf.json（已查 src-tauri/ 与根目录两处布局）——不是 Tauri 项目；' +
        '请把 workspace 参数指向 Tauri 项目根后重试',
    });
  }

  // 2. victauri 依赖与特征（仅 Tauri 项目）。
  if (isTauriProject) {
    const dependencyScan: VictauriDependencyScan = scanVictauriDependency(
      workspace,
      fs,
    );
    if (dependencyScan.cargoPath === null) {
      checks.push({
        id: 'dependency',
        status: 'fail',
        message:
          '没找到 Cargo.toml（已查 src-tauri/ 与根目录）——无法确认 victauri 集成',
      });
    } else if (!dependencyScan.hasVictauriPluginDep) {
      checks.push({
        id: 'dependency',
        status: 'fail',
        message: `${dependencyScan.cargoPath} 未声明 victauri-plugin 依赖——应用内没有 victauri 服务，请先接入`,
      });
    } else if (!dependencyScan.featureDefined) {
      checks.push({
        id: 'dependency',
        status: 'warn',
        message: `${dependencyScan.cargoPath} 已声明 victauri-plugin 依赖，但 [features] 未定义 victauri 特征（可选依赖需显式启用才生效）`,
      });
    } else if (!dependencyScan.featureEnabledByDefault) {
      checks.push({
        id: 'dependency',
        status: 'warn',
        message: `${dependencyScan.cargoPath} 已定义 victauri 特征但 default 未包含——构建时需 --features victauri，否则服务不启动`,
      });
    } else {
      checks.push({
        id: 'dependency',
        status: 'pass',
        message: `victauri 集成完整（${dependencyScan.cargoPath}：依赖 + victauri 特征默认启用）`,
      });
    }
  } else {
    checks.push({
      id: 'dependency',
      status: 'skip',
      message: '跳过：工作区不是 Tauri 项目',
    });
  }

  // 3. 活体实例探测（仅 Tauri 项目）。
  let firstLiveClient: Pick<VictauriClientLike, 'info' | 'listTools'> | null =
    null;
  /** 参与工具面比对的实例 pid（多实例时告知用户比对的是哪一个）。 */
  let firstLivePid: number | null = null;
  let liveSummaries: LiveInstanceSummary[] = [];
  if (isTauriProject) {
    let instances: VictauriInstance[];
    try {
      instances = scan({ identifier: options.identifier });
    } catch {
      instances = [];
    }
    if (instances.length === 0) {
      checks.push({
        id: 'live-instance',
        status: 'warn',
        message:
          '本机 discovery 目录里没有任何 victauri 实例记录——应用尚未启动过；' +
          '请在 Tauri 项目里以 debug 构建启动应用（victauri 服务随 app 启动）',
      });
    } else {
      const probe = await probeInstances(
        instances,
        createClient,
        probeTimeoutMs,
      );
      liveSummaries = probe.live;
      if (probe.live.length > 0) {
        const pidText = probe.live
          .map(
            (entry) =>
              `pid ${entry.pid}${entry.version ? `（v${entry.version}）` : ''}`,
          )
          .join('、');
        checks.push({
          id: 'live-instance',
          status: 'pass',
          message:
            `发现 ${probe.live.length} 个活体实例：${pidText}` +
            (probe.dead.length > 0
              ? `；另有 ${probe.dead.length} 个陈旧 discovery 目录（pid ${probe.dead.join('、')}）已自动忽略`
              : ''),
        });
        const firstLive = instances.find((instance) =>
          probe.live.some((entry) => entry.pid === instance.pid),
        );
        if (firstLive !== undefined) {
          firstLiveClient = createClient(firstLive, probeTimeoutMs);
          firstLivePid = firstLive.pid;
        }
      } else {
        checks.push({
          id: 'live-instance',
          status: 'warn',
          message:
            `发现 ${instances.length} 个 discovery 目录（pid ${instances.map((i) => i.pid).join('、')}）但均无活体（探活超时或拒绝连接）——` +
            '这些是退出进程的残留，请重新启动应用',
        });
      }
    }
  } else {
    checks.push({
      id: 'live-instance',
      status: 'skip',
      message: '跳过：工作区不是 Tauri 项目',
    });
  }

  // 4. 工具面对齐（仅在存在活体实例时执行）。
  if (firstLiveClient !== null) {
    try {
      const serverTools = await firstLiveClient.listTools();
      const seen = new Set<string>();
      const serverNames: string[] = [];
      for (const tool of serverTools) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        serverNames.push(tool.name);
      }
      const warnings = diffToolNames(serverNames, exposedServerToolNames());
      const compared =
        firstLivePid === null ? '' : `（比对实例 pid ${firstLivePid}）`;
      if (warnings.length === 0) {
        checks.push({
          id: 'tool-face',
          status: 'pass',
          message: `服务端 ${serverNames.length} 个工具与插件暴露面（${exposedServerToolNames().length} 个）一致${compared}`,
        });
      } else {
        const notExposed = warnings.filter((w) => w.kind === 'not_exposed');
        const missingOnServer = warnings.filter(
          (w) => w.kind === 'missing_on_server',
        );
        checks.push({
          id: 'tool-face',
          status: 'warn',
          message:
            `工具面存在差异${compared}：服务端有而插件未暴露 ${notExposed.length} 个` +
            (notExposed.length > 0
              ? `（${notExposed.map((w) => w.name).join('、')}）`
              : '') +
            `；插件暴露而服务端没有 ${missingOnServer.length} 个` +
            (missingOnServer.length > 0
              ? `（${missingOnServer.map((w) => w.name).join('、')}）`
              : '') +
            '；差异清单可用 victauri_tools_list 查看详情',
        });
      }
    } catch {
      checks.push({
        id: 'tool-face',
        status: 'skip',
        message: '跳过：查询服务端工具清单失败（实例可能在检查间隙退出）',
      });
    }
  } else {
    checks.push({
      id: 'tool-face',
      status: 'skip',
      message:
        liveSummaries.length === 0 && isTauriProject
          ? '跳过：没有活体实例'
          : '跳过：需要活体实例才能比对工具面',
    });
  }

  // 5. debug 构建产物（仅 Tauri 项目，提示性检查）。
  if (isTauriProject) {
    const debugBinary = findDebugBinary(
      workspace,
      fs,
      options.platform ?? process.platform,
    );
    if (debugBinary !== null) {
      checks.push({
        id: 'debug-build',
        status: 'pass',
        message: `已有 debug 构建产物（${debugBinary}）`,
      });
    } else {
      checks.push({
        id: 'debug-build',
        status: 'warn',
        message:
          'src-tauri/target/debug 下没有构建产物——首次调试请先构建（pnpm tauri dev 或 cargo build， victauri 特征需启用）',
      });
    }
  } else {
    checks.push({
      id: 'debug-build',
      status: 'skip',
      message: '跳过：工作区不是 Tauri 项目',
    });
  }

  // 6. CLI 可用性（与工作区无关，始终执行）。
  const configuredCliPath = options.cliPath;
  try {
    const cliStatus = await probeCli(configuredCliPath);
    if (cliStatus.status === 'available') {
      checks.push({
        id: 'cli',
        status: 'pass',
        message: `victauri CLI 可用（${cliStatus.cli_path ?? 'PATH 命中'}${cliStatus.version ? `，v${cliStatus.version}` : ''}）——可用 victauri_cli 工具执行 check/test/doctor 等子命令`,
      });
    } else {
      checks.push({
        id: 'cli',
        status: 'warn',
        message:
          `victauri CLI 不可用${configuredCliPath ? `（已配置的 cliPath：${configuredCliPath}）` : ''}（不影响 REST 工具面，但无法执行 victauri check/test/doctor 等子命令）。` +
          CLI_INSTALL_HINT,
      });
    }
  } catch {
    checks.push({
      id: 'cli',
      status: 'warn',
      message: `victauri CLI 探测失败（探测过程抛出异常，不影响 REST 工具面）。${CLI_INSTALL_HINT}`,
    });
  }

  const verdict = verdictFrom(checks);
  return {
    workspace,
    is_tauri_project: isTauriProject,
    verdict,
    checks,
    summary: summarizeResult({
      verdict,
      is_tauri_project: isTauriProject,
      checks,
    }),
  };
}

/**
 * 探测 debug 构建产物：`<ws>/src-tauri/target/debug`（Tauri v2 标准布局），
 * 退回 `<ws>/target/debug`。Windows 找 *.exe，其他平台取一个**普通文件**
 * （排除 build/deps/incremental 等子目录，它们没有扩展名但不是可执行产物）。
 * 目录不存在或读取失败返回 null（调用方给 warn）。
 */
export function findDebugBinary(
  workspace: string,
  fs: DoctorFs,
  platform: string = process.platform,
): string | null {
  const candidates = [
    join(workspace, 'src-tauri', 'target', 'debug'),
    join(workspace, 'target', 'debug'),
  ];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir);
      const isFile = (name: string): boolean => {
        if (fs.isDirectory === undefined) return true;
        try {
          return !fs.isDirectory(join(dir, name));
        } catch {
          return true;
        }
      };
      const binaries =
        platform === 'win32'
          ? entries.filter(
              (name) => name.toLowerCase().endsWith('.exe') && isFile(name),
            )
          : entries.filter((name) => !name.includes('.') && isFile(name));
      const picked = binaries[0];
      if (picked !== undefined) return join(dir, picked);
    } catch {
      // 读取失败（权限等）→ 试下一个布局。
    }
  }
  return null;
}

/** 渲染体检报告（模型可见文本）。 */
function renderDoctorReport(value: DoctorResult): ContentBlock[] {
  const icons: Record<DoctorCheckStatus, string> = {
    pass: '✓',
    fail: '✗',
    warn: '⚠',
    skip: '－',
  };
  const lines: string[] = [`victauri 桥接体检（${value.workspace}）`];
  for (const check of value.checks) {
    lines.push(`${icons[check.status]} [${check.id}] ${check.message}`);
  }
  lines.push(`结论：${value.verdict} —— ${value.summary}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * `victauri_doctor` 工具工厂。
 *
 * 只读体检：不调用任何上游工具、不写任何文件；所有异常折进报告。
 */
export function createVictauriDoctorTool(
  deps: DoctorDeps = {},
): ToolDefinition {
  return defineTool({
    name: DOCTOR_TOOL_NAME,
    description: [
      'victauri 桥接体检：一条命令回答「这个工作区现在能不能用 dsh-victauri 开发调试 Tauri 应用」。',
      '依次检查：① 工作区是否 Tauri 项目（tauri.conf.json）；② 是否接了 victauri（Cargo.toml 依赖与 [features]）；',
      '③ 本机 discovery 里有没有活体实例（/info 探活）；④ 服务端工具面与插件暴露面是否一致；',
      '⑤ debug 构建产物提示；⑥ victauri CLI 可用性。',
      '返回结构化 verdict（ready/partial/blocked）与逐项 checks；永不抛错。',
      '在开发 Tauri 项目时先调用本工具确认桥接就绪，再使用 victauri_* 工具调试。',
    ].join(' '),
    parameters: {
      workspace: {
        type: 'string',
        description:
          'Tauri 项目工作区绝对路径（缺省为宿主进程 cwd；模型应显式传入当前会话工作区根目录）',
      },
      identifier: {
        type: 'string',
        description: '按 bundle id（metadata.identifier）过滤实例（选填）',
      },
      probe_timeout_ms: {
        type: 'number',
        description: `单实例探活预算毫秒（默认 ${DOCTOR_PROBE_TIMEOUT_MS}）`,
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) =>
        renderDoctorReport(value as unknown as DoctorResult),
    },
    timeoutMs: 30_000,
    execute: async (args) => {
      const workspaceArg =
        typeof args['workspace'] === 'string' ? args['workspace'] : undefined;
      const identifierArg =
        typeof args['identifier'] === 'string' ? args['identifier'] : undefined;
      const timeoutArg = args['probe_timeout_ms'];
      const probeTimeoutMs =
        typeof timeoutArg === 'number' &&
        Number.isFinite(timeoutArg) &&
        timeoutArg > 0
          ? timeoutArg
          : undefined;
      const cwd = deps.cwd ?? process.cwd();
      const workspace = resolveWorkspace(workspaceArg, cwd);
      try {
        const result = await runDoctorChecks(workspace, {
          ...deps,
          // 入参优先于注入的默认值（两者都可为空 → 不过滤实例）。
          identifier: identifierArg ?? deps.identifier,
          probeTimeoutMs: probeTimeoutMs ?? deps.probeTimeoutMs,
        });
        return result as unknown as Record<string, JsonValue>;
      } catch {
        // 契约：永不抛错。任何意外折成一条 fail 检查，宿主侧拿到的仍是结构化报告。
        // **不外泄异常原文**（上游/IO 异常的 message 可能含本机路径或
        // `http://127.0.0.1:<port>` 之类 URL），一律替换为固定文案。
        const fs = deps.fs ?? DEFAULT_FS;
        const isTauriProject = ((): boolean => {
          try {
            return findTauriConf(workspace, fs) !== null;
          } catch {
            // 连探测都失败（如 fs 本身不可用）→ 按「无法确认」处理，不外泄原因。
            return false;
          }
        })();
        const result: DoctorResult = {
          workspace,
          is_tauri_project: isTauriProject,
          verdict: 'blocked',
          checks: [
            {
              id: 'doctor',
              status: 'fail',
              message:
                '体检执行异常，未能完成检查（详细原因已省略以免泄漏本机路径或端口信息）。',
            },
          ],
          summary: '体检执行异常，未能完成检查。',
        };
        return result as unknown as Record<string, JsonValue>;
      }
    },
  });
}
