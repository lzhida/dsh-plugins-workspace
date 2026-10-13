/**
 * GitHub Actions workflow 文本断言辅助,供 ci-workflow / release-workflow
 * 回归测试共用。仓库为 pnpm 隔离 node_modules,传递依赖不可直接 import,
 * 因此不做真正的 YAML AST 解析,走结构化文本检查(语义足够且零新增依赖)。
 */

/** 提取某个键(按 trim 后等于 `<key>:` 识别)之下缩进更深的连续文本块 */
export function blockOf(source: string, key: string): string {
  const lines = source.split(/\r?\n/);
  const idx = lines.findIndex((line) => line.trim() === `${key}:`);
  if (idx < 0) {
    throw new Error(`工作流缺少 ${key}: 块`);
  }
  const baseIndent = lines[idx].length - lines[idx].trimStart().length;
  const collected: string[] = [];
  for (let i = idx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') {
      collected.push(line);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= baseIndent) break;
    collected.push(line);
  }
  return collected.join('\n');
}

/** 从 `branches: [a, b]` 提取分支名列表 */
export function branchesOf(block: string, label: string): string[] {
  const match = block.match(/branches:\s*\[([^\]]*)\]/);
  if (!match) {
    throw new Error(`${label} 缺少 branches 列表`);
  }
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
}

/** 从 `tags: [...]` 提取 tag 模式列表 */
export function tagsOf(block: string, label: string): string[] {
  const match = block.match(/tags:\s*\[([^\]]*)\]/);
  if (!match) {
    throw new Error(`${label} 缺少 tags 列表`);
  }
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''));
}

/** 收集 run 步骤中的 `pnpm <词>` 调用词(脚本名或内建命令) */
export function pnpmInvocationsOf(source: string): string[] {
  const invocations: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.includes('run:')) continue;
    for (const match of line.matchAll(/pnpm\s+([^\s]+)/g)) {
      const name = match[1];
      if (name) invocations.push(name);
    }
  }
  return invocations;
}
