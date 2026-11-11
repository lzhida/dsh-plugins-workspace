#!/usr/bin/env node
/**
 * dsh-victauri demo-app 本地冒烟脚本（半自动 e2e）。
 *
 * 把 demo-app 的「手动 e2e fixture」变成一条命令跑完、无人工介入的冒烟：
 * 构建 demo-app → 启动 → 轮询 discovery 就绪 → 经 REST 主通道冒烟核心工具 →
 * PASS/FAIL 摘要 → 清理进程树。
 *
 * **不进 CI**（与 demo-app/README 的现状决策一致）：本脚本需要 Rust 工具链
 * （cargo）、会真的拉起一个 Tauri 窗口，并依赖本机 `%TEMP%/victauri` discovery
 * 目录。仅供本地开发与发版前自检使用。
 *
 * 冒烟清单（10 项检查，覆盖 6 个核心工具）：
 *   1. GET  /health                    → {status:"ok"}（无认证 liveness）
 *   2. GET  /info                      → name==='victauri' + version + 端口自洽
 *   3. GET  /api/tools                 → 工具名数组，含 6 个核心工具
 *   4. POST /api/tools/get_plugin_info → result.tools.enabled > 0
 *   5. POST /api/tools/app_info        → result.process.pid === 启动进程 pid
 *   6. POST /api/tools/eval_js         → {"code":"1+1"} 结果 === 2
 *   7. POST /api/tools/dom_snapshot    → result.tree 含 demo 页可交互元素
 *   8. POST /api/tools/invoke_command  → greet 命令返回 "Hello, smoke!"
 *   9. POST /api/tools/logs            → backend_digest 动作可用（0.10.2 起，
 *                                        见下方「后端日志链路」的版本门控说明）
 *  10. GET  /api/tools（不带 token）   → HTTP 401（认证闸门有效）
 *
 * 后端日志链路（第 8、9 项）的版本门控：
 *   - `logs{action:"backend_digest"}` 与 `invoke_command{with_logs:true}` 是
 *     上游 0.10.2 才有的能力（0.8.8 的 LogsAction 只有 8 个动作、InvokeCommandParams
 *     无 with_logs 字段；未知 action 会因 serde 未知枚举值被拒）。
 *   - 脚本按 GET /info 报告的服务端版本决定：>= 0.10.2 时断言契约形状
 *     （digest 含 sources/buffered；with_logs 信封含 backend_logs/backend_log_cursor）；
 *     < 0.10.2 时跳过这些断言并在 detail 里写明原因——旧服务端不是失败，是版本差异。
 *   - 版本号解析容忍 `v` 前缀，并按 semver 把预发布版（0.10.2-rc.1）视为低于同号正式版；
 *     版本不可解析时按「不满足」处理（宁可跳过，不做乐观假设）。
 *   - demo-app 未安装 log_layer/log_logger，故断言针对「无捕获源」形态：
 *     digest 仍返回 sources 与 buffered（缓冲为空），这不是错误。
 *
 * 环境变量：
 *   SMOKE_SKIP_BUILD=1          跳过 cargo build（复用已有产物）
 *   SMOKE_BUILD_TIMEOUT_MS      构建超时上限，默认 600000（首次编译依赖较多）
 *   SMOKE_DISCOVERY_TIMEOUT_MS  discovery 就绪等待上限，默认 60000
 *   SMOKE_REQUEST_TIMEOUT_MS    单次 HTTP 请求超时，默认 20000
 *   SMOKE_SELFTEST=1            追加一项故意失败的检查（验证失败路径退出码 1）
 *
 * 退出码：0 = 全部通过 / 1 = 有检查失败 / 2 = 前置条件或环境不满足。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const DEMO_DIR = join(REPO_ROOT, 'demo-app');
const TAURI_DIR = join(DEMO_DIR, 'src-tauri');
const FRONTEND_INDEX = join(DEMO_DIR, 'dist', 'index.html');
const EXE_NAME =
  process.platform === 'win32' ? 'dsh-victauri-demo.exe' : 'dsh-victauri-demo';
const EXE_PATH = join(TAURI_DIR, 'target', 'debug', EXE_NAME);
/** 服务默认端口；被占时服务端顺延（如 7373 → 7383），脚本从 discovery 读实际端口。 */
const DEFAULT_PORT = 7373;
/** demo-app 的 bundle id（discovery metadata.identifier），用于识别「自己的」实例。 */
const DEMO_IDENTIFIER = 'com.lzhida.dsh-victauri-demo';

