import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDashboard, normalizeRange, RANGE_KEYS } from './aggregate.ts';
import { resolveDshHome } from './discover.ts';
import { dashboardFromStore, startServer } from './server.ts';
import { defaultStorePath, syncSessions } from './store.ts';

const USAGE = `dsh-session-stats —— DSH 会话用量统计面板

用法: pnpm tsx packages/dsh-session-stats/src/cli.ts <命令> [选项]

命令:
  sync                 同步本地全部会话文件到统计 store
  serve                启动面板服务（默认 http://127.0.0.1:3848）
  export               导出独立单文件网页（内嵌数据，可直接双击打开）

通用选项:
  --home <dir>         DSH 主目录（默认 ~/.dsh，可用 DSH_HOME 覆盖）
  --store <file>       store 路径（默认 <home>/dsh-session-stats/store.json）
  --force              sync 时强制重新解码全部文件

serve 选项:
  --port <n>           监听端口（默认 3848）
  --open               启动后用系统默认浏览器打开

export 选项:
  --out <file>         输出路径（默认 ./dsh-session-stats.html）
  --range <r>          预置数据范围 ${RANGE_KEYS.join('/')}（默认 all）
`;

interface ParsedArgs {
  command: string | null;
  flags: Map<string, string>;
  has: (name: string) => boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const boolFlags = new Set<string>();
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (command === null) command = arg;
      continue;
    }
    const name = arg.slice(2);
    if (name.length === 0) continue; // 裸 "--" 分隔符
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(name, next);
      i++;
    } else {
      boolFlags.add(name);
    }
  }
  return {
    command,
    flags,
    has: (name: string) => flags.has(name) || boolFlags.has(name),
  };
}

function flagOr(args: ParsedArgs, name: string, fallback: string): string {
  return args.flags.get(name) ?? fallback;
}

function cmdSync(args: ParsedArgs): number {
  const dshHome = resolveDshHome(flagOr(args, 'home', ''));
  const storePath = args.has('store')
    ? flagOr(args, 'store', '')
    : defaultStorePath(dshHome);
  const { result } = syncSessions({
    dshHome,
    storePath,
    force: args.has('force'),
  });
  console.log(
    `[session-stats] 同步完成：发现 ${result.files} 个会话文件，` +
      `本次解码 ${result.processed} 个，共 ${result.sessions} 个会话 / ` +
      `${result.totalMessages} 条消息，耗时 ${result.durationMs}ms`,
  );
  console.log(`[session-stats] store: ${storePath}`);
  return 0;
}

function cmdServe(args: ParsedArgs): number {
  const port = Number.parseInt(flagOr(args, 'port', '3848'), 10);
  const dshHome = resolveDshHome(flagOr(args, 'home', ''));
  const server = startServer({ port, dshHome });
  const url = `http://127.0.0.1:${port}`;
  server.on('listening', () => {
    console.log(`[session-stats] 面板已启动: ${url}  (DSH home: ${dshHome})`);
    if (args.has('open')) {
      spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    }
  });
  server.on('error', (error) => {
    console.error(`[session-stats] 服务启动失败: ${error.message}`);
    process.exitCode = 1;
  });
  return 0;
}

/** 把 html 中第一处 needle 替换为 replacement（字面量，不做 $ 展开与正则解释）。 */
function spliceOnce(
  html: string,
  needle: string,
  replacement: string,
): string | null {
  const pos = html.indexOf(needle);
  if (pos === -1) return null;
  return html.slice(0, pos) + replacement + html.slice(pos + needle.length);
}

function cmdExport(args: ParsedArgs): number {
  const dshHome = resolveDshHome(flagOr(args, 'home', ''));
  const range = normalizeRange(args.flags.get('range'));
  const out = path.resolve(flagOr(args, 'out', 'dsh-session-stats.html'));
  const { payload } = dashboardFromStore(dshHome, range, true);
  const data = payload ?? buildDashboard([], { range });
  const webDir = fileURLToPath(new URL('../web/', import.meta.url));
  let html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');

  // 单文件化：内联 CSS 与 JS，使导出的网页脱离包目录也能直接打开。
  // 注意：产物 bundle 内含 "$&" 等字面量，禁止用 String.replace 的替换串语义，全部走字面量拼接。
  const css = fs.readFileSync(path.join(webDir, 'styles.css'), 'utf8');
  const js = fs
    .readFileSync(path.join(webDir, 'app.js'), 'utf8')
    .replaceAll('</script', '<\\/script');
  const json = JSON.stringify(data).replaceAll('</', '<\\/');
  const steps: Array<[string, string]> = [
    [
      '<link rel="stylesheet" href="styles.css" />',
      `<style>\n${css}\n</style>`,
    ],
    ['window.__STATS_DATA__ = null', `window.__STATS_DATA__ = ${json};`],
    ['<script src="app.js"></script>', `<script>\n${js}\n</script>`],
  ];
  for (const [needle, replacement] of steps) {
    const next = spliceOnce(html, needle, replacement);
    if (next === null) {
      console.error(
        `[session-stats] 导出失败：模板中未找到内联点 ${JSON.stringify(needle)}`,
      );
      return 1;
    }
    html = next;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  const overview = (data as { overview?: { sessions?: number } }).overview;
  console.log(
    `[session-stats] 已导出: ${out}（range=${range}，会话 ${overview?.sessions ?? 0} 个）`,
  );
  return 0;
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'sync':
      return cmdSync(args);
    case 'serve':
      return cmdServe(args);
    case 'export':
      return cmdExport(args);
    default:
      console.log(USAGE);
      return args.command === null ? 0 : 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
