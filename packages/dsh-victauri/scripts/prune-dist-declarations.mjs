/**
 * 构建后处理：把 dist/ 里的声明文件裁剪到「公开声明面闭包」。
 *
 * 背景：tsc -p tsconfig.build.json 会为 src/** 全部源码产出 .d.ts（含
 * src/tools/** 内部实现），但发布包只有 dist/index.js 一个 bundle 入口，
 * 内部 .d.ts 既无对应 .js（深导入 dist/tools/standalone/render.js 运行时
 * 必然 ERR_MODULE_NOT_FOUND），又会把内部实现对外部包的引用（当前是
 * @deepseek-ai/dsh-llm/types）泄露到发布包里。
 *
 * 本脚本从 dist/index.d.ts 出发做可达性闭包（跟随相对说明符 './x.ts'），
 * 只保留闭包内的 .d.ts，其余删除。闭包是「算出来」的而不是硬编码清单，
 * 公开导出面新增内部类型时无需改脚本。
 *
 * 只删 dist/**.d.ts，不碰 .js / .js.map。
 *
 * 剪枝前还有一道发布自检（assertNoTypeReferenceDirectives）：src/** 里
 * 不允许出现行首的真指令 /// <reference path="...">；/// <reference types="...">
 * 只告警（标准写法，丢弃后通常由 @types/* 兜底）。理由见该函数注释。
 */
import { readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

const DIST = path.resolve(process.cwd(), 'dist');
const SRC = path.resolve(process.cwd(), 'src');
const ENTRY = path.join(DIST, 'index.d.ts');

/** 收集文件里出现的相对说明符（'./x.ts' / '../x.js' / triple-slash reference）。 */
function relativeSpecifiers(source) {
  const found = new Set();
  for (const match of source.matchAll(/['"](\.\.?\/[^'"]+)['"]/g)) {
    found.add(match[1]);
  }
  // triple-slash reference：/// <reference path="./x.ts" />
  // （上面的字符串正则一般也能捕获，这里显式兜底，避免正则调整时漏掉）。
  for (const match of source.matchAll(
    /<reference\s+path\s*=\s*["']([^"']+)["']/g,
  )) {
    found.add(match[1]);
  }
  return found;
}

/** 相对说明符 → 同名 .d.ts 的绝对路径（TS 的 .ts→.d.ts 替换规则）。 */
function declarationPathFor(specifier, fromFile) {
  const resolved = path.resolve(path.dirname(fromFile), specifier);
  // 说明符本身已经是声明文件（'./x.d.ts' / './x.d.mts'）→ 原样使用，
  // 否则会拼成 x.d.d.ts 导致目标不存在、被当成不可达而误删。
  if (/\.d\.(ts|mts|cts)$/.test(resolved)) return resolved;
  const ext = path.extname(resolved);
  // TS 的替换规则（实测 tsc --traceResolution）：.mts/.mjs → .d.mts，
  // .cts/.cjs → .d.cts，其余（.ts/.tsx/.js）→ .d.ts
  const declExt =
    ext === '.mts' || ext === '.mjs'
      ? '.d.mts'
      : ext === '.cts' || ext === '.cjs'
        ? '.d.cts'
        : '.d.ts';
  const withoutExt = resolved.slice(0, resolved.length - ext.length);
  return `${withoutExt}${declExt}`;
}

/** 递归列出 dist 下所有 .d.ts。 */
async function listDeclarations(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listDeclarations(full)));
    } else if (entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 递归列出 src 下的源码文件（.ts/.tsx/.mts/.cts/.d.ts）。 */
async function listSourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listSourceFiles(full)));
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 剥掉块注释与字符串字面量（**保留行注释原文**），让后面的指令扫描不会被注释
 * 或字符串里的同名文本误伤。
 *
 * 行注释必须保留：triple-slash 指令本身就是行注释的一种，剥掉就再也检测不到。
 * 之所以还留着行注释，是因为判定用的是「行首真指令」——TS 的 triple-slash 指令
 * 只能出现在行首（前面只有空白），行首之外的 `/// <reference ...>` 只是普通文本。
 */
function stripCommentsAndStrings(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  // code | line | block | single | double | template
  let state = 'code';
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        // 行注释的 `//` 原样保留：triple-slash 指令是三个斜杠，若把前两个换成
        // 空格，`///` 就只剩 `/`，指令会被漏检。
        out += '//';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (ch === "'") state = 'single';
      else if (ch === '"') state = 'double';
      else if (ch === '`') state = 'template';
      if (state === 'code') {
        out += ch;
        i += 1;
        continue;
      }
      out += ' ';
      i += 1;
      continue;
    }
    if (state === 'line') {
      // 行注释原文保留（triple-slash 指令就在这里）。
      if (ch === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ch;
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += ch === '\n' ? '\n' : ' ';
      i += 1;
      continue;
    }
    // 字符串 / 模板字面量：内容整体替换为空格（保留换行以维持行号）。
    if (ch === '\\') {
      out += '  ';
      i += 2;
      continue;
    }
    if (
      (state === 'single' && ch === "'") ||
      (state === 'double' && ch === '"') ||
      (state === 'template' && ch === '`')
    ) {
      state = 'code';
      out += ' ';
      i += 1;
      continue;
    }
    out += ch === '\n' ? '\n' : ' ';
    i += 1;
  }
  return out;
}