const BUILD_TIMEOUT_MS = envInt('SMOKE_BUILD_TIMEOUT_MS', 600_000);
const DISCOVERY_TIMEOUT_MS = envInt('SMOKE_DISCOVERY_TIMEOUT_MS', 60_000);
const REQUEST_TIMEOUT_MS = envInt('SMOKE_REQUEST_TIMEOUT_MS', 20_000);
const SKIP_BUILD = process.env['SMOKE_SKIP_BUILD'] === '1';

/** 冒烟检查结果（name / ok / detail）。 */
const checks = [];
/** demo-app 子进程句柄（清理阶段使用）。 */
let child = null;
/** 端口说明（例如「端口顺延」），打印在摘要里。 */
let portNote = `使用默认端口 ${String(DEFAULT_PORT)}`;

/** 读环境变量里的正整数，缺省或非法时回退。 */
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** 阶段日志。 */
function log(stage, message) {
  console.log(`[smoke][${stage}] ${message}`);
}

/** 致命错误：抛出带标记的 Error，由 main 统一收口成退出码 2。 */
function fail(message) {
  const error = new Error(message);
  error.smokeFatal = true;
  throw error;
}

/** 断言条件成立，否则抛错。 */
function assertTrue(condition, message) {
  if (!condition) throw new Error(message);
}

/** 断言相等（用于错误信息更可读）。 */
function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(
      `${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
    );
  }
}

/** 等待指定毫秒。 */
function sleep(ms) {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * 解析 '0.10.2' 形式的版本号。
 *
 * - 容忍 `v` 前缀（'v0.10.3' → 0.10.3），避免把新服务端误判成旧服务端而静默跳过断言；
 * - 预发布/构建后缀单独记下（'0.10.2-rc.1' 的 prerelease='rc.1'），用于 semver 比较；
 * - 不可解析返回 null（调用方按「不满足」保守处理）。
 */
function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^v/i, '');
  const [core, ...prereleaseParts] = cleaned.split('+')[0].split('-');
  const parts = core.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length === 0 || parts.some((part) => !Number.isInteger(part))) {
    return null;
  }
  return {
    parts,
    prerelease: prereleaseParts.length > 0 ? prereleaseParts.join('-') : null,
  };
}

/**
 * 版本是否 >= 目标（逐段数值比较 + semver 预发布规则）。
 * 不可解析一律视为「不满足」——宁可跳过断言，也不拿未知版本做乐观假设。
 */
function isAtLeast(version, target) {
  const actual = parseVersion(version);
  const wanted = parseVersion(target);
  if (actual === null || wanted === null) return false;
  const length = Math.max(actual.parts.length, wanted.parts.length);
  for (let index = 0; index < length; index += 1) {
    const left = actual.parts[index] ?? 0;
    const right = wanted.parts[index] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  // 数字段完全相同：带预发布后缀的版本低于同号正式版（semver）。
  if (actual.prerelease && !wanted.prerelease) return false;
  return true;
}

/**
 * 前置检查：Rust 工具链、demo-app 工程与前端静态页。
 * 缺任何一项都给出可操作的报错（退出码 2），不进入构建。
 */
function preflight() {
  if (!existsSync(join(TAURI_DIR, 'Cargo.toml'))) {
    fail(`未找到 demo-app 的 Tauri 工程：${TAURI_DIR}`);
  }
  if (!existsSync(FRONTEND_INDEX)) {
    fail(
      `未找到 demo-app 前端静态页：${FRONTEND_INDEX}` +
        '（前端无构建步骤，需手动补齐 dist/index.html）',
    );
  }
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  if (cargo.error || cargo.status !== 0) {
    fail(
      '未检测到 Rust 工具链（cargo 不在 PATH）。' +
        '本冒烟需要 cargo 构建 demo-app，请先安装 Rust（https://rustup.rs）。',
    );
  }
  log('preflight', `cargo: ${String(cargo.stdout).trim()}`);
  log('preflight', `demo-app: ${DEMO_DIR}`);
}

/** 构建 demo-app（victauri feature）。失败时带最后若干行输出。 */
function build() {
  if (SKIP_BUILD) {
    log('build', 'SMOKE_SKIP_BUILD=1 → 跳过 cargo build');
    return;
  }
  log(
    'build',
    `cargo build --features victauri（超时上限 ${String(BUILD_TIMEOUT_MS)} ms，首次编译依赖较多）`,
  );
  const startedAt = Date.now();
  const live = findLiveDemoInstances();
  if (live.length > 0) {
    log(
      'build',
      `⚠ 检测到 ${String(live.length)} 个仍在运行的 demo-app 实例（pid=${live
        .map((item) => String(item.pid))
        .join(', ')}）：Windows 下 cargo 无法覆盖运行中的 exe，构建可能失败`,
    );
  }
  const result = spawnSync('cargo', ['build', '--features', 'victauri'], {
    cwd: TAURI_DIR,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
  });
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    fail(
      timedOut
        ? `cargo build 超时（上限 ${String(BUILD_TIMEOUT_MS)} ms），可用 SMOKE_BUILD_TIMEOUT_MS 放宽`
        : `cargo build 启动失败：${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const output =
      `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`
        .trim()
        .split('\n')
        .slice(-8)
        .join('\n');
    const hint =
      live.length > 0
        ? `\n提示：demo-app 实例 pid=${live
            .map((item) => String(item.pid))
            .join(
              ', ',
            )} 仍在运行（Windows 下运行中的 exe 无法被 cargo 覆盖），` +
          '请先关闭后重试：taskkill /PID <pid> /T /F'
        : '';
    fail(`cargo build 退出码 ${String(result.status)}：\n${output}${hint}`);
  }
  log('build', `完成，用时 ${String(Date.now() - startedAt)} ms`);
}

