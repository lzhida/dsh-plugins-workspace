/**
 * 构建脚本：产出两个 ESM 产物。
 *
 *   - dist/index.js        ← src/index.ts（插件入口，main 字段指向它）
 *   - dist/board-context.js ← src/entries/board-context.ts（预设内引用的包子路径入口）
 *
 * 为什么必须构建（不能直接发 .ts）：
 *   实体安装（git/npm/tarball）时插件落在 profile 的 node_modules 下，Node 拒绝对
 *   realpath 位于 node_modules 之下的 .ts 做 type-stripping
 *   （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），宿主只会报一句静默的
 *   "failed to import"。构建式发行是本仓对实体安装插件的既定做法。
 *
 * 产物可重复：absWorkingDir 固定到包目录（不依赖调用时的 cwd），构建选项内联，
 * 不读外部 tsconfig.json。
 */

import { build, type BuildOptions } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根目录（固定绝对路径，产物字节可重复）。 */
const pkgRoot = fileURLToPath(new URL('../', import.meta.url));

/** 包清单（取包名做断言）。 */
const pkg = JSON.parse(
  await readFile(path.join(pkgRoot, 'package.json'), 'utf8'),
) as { name?: string };

/**
 * 内联 tsconfig：esbuild 只认字符串形式的配置，这里用对象形式内联。
 * `as const` 不可省——否则 esbuild 的 TS2322 会因字面量类型不匹配而报错。
 */
const tsconfigRaw = {
  compilerOptions: {
    strict: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    verbatimModuleSyntax: true,
  },
} as const;

/** 构建选项（相对 outfile 以 pkgRoot 为基准）。 */
const buildOptions: BuildOptions = {
  absWorkingDir: pkgRoot,
  tsconfigRaw,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // 默认 ascii 会把产物里的中文压成 \uXXXX 转义，可读性差且构建断言的中文
  // 锚点无法直接匹配；显式保持 utf8（源文件本就是 UTF-8）。
  charset: 'utf8',
  // 宿主运行时包一律 external（即便本包当前一个都没 import，也留着这条防线）。
  external: ['@deepseek-ai/*', 'schemastery'],
};

/**
 * 构建断言：不通过就抛错，让构建直接失败。
 * @param condition - 断言条件。
 * @param message - 失败信息（中文）。
 */
