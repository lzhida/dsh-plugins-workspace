/**
 * 包 CHANGELOG 的版本段提取与发布内容组装(纯函数 + 只读文件)。
 *
 * 内容源唯一原则:Changesets 在 `changeset version` 时把每个版本的更新
 * 说明写入 `packages/<pkg>/CHANGELOG.md`(标题行 `## {version}`)。发布链的
 * 两处"给人看"的内容——annotated tag 的 message 与 GitHub Release 的
 * release notes——都从同一段落提取,保证 tag 页 / Release 页 / CHANGELOG
 * 三处内容一致。
 *
 * 降级永不阻塞:CHANGELOG 文件缺失、或其中没有该版本的段落时,提取返回
 * null,调用方用纯标题( tag )或兜底文案( notes )继续发布。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 转义 version 中的正则元字符(semver 只含 .,防御性处理,不依赖该假设)。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 从 CHANGELOG 内容中提取指定版本的段落。
 *
 * Changesets 生成的标题行形态为 `## {version}`;这里额外容错三种常见变体:
 * `## [{version}]`(keep-a-changelog 风格)、`## v{version}`、以及尾部日期
 * 注释 `## 0.5.0 (2026-10-14)`。段落 = 该标题行到下一个 `^## ` 标题行(或
 * 文件尾)之间的内容,去首尾空行后返回;找不到该版本 → null。
 */
export function extractChangelogSection(
  content: string,
  version: string,
): string | null {
  const header = new RegExp(
    `^##\\s+\\[?v?${escapeRegExp(version)}\\]?(?:\\s*\\([^)]*\\))?\\s*$`,
    'm',
  );
  const match = header.exec(content);
  if (match === null) return null;
  const start = match.index + match[0].length;
  const rest = content.slice(start);
  const next = /^##\s/m.exec(rest);
  const section = (next === null ? rest : rest.slice(0, next.index)).trim();
  return section.length > 0 ? section : null;
}

/**
 * 读取包 CHANGELOG 中指定版本的段落:文件不存在或段落缺失 → null。
 * pkgDir 为相对仓库根的包目录(如 `packages/dsh-llm-fallback`)。
 */
export function readChangelogSection(
  rootDir: string,
  pkgDir: string,
  version: string,
): string | null {
  const changelogPath = join(rootDir, pkgDir, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) return null;
  const content = readFileSync(changelogPath, 'utf8');
  return extractChangelogSection(content, version);
}

/**
 * 组装 annotated tag 的 message:首行为 `pkg.name v{version}`(git 惯例,
 * 首个空行前是 subject),空行后接该版本 CHANGELOG 段落;段落缺失时退化为
 * 纯 subject(与历史行为一致,打 tag 永不因 CHANGELOG 缺失而失败)。
 */
export function buildTagMessage(
  pkgName: string,
  version: string,
  section: string | null,
): string {
  return section === null
    ? `${pkgName} v${version}`
    : `${pkgName} v${version}\n\n${section}`;
}

/**
 * 组装 GitHub Release 的 notes:优先 CHANGELOG 段落原文;缺失时给出兜底
 * 文案(明确标注内容缺失,而不是留一个空 Release)。
 */
export function buildReleaseNotes(
  pkgName: string,
  version: string,
  section: string | null,
): string {
  return (
    section ??
    `${pkgName} v${version}\n\n(未在包 CHANGELOG.md 中找到 ${version} 的更新段落)`
  );
}