/** 启动 demo-app（detached，清理阶段按进程树结束）。 */
function launch() {
  if (!existsSync(EXE_PATH)) {
    fail(
      `未找到 demo-app 可执行文件：${EXE_PATH}` +
        '（先执行 cargo build --features victauri）',
    );
  }
  child = spawn(EXE_PATH, [], { detached: true, stdio: 'ignore' });
  child.unref();
  log('launch', `已启动 demo-app（pid=${String(child.pid)}）：${EXE_PATH}`);
  return child.pid;
}

/** 解析一个 discovery 实例目录；任一文件缺失或损坏返回 null（容错跳过）。 */
function readInstanceDir(dir) {
  try {
    const metaRaw = readFileSync(join(dir, 'metadata.json'), 'utf8');
    const portRaw = readFileSync(join(dir, 'port'), 'utf8');
    const tokenRaw = readFileSync(join(dir, 'token'), 'utf8');
    const port = Number.parseInt(portRaw.trim(), 10);
    const token = tokenRaw.trim();
    if (!Number.isInteger(port) || port <= 0 || token === '') return null;
    const meta = JSON.parse(metaRaw);
    return {
      dir,
      pid:
        typeof meta.pid === 'number'
          ? meta.pid
          : Number.parseInt(basename(dir), 10),
      port,
      token,
      identifier: typeof meta.identifier === 'string' ? meta.identifier : null,
      startedAt: typeof meta.started_at === 'string' ? meta.started_at : null,
      version: typeof meta.version === 'string' ? meta.version : null,
    };
  } catch {
    return null;
  }
}

/** 列出 discovery 根下的数字命名实例目录。 */
function listInstanceDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 进程是否仍存活（EPERM 视为存活：存在但无权限终止）。 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 找出仍在运行的 demo-app 实例。
 * Windows 下运行中的 exe 无法被 cargo 覆盖（os error 5 拒绝访问），
 * 因此构建前先探活并给出可操作的提示。
 */
function findLiveDemoInstances() {
  const root = join(tmpdir(), 'victauri');
  const live = [];
  for (const name of listInstanceDirs(root)) {
    const instance = readInstanceDir(join(root, name));
    if (instance === null) continue;
    if (instance.identifier !== DEMO_IDENTIFIER) continue;
    if (!isProcessAlive(instance.pid)) continue;
    live.push(instance);
  }
  return live;
}

/**
 * 轮询 discovery 直到本次启动的实例就绪。
 * 先按「启动进程 pid」精确匹配；匹配不到再按 started_at 兜底
 * （服务端口顺延或 pid 口径不一致时的容错）。
 */
