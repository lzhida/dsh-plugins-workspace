#!/usr/bin/env node
/**
 * e2e：把工作区插件加载进真实 dsh harness Web UI，验证「加载级别可用」。
 *
 * 用法：
 *   pnpm test:e2e                                     # 默认验证 packages/hello-plugin
 *   pnpm test:e2e -- packages/foo/src/index.ts        # 验证任意插件入口（可多个）
 *
 * 前提：devDependencies 已安装 @deepseek-ai/dsh（`pnpm install` 即可）。
 * 环境变量：
 *   E2E_TIMEOUT_MS    启动与断言总超时（默认 180000）
 *   E2E_PORT          Web UI 端口（默认 3865）
 *
 * 插件契约：插件加载时应打印 `[name] ` 前缀格式的日志行（如 `[hello-plugin] plugin loaded`），
 * e2e 以「[插件目录名]」结构化匹配，路径/堆栈中出现裸包名不算加载成功。
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PORT = process.env.E2E_PORT ?? '3865';
const DSH_HOME = path.join(WORKSPACE_ROOT, '.agents', 'e2e-dsh-home');
const DSH_PROFILE = process.env.E2E_DSH_PROFILE ?? 'e2e';
const WEB_URL = `http://127.0.0.1:${PORT}`;
const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 180_000);
const POLL_MS = 500;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
  }
}

const plugins = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => path.resolve(WORKSPACE_ROOT, p))
  : [path.join(WORKSPACE_ROOT, 'packages', 'hello-plugin', 'src', 'index.ts')];

for (const p of plugins) {
  if (!(await exists(p))) {
    console.error(`[e2e] 插件入口不存在: ${p}`);
    process.exit(1);
  }
}

// 端口占用预检：目标端口已有监听会造成断言假阳性
try {
  await fetch(WEB_URL);
  console.error(`[e2e] 端口已被占用: ${WEB_URL}（疑似已有 web 实例在运行）`);
  process.exit(1);
} catch {
  // 端口空闲，继续
}

// profile 自举：首次运行（或新机器）时从官方 web 模板创建独立 profile
const profileDir = path.join(DSH_HOME, 'profiles', DSH_PROFILE);
if (!(await exists(profileDir))) {
  console.log(
    `[e2e] profile "${DSH_PROFILE}" 不存在，正在从官方 web 模板引导（首次约 30-60s）...`,
  );
  const boot = spawnSync(
    'cmd.exe',
    [
      '/c',
      'pnpm',
      'dsh',
      '--profile',
      DSH_PROFILE,
      '--from-default-profile',
      'web',
    ],
    {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, DSH_HOME },
      stdio: 'inherit',
    },
  );
  if (!(await exists(profileDir))) {
    // 官方模板引导在试启动崩溃（如 3080 被占）时会非零退出，但 profile 已落盘——目录缺失才算真失败
    const code = boot.status ?? boot.signal ?? boot.error?.message ?? 'unknown';
    console.error(
      `[e2e] profile 引导失败：未生成 ${profileDir}（引导命令退出码 ${code}，排查上方引导输出）`,
    );
    process.exit(1);
  }
  if (boot.status !== 0) {
    console.warn(
      `[e2e] 引导命令非零退出（code=${boot.status}），但 profile 已生成，继续`,
    );
  }
  console.log('[e2e] ✓ profile 引导完成');
}

// 生成 patch overlay（格式见 develop/basic 文档：- insert 列表，插件路径必须绝对）
const overlayDir = path.join(WORKSPACE_ROOT, '.agents', 'tmp', 'e2e');
await mkdir(overlayDir, { recursive: true });
const overlayPath = path.join(overlayDir, 'plugins.cordis.yml');
const overlay = [
  '- insert:',
  ...plugins.map((p, i) => {
    const id = `e2e-${path.basename(path.dirname(path.dirname(p)))}-${i}`;
    return `    - id: ${id}\n      name: '${p.replaceAll('\\', '/')}'`;
  }),
  '',
].join('\n');
await writeFile(overlayPath, overlay);

const web = spawn(
  'cmd.exe',
  [
    '/c',
    'pnpm',
    'dsh',
    '--profile',
    DSH_PROFILE,
    '--patch',
    overlayPath,
    '--no-open',
    '--port',
    PORT,
  ],
  {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env, BROWSER: 'none', DSH_HOME },
    windowsHide: true,
  },
);

let output = '';
web.stdout.on('data', (chunk) => {
  output += chunk;
});
web.stderr.on('data', (chunk) => {
  output += chunk;
});

const deadline = Date.now() + TIMEOUT_MS;
// 契约令牌 = 插件目录名（packages/<name>/src/index.ts → 上两级取 basename）
const tokens = plugins.map((p) => path.basename(path.dirname(path.dirname(p))));
const pending = new Set(tokens);
let portUp = false;
let webPageOk = false;
let tokenedUrl: string | null = null;
let exited: number | null = null;

web.on('exit', (code) => {
  exited = code;
});

function fail(message: string): never {
  console.error(`[e2e] 失败: ${message}`);
  console.error(`[e2e] ===== web 进程输出（尾部 4000 字符）=====`);
  console.error(output.slice(-4000));
  killTree(web.pid);
  rm(overlayPath, { force: true }).catch(() => {});
  process.exit(1);
}

while (Date.now() < deadline) {
  if (exited !== null) fail(`web 进程提前退出（code=${exited}）`);

  for (const token of [...pending]) {
    // 结构化匹配：仅认 `[name] ` 前缀格式（插件契约），避免路径/堆栈中的裸包名造成假阳性
    const re = new RegExp(`\\[${escapeRegExp(token)}\\]`);
    if (re.test(output)) {
      pending.delete(token);
      console.log(`[e2e] ✓ 捕获插件加载日志: [${token}] ...`);
    }
  }

  if (!portUp) {
    try {
      const res = await fetch(WEB_URL, { signal: AbortSignal.timeout(3000) });
      portUp = true;
      console.log(`[e2e] ✓ Web 服务可访问: ${WEB_URL} (HTTP ${res.status})`);
    } catch {
      // 尚未就绪，继续轮询
    }
  }

  // web 就绪后会打印带鉴权 token 的 UI 地址，命中它才算真正打开 Web UI
  if (!tokenedUrl) {
    const m = output.match(/dsh web: (http:\S+)/);
    if (m) tokenedUrl = m[1];
  }
  if (tokenedUrl && !webPageOk) {
    try {
      const res = await fetch(tokenedUrl, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.status < 400) {
        webPageOk = true;
        console.log(
          `[e2e] ✓ Web UI 页面可访问: ${tokenedUrl} (HTTP ${res.status})`,
        );
      }
    } catch {
      // 页面尚未就绪，继续轮询
    }
  }

  if (pending.size === 0 && portUp && (webPageOk || !tokenedUrl)) {
    console.log('[e2e] 全部断言通过');
    killTree(web.pid);
    await rm(overlayPath, { force: true });
    // 等待子进程树退出，避免残留
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3000);
      web.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    process.exit(0);
  }

  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}

fail(
  `超时（${TIMEOUT_MS}ms）：未捕获令牌 [${[...pending].join(', ')}]，服务 ${portUp ? 'up' : 'down'}，UI 页面 ${tokenedUrl ? (webPageOk ? 'ok' : 'fail') : '未就绪'}`,
);