/**
 * 发布前自检：src/** 里不允许出现**行首的真指令** `/// <reference path="...">`；
 * `/// <reference types="...">` 只告警不阻断。
 *
 * 原因（2026-11-09 实测）：tsc 的声明 emit 会把源码里的 reference 指令整条丢掉。
 *   源码  /// <reference path="./edge-globals.ts" /> + export declare const edgeTriple: EdgeGlobal
 *   产出  dist/edge-triple.d.ts 只有 export declare const edgeTriple: EdgeGlobal;
 *          —— 既没有 import，也没有 reference。
 * 于是消费者装上发布包后，dist/edge-triple.d.ts 里的 EdgeGlobal 是悬空全局名，
 * 直接报 error TS2304: Cannot find name 'EdgeGlobal'。
 *
 * 关键推论：这种场景下「剪枝时把被引用的 .d.ts 留下来」救不回来——reference
 * 指令本身已经在 emit 阶段丢了，消费者的 tsc 无从知道该去读哪个文件。
 * 所以只能在构建期挡住：一旦源码里出现 triple-slash 类型引用，就让构建失败，
 * 要求改用显式 `import type`（emit 会保留 import 语句，声明面才自洽）。
 *
 * 分级理由（2026-11-09 第四轮复核后调整）：
 *   - `path=` 阻断：它指向的全局类型只可能来自本仓源码，emit 丢弃后必然悬空。
 *   - `types=` 只告警：`/// <reference types="node" />` 是 Node 项目的标准写法，
 *     被 emit 丢弃后通常仍由消费者侧的 `@types/node` 兜底；阻断它会误伤合法代码。
 *   - 只认行首指令：注释块里、字符串里、行中间的同名文本不是 TS 指令，不能误伤。
 *
 * 判定范围取「src 下任意文件」而非「只有随包发布的那些」：TS 的全局作用域是
 * 整个 program 级的，别的文件的 reference 指令同样可能把全局类型带进公开声明
 * 面。宁可严格，也不让坏的声明面漏到 npm 上。
 */
async function assertNoTypeReferenceDirectives() {
  const blockers = [];
  const warnings = [];
  for (const file of await listSourceFiles(SRC)) {
    const source = await readFile(file, 'utf8');
    const stripped = stripCommentsAndStrings(source);
    stripped.split(/\r?\n/).forEach((line, index) => {
      const match = /^\s*\/\/\/\s*<reference\s+(path|types)\s*=/.exec(line);
      if (!match) return;
      const where = `${path.relative(process.cwd(), file)}:${index + 1}`;
      if (match[1] === 'path') blockers.push(where);
      else warnings.push(where);
    });
  }
  if (blockers.length > 0) {
    throw new Error(
      [
        'prune-dist-declarations: src/** 里出现 /// <reference path="..."> 指令：',
        '  tsc 的声明 emit 会丢弃该指令（实测），产出的 .d.ts 会留下悬空的全局类型名，',
        '  消费者侧编译将报 TS2304: Cannot find name ...；',
        '  剪枝时保留被引用的 .d.ts 也救不回来（reference 已在 emit 阶段丢失）。',
        `  命中位置：${blockers.join(', ')}`,
        '  请改用显式的 `import type { X } from "./x.ts"`（emit 会保留 import），再重新构建。',
      ].join('\n'),
    );
  }
  if (warnings.length > 0) {
    console.warn(
      [
        'prune-dist-declarations: 警告 —— src/** 里出现 /// <reference types="..."> 指令：',
        '  该指令同样会被 tsc 的声明 emit 丢弃；若它引入的全局类型出现在公开声明面上，',
        '  消费者侧会报 TS2304: Cannot find name ...（通常由消费者的 @types/* 兜底）。',
        `  命中位置：${warnings.join(', ')}`,
        '  如无必要请改用显式的 `import type`。',
      ].join('\n'),
    );
  }
}

async function main() {
  try {
    await readFile(ENTRY, 'utf8');
  } catch {
    throw new Error(
      `找不到 ${ENTRY}：先跑 tsc -p tsconfig.build.json 生成声明，再裁剪。`,
    );
  }

  await assertNoTypeReferenceDirectives();

  const keep = new Set([ENTRY]);
  const missing = [];
  const queue = [ENTRY];
  while (queue.length > 0) {
    const current = queue.pop();
    const source = await readFile(current, 'utf8');
    for (const specifier of relativeSpecifiers(source)) {
      const target = declarationPathFor(specifier, current);
      if (keep.has(target)) continue;
      let exists = true;
      try {
        await readFile(target, 'utf8');
      } catch {
        exists = false;
      }
      if (!exists) {
        // 说明符指向的声明不存在（可能是运行时资源或已裁剪的内部声明）→ 跳过。
        missing.push(path.relative(DIST, target));
        continue;
      }
      keep.add(target);
      queue.push(target);
    }
  }

  const all = await listDeclarations(DIST);
  const removed = [];
  for (const file of all) {
    if (keep.has(file)) continue;
    await rm(file, { force: true });
    removed.push(path.relative(DIST, file));
  }

  const kept = [...keep]
    .map((file) => path.relative(DIST, file))
    .sort()
    .join(', ');
  console.log(
    `prune-dist-declarations: 保留 ${keep.size} 个声明（${kept}），删除 ${removed.length} 个：${removed.join(', ') || '（无）'}`,
  );
  if (missing.length > 0) {
    // 说明符指向的声明不存在时跳过（不算错），但要留痕，避免"看起来被删了"的误判。
    console.log(
      `prune-dist-declarations: 跳过 ${missing.length} 个不存在的声明目标：${[...new Set(missing)].join(', ')}`,
    );
  }
  await removeEmptyDirs(DIST);
}

/** 清掉剪枝后残留的空目录（如 dist/tools/standalone）。 */
async function removeEmptyDirs(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    await removeEmptyDirs(full);
    const info = await stat(full);
    if (info.isDirectory() && (await readdir(full)).length === 0) {
      await rmdir(full);
    }
  }
}

await main();