function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[build] 断言失败：${message}`);
  }
}

/**
 * 读取产物文本。
 * @param relative - 相对包根的产物路径。
 * @returns 产物文本。
 */
async function readArtifact(relative: string): Promise<string> {
  return await readFile(path.join(pkgRoot, relative), 'utf8');
}

// 产物一：插件入口。
await build({
  ...buildOptions,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
});

// 产物二：看板上下文子路径入口。
await build({
  ...buildOptions,
  entryPoints: ['src/entries/board-context.ts'],
  outfile: 'dist/board-context.js',
});

const indexArtifact = await readArtifact('dist/index.js');
const boardContextArtifact = await readArtifact('dist/board-context.js');

// 断言一：宿主半区零 @deepseek-ai 运行时引用（宿主服务一律用本地窄接口声明）。
assert(
  !/from\s*["']@deepseek-ai\//.test(indexArtifact) &&
    !/require\(["']@deepseek-ai\//.test(indexArtifact),
  'dist/index.js 不得含 @deepseek-ai 运行时引用',
);
assert(
  !/from\s*["']@deepseek-ai\//.test(boardContextArtifact) &&
    !/require\(["']@deepseek-ai\//.test(boardContextArtifact),
  'dist/board-context.js 不得含 @deepseek-ai 运行时引用',
);

// 断言二：产物含预期标记。
assert(
  indexArtifact.includes('dsh-kanban-mode'),
  'dist/index.js 必须含插件名 dsh-kanban-mode',
);
assert(
  indexArtifact.includes('kanban-mode'),
  'dist/index.js 必须含预设 id kanban-mode',
);
// 内嵌 skill 随入口打进产物：注册名 / source 契约 / invocation 契约 / 正文锚点。
assert(
  indexArtifact.includes('kanban-task-create'),
  'dist/index.js 必须含内嵌 skill 注册名 kanban-task-create',
);
assert(
  indexArtifact.includes('bundled') && indexArtifact.includes('modelInvocable'),
  'dist/index.js 必须含内嵌 skill 的 bundled/invocation 注册契约',
);
assert(
  indexArtifact.includes('在看板模式下取代用户级副本的建卡职责'),
  'dist/index.js 必须内嵌 skill 正文锚点（内联声明）',
);
assert(
  boardContextArtifact.includes('kanban-board-context'),
  'dist/board-context.js 必须含插件名 kanban-board-context',
);
assert(
  boardContextArtifact.includes('kanban-mode:context'),
  'dist/board-context.js 必须含系统提示段落名 kanban-mode:context',
);

// 断言三：硬红线（原「零 dsh-taskboard 引用」断言的精确化改造）。
// 看板模式三工具经 ctx.get('dsh-taskboard') 在**运行时软读取**板服务（对齐
// dsh-anytype wiki 先例），服务缺失的可操作报错文案里也会出现插件名——
// 带引号的 'dsh-taskboard' 字面量在入口产物中自此是合法存在。原断言的
// 实质红线改为三件事，逐一守住：
//   a) 零跨包 import/require（不得 import @zhidal/dsh-taskboard 任何子路径）；
//   b) 零插件行形状引用（预设行集不得挂 dsh-taskboard 行——防双
//      SchedulerService 与 taskboard_* 工具名遮蔽）；
//   c) board-context 子产物保持零 dsh-taskboard 痕迹（它不含工具代码）。
const TASKBOARD_IMPORT_REFERENCE =
  /(?:from|require\()\s*["'](?:@zhidal\/)?dsh-taskboard/;
assert(
  !TASKBOARD_IMPORT_REFERENCE.test(indexArtifact) &&
    !TASKBOARD_IMPORT_REFERENCE.test(boardContextArtifact),
  '产物不得 import/require dsh-taskboard 包（板服务只允许运行时软读取）',
);
const TASKBOARD_ROW_SHAPE =
  /(?:id|name)\s*:\s*["'](?:@zhidal\/)?dsh-taskboard["']/;
assert(
  !TASKBOARD_ROW_SHAPE.test(indexArtifact) &&
    !TASKBOARD_ROW_SHAPE.test(boardContextArtifact),
  '产物不得把 dsh-taskboard 挂成预设插件行（防双 SchedulerService + 工具遮蔽）',
);
const TASKBOARD_ANY_REFERENCE =
  /["'](?:@zhidal\/)?dsh-taskboard(?:\/[^"']*)?["']/;
assert(
  !TASKBOARD_ANY_REFERENCE.test(boardContextArtifact),
  'dist/board-context.js 必须零 dsh-taskboard 痕迹（工具代码只在入口产物）',
);

// 断言四：板服务软读取与三工具注册标记（正面断言，配对断言三的红线）。
assert(
  indexArtifact.includes('dsh-taskboard') &&
    indexArtifact.includes('BOARD_SERVICE_NAME'),
  'dist/index.js 必须含 dsh-taskboard 板服务软读取标记（BOARD_SERVICE_NAME）',
);
assert(
  indexArtifact.includes('kanban_ready_cards') &&
    indexArtifact.includes('kanban_plan_check') &&
    indexArtifact.includes('kanban_schedule_run'),
  'dist/index.js 必须含三个看板模式工具名（kanban_ready_cards/kanban_plan_check/kanban_schedule_run）',
);

console.log(`[build] ${pkg.name ?? 'dsh-kanban-mode'} 构建完成`);
console.log(`[build] 产物：${path.join(pkgRoot, 'dist', 'index.js')}`);
console.log(`[build] 产物：${path.join(pkgRoot, 'dist', 'board-context.js')}`);
console.log('[build] 断言全部通过');
