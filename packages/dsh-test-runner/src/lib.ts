/**
 * dsh-test-runner 纯函数库:可单测的编排支撑。
 *
 * 负责把 .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts 中可单测的部分
 * 抽出,使工具实现单薄、可测、可推理。涉及进程与文件系统副作用的逻辑
 * (spawn dsh / 读 ~/.dsh / 写 cordis.patch.yml) 走 runner.ts,本文件只
 * 放纯函数。
 *
 * 模块内所有函数都接受显式参数,不读 process.env,便于单测注入。
 */

/** e2e 默认端口(3080 是上游默认,3865 是本机现状产物)。 */
export const DEFAULT_PORT = 3865;
/** 默认 profile 名(沿用 .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts)。 */
export const DEFAULT_PROFILE = 'e2e';
/** 默认总超时 ms(180s — 足够首次 profile 引导 + 启动 web)。 */
export const DEFAULT_TIMEOUT_MS = 180_000;
/** 默认断言轮询 ms。 */
export const DEFAULT_POLL_MS = 500;

/** 顶层 `- id: permission` 是否已存在(允许前导空白)。 */
export function hasPermissionRow(text: string): boolean {
  // 容许数组顶层前导空白(部分编辑器/工具会加),但 `- id:` 必须在 token 起始。
  return /^\s*-\s+id:\s+permission\s*$/m.test(text);
}

/**
 * 决定 profile 当前的 cordis.patch.yml 是否需要剥「- id: permission / disabled: true」段,
 * 若需要则返回剥后内容;否则返回 null。
 *
 * 行为对齐 test-e2e.ts:仅当顶层有 `- id: permission` 时执行。剥离同时连同
 * runner 自己写入的两行注释一并清掉,不留 e2e patch 残迹。
 *
 * 历史:2026-09-22 起为「测试 local executor 时补一行 `disabled: true`,其它
 * 情况剥除」,nushell 系列下线后已无 local executor 触发补行场景(2026-10-08
 * 删除 nushell 系列时同步简化),函数退化为「无条件剥除」。
 */
export function buildPermissionStripPatch(currentPatch: string): string | null {
  if (!hasPermissionRow(currentPatch)) return null;
  const src = currentPatch.split(/\r?\n/);
  const kept: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const line = src[i]!;
    if (/^-\s+id:\s+permission\s*$/.test(line)) {
      if (/^\s+disabled:/.test(src[i + 1] ?? '')) i++;
      // 剥离时把紧邻在它之前、由 runner 写入的两行 e2e 注释一起清掉,
      // 避免 patch 层留下「e2e patch 层:…」孤儿注释。
      while (
        kept.length > 0 &&
        /^#\s*(e2e patch 层|的 permission presets)/.test(kept[kept.length - 1]!)
      ) {
        kept.pop();
      }
      continue;
    }
    kept.push(line);
  }
  // 顶层必须是合法 YAML 数组;剥后若无任何非注释/非空条目,补 `[]` 占位。
  const hasEntries = kept.some(
    (l) => l.trim() !== '' && !l.trim().startsWith('#'),
  );
  return hasEntries
    ? kept.join('\n').replace(/\n{3,}/g, '\n\n')
    : `${kept.join('\n').replace(/^\s+/, '').replace(/\s*$/, '')}[]\n`;
}

/** 解析插件入口路径(可能为多个)为「目录名 / 绝对路径 / 包名」三元组。 */
export interface ResolvedPlugin {
  /** 入口文件绝对路径(已 resolve)。 */
  entry: string;
  /** 包目录(入口上两级)。 */
  dir: string;
  /** 包名(读自 package.json,失败时回退到目录名)。 */
  name: string;
}