async function waitForDiscovery(pid) {
  const root = join(tmpdir(), 'victauri');
  const launchedAt = Date.now() - 2000;
  const deadline = Date.now() + DISCOVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const own = readInstanceDir(join(root, String(pid)));
    if (own !== null) return own;
    for (const name of listInstanceDirs(root)) {
      const instance = readInstanceDir(join(root, name));
      if (instance === null) continue;
      const startedMs = instance.startedAt
        ? Date.parse(instance.startedAt)
        : Number.NEGATIVE_INFINITY;
      if (startedMs >= launchedAt) return instance;
    }
    await sleep(300);
  }
  fail(
    `等待 discovery 就绪超时（${String(DISCOVERY_TIMEOUT_MS)} ms）：${root} ` +
      `下未出现本次启动的实例元数据（现有候选目录：${listInstanceDirs(root).join(', ') || '无'}）`,
  );
}

/** 带超时的 JSON 请求；返回 {status, body, text}。 */
async function httpJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text === '' ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: response.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 记录一项检查结果（失败不抛，落到摘要里统一呈现）。
 * 回调可返回字符串（正常）或 {skipped:true, detail}（按版本跳过——不是失败）。
 */
async function check(name, fn) {
  try {
    const outcome = await fn();
    const skipped =
      typeof outcome === 'object' &&
      outcome !== null &&
      outcome.skipped === true;
    const detail = skipped ? outcome.detail : outcome;
    checks.push({ name, ok: true, skipped, detail });
    log('check', `${skipped ? 'SKIP' : 'PASS'} ${name} — ${detail}`);
  } catch (err) {
    // Node 的 fetch 抛错时 err.message 往往只有 "fetch failed"，
    // 真实原因（ECONNREFUSED 等）在 err.cause.message —— 一并带出便于本地排障。
    const message =
      err instanceof Error
        ? [err.message, err.cause instanceof Error ? err.cause.message : '']
            .filter((part) => part !== '' && part !== err.message)
            .join('：') || err.message
        : String(err);
    checks.push({ name, ok: false, skipped: false, detail: message });
    log('check', `FAIL ${name} — ${message}`);
  }
}

