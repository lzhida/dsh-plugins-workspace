/**
 * workspace 解析:从 pnpm-workspace.yaml 的 packages 模式发现子包清单。
 * 版本写回由 Changesets 负责,本模块只读。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReleaseError, shortNameOf } from './core.ts';
import type { WorkspacePackage } from './core.ts';

interface ManifestJson {
  name?: unknown;
  version?: unknown;
  private?: unknown;
}

/**
 * 解析 pnpm-workspace.yaml 中的 `packages:` 模式列表。
 * 仅支持字面目录(`packages/foo`)与单层通配(`packages/*`),
 * 复杂 glob(如 `**`)不被支持并显式报错,避免静默漏包。
 */
export function loadWorkspacePatterns(rootDir: string): string[] {
  const file = join(rootDir, 'pnpm-workspace.yaml');
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new ReleaseError(
      'WORKSPACE_CONFIG',
      `读取 ${file} 失败:本工具需要在 pnpm workspace 根目录运行`,
    );
  }
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const entry = /^\s*-\s+(.+?)\s*$/.exec(line);
    if (entry) {
      patterns.push(entry[1].replace(/^['"]/, '').replace(/['"]$/, ''));
      continue;
    }
    if (line.trim() === '') continue;
    break; // 碰到下一个顶层键,packages 段结束
  }
  if (patterns.length === 0) {
    throw new ReleaseError(
      'WORKSPACE_CONFIG',
      `${file} 中未声明 packages 模式,无法发现子包`,
    );
  }
  return patterns;
}

/** 把单条 workspace 模式展开为相对根目录的 posix 风格包目录列表。 */
function expandPattern(rootDir: string, pattern: string): string[] {
  const segments = pattern.split(/[\\/]+/);
  const starIndex = segments.indexOf('*');
  if (starIndex === -1) {
    return existsSync(join(rootDir, ...segments, 'package.json'))
      ? [segments.join('/')]
      : [];
  }
  if (pattern.includes('**') || starIndex !== segments.length - 1) {
    throw new ReleaseError(
      'WORKSPACE_CONFIG',
      `不支持的 workspace 模式 "${pattern}":本工具仅支持字面目录与单层通配(如 packages/*)`,
    );
  }
  const base = join(rootDir, ...segments.slice(0, starIndex));
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => [...segments.slice(0, starIndex), entry.name].join('/'))
    .filter((rel) => existsSync(join(rootDir, rel, 'package.json')));
}

/** 解析单个包目录的 package.json,校验 name/version 必填。 */
function parseManifest(rootDir: string, relDir: string): WorkspacePackage {
  const file = join(rootDir, relDir, 'package.json');
  let manifest: ManifestJson;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8')) as ManifestJson;
  } catch (error) {
    throw new ReleaseError(
      'PKG_MANIFEST_INVALID',
      `解析 ${file} 失败: ${(error as Error).message}`,
    );
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new ReleaseError(
      'PKG_MANIFEST_INVALID',
      `${file} 缺少合法的 name 字段`,
    );
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new ReleaseError(
      'PKG_VERSION_MISSING',
      `${file} 缺少 version 字段,无法参与版本管理`,
    );
  }
  const name = manifest.name;
  return {
    name,
    shortName: shortNameOf(name),
    version: manifest.version,
    isPrivate: manifest.private === true,
    dir: relDir,
  };
}

/** 列出 workspace 全部子包,按完整包名排序;同一目录只收录一次。 */
export function listWorkspacePackages(rootDir: string): WorkspacePackage[] {
  const byDir = new Map<string, WorkspacePackage>();
  for (const pattern of loadWorkspacePatterns(rootDir)) {
    for (const relDir of expandPattern(rootDir, pattern)) {
      if (byDir.has(relDir)) continue;
      byDir.set(relDir, parseManifest(rootDir, relDir));
    }
  }
  return [...byDir.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}