/** plugin entry path → 包目录(上两级)。 */
export function packageDirOf(entry: string): string {
  // 兼容正反斜杠;按 path.dirname 反复两层,无需 path 模块依赖。
  // 保留首部根节点(win32 "C:" / POSIX "/"),只剥离尾段两个层级。
  const norm = entry.replaceAll('\\', '/');
  const parts = norm.split('/');
  // 先剥尾两层(src/index.ts)
  const sliced = parts.slice(0, -2);
  if (sliced.length === 0) return entry;
  // win32 根盘符需保留(C: / D:),POSIX 根需保留开头的 ""
  if (parts[0] === '' && sliced[0] !== '') {
    // POSIX 绝对路径:首段空,然后其他;slice 后首段是 "",不应该再处理。
    // 实际上 split('/') 对 "/x/y" 给出 ["", "x", "y"];slice(0,-2)=[""],join('/')='/'。
    return sliced.join('/') || '/';
  }
  return sliced.join('/');
}

/** 是否包含 `pnpm run --` 形态的字面量 `--` —— pnpm 11 行为透传。 */
export function filterArgvPnpmDash(argv: readonly string[]): string[] {
  return argv.filter((a) => a !== '--');
}

/** 转义正则元字符(`escapeRegExp` 简化版,只覆盖 e2e token 字符集)。 */
export function escapeRegExp(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 构造插件加载日志的结构化正则:e2e 契约是 `[<name>] ` 前缀。
 * 强制锚到左方括号,避免路径/堆栈中裸包名造成假阳性。
 */
export function pluginLoadedRegex(pluginDir: string): RegExp {
  const name = pluginDir.split(/[\\/]/).pop() ?? pluginDir;
  return new RegExp(`\\[${escapeRegExp(name)}\\]`);
}

/** web stdout 中带鉴权 token 的 URL 匹配(`dsh web: http://...?token=...`)。 */
export function tokenedUrlRegex(): RegExp {
  return /dsh web: (http:\S+)/;
}

/**
 * 端口占用预检:成功 fetch 即视为占用(返回 true)。
 * 测试通过 `fetch` mock 注入,本函数对 fetch 异常一律视为空闲。
 */
export async function isPortBusy(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await fetcher(url);
    return true;
  } catch {
    return false;
  }
}

/** 工具结果(给 model 看的文本)的标准化。 */
export function toolTextResult(text: string): { text: string } {
  return { text };
}

/**
 * 审查 ~/.dsh/profiles/ 时对单个 profile 目录命名的「是否是 test 用途」分类。
 * 沿用本仓库 e2e / nutest / git-smoke / stats 的隐式约定:
 *  - 默认 test profile 名 = `e2e`
 *  - 已知测试用途关键字:e2e / test / nutest / smoke
 */
export function isLikelyTestProfile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'e2e' || lower === 'test' || lower === 'tests') return true;
  // 子串匹配(不区分位置):e2e / test / nutest / smoke / stats。
  if (
    lower.includes('e2e') ||
    lower.includes('test') ||
    lower.includes('nutest') ||
    lower.includes('smoke') ||
    lower.includes('stats')
  ) {
    return true;
  }
  return false;
}

/**
 * 解析 `DSH_HOME`(环境变量优先,否则 `${homedir}/.dsh`)。
 * 接受可选的 env / homeDir 注入,便于单测不必依赖 os.homedir。
 */
export function dshHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = (
    globalThis as { os?: { homedir?: () => string } }
  ).os?.homedir?.() ?? defaultHomeFallback(),
): string {
  return env['DSH_HOME'] ?? `${homeDir}/.dsh`;
}

/** 默认 homeDir 回退:仅在显式传入 homedir 不可用时使用,生产用 os.homedir()。 */
function defaultHomeFallback(): string {
  // 不主动 require('os') 以保本文件零运行时副作用;调用方应传 os.homedir。
  // 此兜底仅在未注入时进入,绝大多数情况下不可达。
  return '.';
}

/** `DSH_HOME/profiles/<name>` 形式的绝对目录路径。 */
export function profileDir(profileName: string, home: string): string {
  const h = home.replaceAll('\\', '/').replace(/\/+$/, '');
  return `${h}/profiles/${profileName}`;
}