/** 经 REST 主通道执行核心工具冒烟。 */
async function runChecks(instance) {
  const base = `http://127.0.0.1:${String(instance.port)}`;
  const auth = { Authorization: `Bearer ${instance.token}` };
  const post = (tool, body) =>
    httpJson(`${base}/api/tools/${tool}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  /** 服务端版本（info 检查里回填）；未知时按「不具备后端日志能力」处理。 */
  let serverVersion = null;
  /** 后端日志动作（logs backend_digest / invoke_command with_logs）是否可用（0.10.2 起）。 */
  const hasBackendLogs = () => isAtLeast(serverVersion, '0.10.2');

  await check('health（无认证 liveness）', async () => {
    const response = await httpJson(`${base}/health`, { method: 'GET' });
    assertEqual(response.status, 200, 'HTTP 状态码');
    assertEqual(response.body?.status, 'ok', 'body.status');
    return 'GET /health → 200 {status:"ok"}';
  });

  await check('info（带认证实例信息）', async () => {
    const response = await httpJson(`${base}/info`, {
      method: 'GET',
      headers: auth,
    });
    assertEqual(response.status, 200, 'HTTP 状态码');
    assertEqual(response.body?.name, 'victauri', 'body.name');
    assertTrue(
      typeof response.body?.version === 'string',
      'body.version 缺失（服务端未回版本号）',
    );
    assertEqual(
      response.body?.port,
      instance.port,
      'body.port 与 discovery 端口一致性',
    );
    serverVersion = response.body.version;
    return `GET /info → victauri ${String(response.body.version)} @:${String(response.body.port)}`;
  });

  await check('tools（工具清单）', async () => {
    const response = await httpJson(`${base}/api/tools`, {
      method: 'GET',
      headers: auth,
    });
    assertEqual(response.status, 200, 'HTTP 状态码');
    assertTrue(Array.isArray(response.body), '响应不是数组');
    const names = response.body
      .map((entry) => entry?.name)
      .filter((name) => typeof name === 'string');
    const required = [
      'get_plugin_info',
      'app_info',
      'eval_js',
      'dom_snapshot',
      'invoke_command',
      'logs',
    ];
    const missing = required.filter((name) => !names.includes(name));
    assertTrue(missing.length === 0, `缺少核心工具：${missing.join(', ')}`);
    return `GET /api/tools → ${String(names.length)} 个工具，含 ${String(required.length)} 个核心工具`;
  });

  await check('get_plugin_info（插件自述）', async () => {
    const response = await post('get_plugin_info', {});
    assertEqual(response.status, 200, 'HTTP 状态码');
    const enabled = response.body?.result?.tools?.enabled;
    assertTrue(
      typeof enabled === 'number' && enabled > 0,
      `result.tools.enabled 异常：${JSON.stringify(enabled)}`,
    );
    return `POST /api/tools/get_plugin_info → 启用工具 ${String(enabled)} 个`;
  });

  await check('app_info（宿主应用信息）', async () => {
    const response = await post('app_info', {});
    assertEqual(response.status, 200, 'HTTP 状态码');
    assertEqual(
      response.body?.result?.process?.pid,
      instance.pid,
      'result.process.pid 与启动进程一致',
    );
    return `POST /api/tools/app_info → pid ${String(instance.pid)}`;
  });

  await check('eval_js（最小断言）', async () => {
    const response = await post('eval_js', { code: '1+1' });
    assertEqual(response.status, 200, 'HTTP 状态码');
    assertEqual(response.body?.result, 2, 'eval_js("1+1") 结果');
    return 'POST /api/tools/eval_js → 1+1 = 2';
  });

  await check('dom_snapshot（前端可访问性树）', async () => {
    const response = await post('dom_snapshot', {});
    assertEqual(response.status, 200, 'HTTP 状态码');
    const tree = response.body?.result?.tree;
    assertTrue(typeof tree === 'string' && tree.length > 0, 'result.tree 为空');
    assertTrue(
      tree.includes('Greet'),
      'result.tree 未包含 demo 页的 Greet 按钮（前端静态页未加载？）',
    );
    return `POST /api/tools/dom_snapshot → ${String(tree.length)} 字符，含 Greet 按钮`;
  });

  await check('invoke_command（inspectable 命令）', async () => {
    // 0.10.2 起可带 with_logs:true，让服务端把「命令执行期间捕获的后端日志」
    // 一并回传（信封：{result, backend_logs, backend_log_cursor, next_seq}）。
    // 旧服务端无该参数（serde 未知字段被静默忽略），故按版本门控。
    const withLogs = hasBackendLogs();
    const response = await post('invoke_command', {
      command: 'greet',
      args: { name: 'smoke' },
      ...(withLogs ? { with_logs: true } : {}),
    });
    assertEqual(response.status, 200, 'HTTP 状态码');
    if (!withLogs) {
      const result = response.body?.result;
      assertTrue(
        typeof result === 'string' && result.includes('Hello, smoke!'),
        `greet 返回异常：${JSON.stringify(result)}`,
      );
      return (
        `POST /api/tools/invoke_command → greet 返回 "Hello, smoke!"` +
        `（服务端 ${String(serverVersion ?? '未知')} 无 with_logs：本项只覆盖 greet，` +
        `后端日志断言按版本跳过）`
      );
    }
    // with_logs 形态：REST 信封是 {result: {result, backend_logs, backend_log_cursor, next_seq}}
    const envelope = response.body?.result;
    assertTrue(
      typeof envelope === 'object' && envelope !== null,
      `with_logs 信封异常：${JSON.stringify(response.body)}`,
    );
    assertTrue(
      typeof envelope.result === 'string' &&
        envelope.result.includes('Hello, smoke!'),
      `greet 返回异常：${JSON.stringify(envelope.result)}`,
    );
    assertTrue(
      Array.isArray(envelope.backend_logs),
      `backend_logs 缺失或非数组：${JSON.stringify(envelope.backend_logs)}`,
    );
    assertTrue(
      typeof envelope.backend_log_cursor === 'number',
      `backend_log_cursor 缺失：${JSON.stringify(envelope)}`,
    );
    // 上游语义：backend_log_cursor 是「本次调用开始前」的日志游标
    // （attach_backend_logs 的 from），不是结束游标；用它做 wait_for 的
    // since_seq 可以只捕获「调用之后」新产生的日志行。
    return (
      'POST /api/tools/invoke_command → greet 返回 "Hello, smoke!"' +
      `（with_logs 信封：backend_logs ${String(envelope.backend_logs.length)} 条，` +
      `backend_log_cursor=${String(envelope.backend_log_cursor)}（调用起点游标））`
    );
  });

  await check('logs（后端日志动作可用性）', async () => {
    if (!hasBackendLogs()) {
      // 旧服务端没有 backend_digest 动作——不是失败，是版本差异，标记为 SKIP。
      // 版本未知（/info 未通过）时不能断言「服务端没有该动作」，只说无法确认。
      const detail =
        serverVersion === null
          ? '跳过：服务端版本未知（/info 检查未通过），无法确认是否支持 backend_digest'
          : `跳过：服务端 ${serverVersion} 无 backend_digest 动作` +
            '（0.10.2 起提供；0.8.8 的 LogsAction 只有 8 个动作）';
      return { skipped: true, detail };
    }
    const response = await post('logs', { action: 'backend_digest' });
    assertEqual(response.status, 200, 'HTTP 状态码');
    const digest = response.body?.result;
    assertTrue(
      typeof digest === 'object' && digest !== null,
      `backend_digest 返回异常：${JSON.stringify(response.body)}`,
    );
    assertTrue(
      typeof digest.sources === 'object' && digest.sources !== null,
      `digest.sources 缺失：${JSON.stringify(digest)}`,
    );
    assertTrue(
      typeof digest.buffered === 'number',
      `digest.buffered 缺失：${JSON.stringify(digest)}`,
    );
    // demo-app 未安装 log_layer/log_logger，故这里是「无捕获源」形态：
    // 缓冲为空 + 给出启用提示——属正常契约，不判失败。
    return (
      'POST /api/tools/logs{action:"backend_digest"} → sources/buffered 齐备' +
      `（buffered=${String(digest.buffered)}；demo-app 无结构化日志捕获源，属正常形态）`
    );
  });

  await check('auth（无 token 被拒）', async () => {
    const response = await httpJson(`${base}/api/tools`, { method: 'GET' });
    assertEqual(
      response.status,
      401,
      '无 token 访问 /api/tools 的 HTTP 状态码',
    );
    return 'GET /api/tools（无 token） → 401';
  });

  if (process.env['SMOKE_SELFTEST'] === '1') {
    await check('selftest（故意失败，用于验证失败路径）', async () => {
      assertTrue(false, 'SMOKE_SELFTEST=1：故意失败，验证退出码 1 与摘要渲染');
    });
  }
}

/** 结束 demo-app 进程树（Windows 用 taskkill /T，类 Unix 杀进程组）。 */
function cleanup() {
  if (child === null) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8',
    });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      /* 进程已退出 */
    }
  }
  log('cleanup', `已请求结束 demo-app 进程树（pid=${String(pid)}）`);
}

/** 打印人可读的冒烟摘要。 */
function printSummary(startedAt) {
  // 分子只算「真正跑过并通过」的项：skipped 项 ok=true，但它是按版本跳过，
  // 计入分子会被读成「有 1 项没过」。
  const passed = checks.filter((item) => item.ok && !item.skipped).length;
  const failed = checks.filter((item) => !item.ok).length;
  const skipped = checks.filter((item) => item.skipped).length;
  console.log('');
  console.log('=== dsh-victauri smoke 摘要 ===');
  for (const item of checks) {
    const status = !item.ok ? 'FAIL' : item.skipped ? 'SKIP' : 'PASS';
    console.log(`${status}  ${item.name} — ${item.detail}`);
  }
  console.log('');
  console.log(
    checks.length === 0
      ? '结果：未执行任何检查（前置阶段失败）'
      : `结果：${String(passed)} 项通过` +
          (skipped > 0 ? `，${String(skipped)} 项按版本跳过` : '') +
          (failed > 0 ? `，${String(failed)} 项失败` : '') +
          `（共 ${String(checks.length)} 项）`,
  );
  console.log(`端口：${portNote}`);
  console.log(`耗时：${String(Date.now() - startedAt)} ms`);
  console.log('边界：本地冒烟，不进 CI（需 Rust 工具链 + 会拉起 Tauri 窗口）');
}

/** 主流程。 */
async function main() {
  const startedAt = Date.now();
  let exitCode = 0;
  try {
    preflight();
    build();
    const pid = launch();
    const instance = await waitForDiscovery(pid);
    portNote =
      instance.port === DEFAULT_PORT
        ? `使用默认端口 ${String(DEFAULT_PORT)}`
        : `端口顺延：${String(DEFAULT_PORT)} 被占，实际 ${String(instance.port)}`;
    log(
      'discovery',
      `就绪：${instance.dir}（pid=${String(instance.pid)} port=${String(instance.port)}，${portNote}）`,
    );
    await runChecks(instance);
  } catch (err) {
    exitCode = 2;
    const message = err instanceof Error ? err.message : String(err);
    log('fatal', message);
  } finally {
    cleanup();
    printSummary(startedAt);
  }
  const failed = checks.filter((item) => !item.ok).length;
  if (exitCode === 0 && failed > 0) exitCode = 1;
  process.exit(exitCode);
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});

await main();
