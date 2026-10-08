/**
 * dsh-test-runner 编排:把 lib 纯函数的判定结果落到真实文件系统与子进程。
 *
 * 边界:
 *   - lib.ts 提供「是否要 X / 怎么 X」的纯函数;
 *   - runner.ts 在此处与 node:child_process、node:fs/promises 交互;
 *   - tools.ts 不直接读 fs / spawn,只经 runner 调用,便于单测覆盖行为。
 *
 * 跨平台 spawn:Windows 经 cmd.exe /c 转发,POSIX 直接按 PATH 解析。
 */
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import {
  buildPermissionDisablePatch,
  buildPermissionStripPatch,
  dshHomeDir,
  DEFAULT_PORT,
  DEFAULT_PROFILE,
  DEFAULT_TIMEOUT_MS,
  profileDir,
  tokenedUrlRegex,
} from './lib.ts';

const IS_WIN = process.platform === 'win32';

function spawnPnpm(args: string[], opts: SpawnOptions = {}): ChildProcess {
  return IS_WIN
    ? spawn('cmd.exe', ['/c', 'pnpm', ...args], opts)
    : spawn('pnpm', args, opts);
}

/**
 * 默认 utf8 编码的同步 spawn。返回类型是字符串化的 SpawnSyncReturns。
 * encoding 在 @types/node 的 SpawnSyncOptions 上是 union(可为 'buffer' | string),
 * 故 opts 类型放宽到 SpawnSyncOptions,函数内部强制覆盖 encoding。
 */
export function spawnPnpmSync(
  args: string[],
  opts: SpawnSyncOptions = {},
): SpawnSyncReturns<string> {
  const fixed = { ...opts, encoding: 'utf8' } as SpawnSyncOptions & {
    encoding: 'utf8';
  };
  return IS_WIN
    ? (spawnSync(
        'cmd.exe',
        ['/c', 'pnpm', ...args],
        fixed,
      ) as SpawnSyncReturns<string>)
    : (spawnSync('pnpm', args, fixed) as SpawnSyncReturns<string>);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 跨平台:给 path 替换反斜杠为正斜杠(便于 link: 规格)。 */
export function toPosix(p: string): string {
  return p.replaceAll('\\', '/');
}

/** kill 进程树:Windows taskkill /T,POSIX kill -SIGKILL。 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (IS_WIN) {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
  }
}

/** 启动 dsh web 至指定 profile+port,返回 ChildProcess + 输出缓冲闭包。 */
export interface BootHandle {
  child: ChildProcess;
  /** 取出已累积的 stdout+stderr 文本。 */
  drain(): string;
  /** 是否已退出(非 null 即 code/signal)。 */
  exitCode(): number | null;
}

export function bootWeb(args: {
  profile: string;
  port: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): BootHandle {
  const child = spawnPnpm(
    ['dsh', '--profile', args.profile, '--no-open', '--port', args.port],
    {
      cwd: args.cwd,
      env: {
        ...args.env,
        BROWSER: 'none',
        DSH_HOME: args.env['DSH_HOME'] ?? dshHomeDir(),
      },
      windowsHide: true,
    },
  );
  let output = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code;
  });
  return {
    child,
    drain: () => output,
    exitCode: () => exited,
  };
}

/** profile 自举:缺失时从官方 web 模板创建。返回 (是否新建, exitCode)。 */
export async function ensureProfile(args: {
  profile: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ created: boolean; exitCode: number | null }> {
  const home = dshHomeDir(args.env);
  const dir = profileDir(args.profile, home);
  if (await exists(dir)) return { created: false, exitCode: 0 };
  const boot = spawnPnpmSync(
    ['dsh', '--profile', args.profile, '--from-default-profile', 'web'],
    {
      cwd: args.cwd,
      env: args.env,
      stdio: 'inherit',
    },
  );
  return {
    created: await exists(dir),
    exitCode: boot.status ?? null,
  };
}

/** 维护 profile 的 cordis.patch.yml:写入新内容(若需要)。返回是否改动。 */
export async function reconcilePatch(args: {
  profile: string;
  pluginNames: readonly string[];
  env: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; reason: string }> {
  const home = dshHomeDir(args.env);
  const file = join(profileDir(args.profile, home), 'cordis.patch.yml');
  const current = (await exists(file)) ? await readFile(file, 'utf8') : '';
  const disable = buildPermissionDisablePatch(current, args.pluginNames);
  if (disable !== null) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, disable, 'utf8');
    return {
      changed: true,
      reason: 'permission-presets-disabled(local executor)',
    };
  }
  const strip = buildPermissionStripPatch(current, args.pluginNames);
  if (strip !== null) {
    await writeFile(file, strip, 'utf8');
    return { changed: true, reason: 'permission-presets-stripped' };
  }
  return { changed: false, reason: 'no-op' };
}

/** 装/卸 plugin,经 pnpm 在 profile 目录下转发(走 dsh 官方 plugin 子命令)。 */
export async function installPlugin(args: {
  profile: string;
  spec: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 'add' | 'remove' */
  action: 'add' | 'remove';
}): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  const r = spawnPnpmSync(
    ['dsh', 'plugin', '--profile', args.profile, args.action, args.spec],
    { cwd: args.cwd, env: args.env, stdio: 'inherit' },
  );
  return { exitCode: r.status ?? null, signal: r.signal ?? null };
}

/** 轮询 web 输出,等三项断言就绪或超时。返回每项的命中状态。 */
export interface AssertionState {
  logReady: boolean;
  portReady: boolean;
  pageReady: boolean;
  tokenedUrl: string | null;
  elapsedMs: number;
}

export async function collectAssertions(args: {
  boot: BootHandle;
  tokens: readonly string[]; // 插件目录名,用于结构化匹配
  webUrl: string;
  timeoutMs: number;
  pollMs: number;
  /** inject 用于单测;默认走全局 fetch。 */
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<AssertionState> {
  const sleep =
    args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = args.now ?? Date.now;
  const fetcher = args.fetcher ?? fetch;
  const tokenRe = args.tokens.map(
    (t) => new RegExp(`\\[${t.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`),
  );
  const urlRe = tokenedUrlRegex();

  const start = now();
  const state: AssertionState = {
    logReady: false,
    portReady: false,
    pageReady: false,
    tokenedUrl: null,
    elapsedMs: 0,
  };
  const pending = new Set(tokenRe);
  const deadline = start + args.timeoutMs;

  while (now() < deadline) {
    if (args.boot.exitCode() !== null) {
      // 进程提前退出:全部按 false 上报,让调用方决定怎么处理。
      break;
    }
    const output = args.boot.drain();
    for (const re of [...pending]) {
      if (re.test(output)) {
        pending.delete(re);
      }
    }
    state.logReady = pending.size === 0;

    if (!state.portReady) {
      try {
        const res = await fetcher(args.webUrl, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.status < 500) state.portReady = true;
      } catch {
        /* not ready */
      }
    }

    if (state.tokenedUrl === null) {
      const m = urlRe.exec(output);
      if (m) state.tokenedUrl = m[1] ?? null;
    }
    if (state.tokenedUrl && !state.pageReady) {
      try {
        const res = await fetcher(state.tokenedUrl, {
          redirect: 'manual',
          signal: AbortSignal.timeout(3000),
        });
        if (res.status < 400) state.pageReady = true;
      } catch {
        /* not ready */
      }
    }

    state.elapsedMs = now() - start;
    if (
      state.logReady &&
      state.portReady &&
      (state.pageReady || !state.tokenedUrl)
    ) {
      return state;
    }
    await sleep(args.pollMs);
  }
  state.elapsedMs = now() - start;
  return state;
}

/** resolve plugin entry → { dir, name } (dir 上两级,name 取自 package.json 或 basename)。 */
export async function resolvePlugin(
  entry: string,
): Promise<{ dir: string; name: string }> {
  const dir = dirname(dirname(entry));
  const manifest = JSON.parse(
    await readFile(join(dir, 'package.json'), 'utf8'),
  ) as { name?: string };
  return {
    dir,
    name: manifest.name ?? entry.split(/[\\/]/).slice(-2, -1)[0] ?? 'unknown',
  };
}

/** 默认 DSH_HOME + 仓库根(尽力推断)。 */
export function defaultsForCli(cwd: string): {
  profile: string;
  port: string;
  timeoutMs: number;
  home: string;
  cwd: string;
} {
  return {
    profile: DEFAULT_PROFILE,
    port: String(DEFAULT_PORT),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    home: dshHomeDir(),
    cwd,
  };
}

/** 路径转 pnpm link spec(link: 前缀,统一正斜杠)。 */
export function linkSpec(pkgDir: string): string {
  return `link:${toPosix(pkgDir).replaceAll(sep, '/')}`;
}
