/**
 * conflict-plan.ts 测试:冲突文件结构化建议。
 *
 * 纯函数:parseLsFilesUnmerged(z 输出解析)/ flavorFromStages(五类冲突形态)/
 * flavorSuggestions(建议生成)/ formatConflictSuggestion(单行格式化)。
 * 真实 git:在 merge 冲突现场跑 buildConflictPlan,验证条目结构与预览裁剪。
 *
 * @module dsh-kanban-mode/harvest/conflict-plan.test
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 真实 git 仓在 Windows 上单用例可接近 vitest 默认 5s 上限,统一放宽到 30s。
vi.setConfig({ testTimeout: 30_000 });

import { createGitRunner } from './git-runner.ts';
import type { GitRunner } from './git-runner.ts';
import {
  buildConflictPlan,
  flavorFromStages,
  flavorSuggestions,
  formatConflictSuggestion,
  parseLsFilesUnmerged,
} from './conflict-plan.ts';

/** 一次性临时目录(建在 os.tmpdir());调用方负责 finally 清理。 */
async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/** 在临时目录初始化确定性仓库。 */
async function initRepo(runner: GitRunner, dir: string): Promise<void> {
  await runner.captureOrThrow(['init', '-b', 'main'], { cwd: dir });
  await runner.captureOrThrow(
    ['config', 'user.email', 'harvest-test@example.com'],
    { cwd: dir },
  );
  await runner.captureOrThrow(['config', 'user.name', 'harvest-test'], {
    cwd: dir,
  });
  await runner.captureOrThrow(['config', 'commit.gpgsign', 'false'], {
    cwd: dir,
  });
}

/** 写文件并提交。 */
async function commitFile(
  runner: GitRunner,
  cwd: string,
  relPath: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(path.join(cwd, relPath), content, 'utf8');
  await runner.captureOrThrow(['add', '-A'], { cwd });
  await runner.captureOrThrow(['commit', '-m', message], { cwd });
  const hash = await runner.captureOrThrow(['rev-parse', '--short', 'HEAD'], {
    cwd,
  });
  return hash.stdout.trim();
}

describe('dsh-kanban-mode harvest:conflict-plan 纯函数', () => {
  it('parseLsFilesUnmerged 解析 z 分隔的 ls-files -u 输出并按 path 聚序', () => {
    const raw = [
      '100644 aaa111 1\ta.txt',
      '100644 bbb222 2\ta.txt',
      '100644 ccc333 3\ta.txt',
      '100644 ddd444 1\tsrc/内 目录/中 文.txt',
      '100644 eee555 3\tsrc/内 目录/中 文.txt',
    ]
      .join('\u0000')
      .concat('\u0000');
    const entries = parseLsFilesUnmerged(raw);
    expect(entries).toHaveLength(5);
    expect(entries[0]).toEqual({
      mode: '100644',
      blob: 'aaa111',
      stage: 1,
      path: 'a.txt',
    });
    expect(entries[1]?.stage).toBe(2);
    expect(entries[2]?.stage).toBe(3);
    expect(entries[3]?.path).toBe('src/内 目录/中 文.txt');
    expect(entries[4]?.blob).toBe('eee555');
    // 空输入返回空数组。
    expect(parseLsFilesUnmerged('')).toEqual([]);
  });

  it('flavorFromStages 覆盖五类冲突形态', () => {
    expect(flavorFromStages([1, 2, 3])).toBe('both-modified');
    expect(flavorFromStages([2, 3])).toBe('both-added');
    expect(flavorFromStages([1])).toBe('both-deleted');
    expect(flavorFromStages([1, 2])).toBe('deleted-by-them');
    expect(flavorFromStages([1, 3])).toBe('deleted-by-us');
  });

  it('flavorSuggestions 对每类形态给出含路径的可操作建议', () => {
    for (const flavor of [
      'both-modified',
      'both-added',
      'deleted-by-us',
      'deleted-by-them',
      'both-deleted',
    ] as const) {
      const suggestions = flavorSuggestions(flavor, 'a.txt');
      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.join(' ')).toContain('a.txt');
    }
  });

  it('formatConflictSuggestion 输出 [flavor] path: 前缀格式', () => {
    const line = formatConflictSuggestion({
      path: 'a.txt',
      flavor: 'both-modified',
      base: { present: true, lineCount: 2, preview: [] },
      ours: { present: true, lineCount: 2, preview: [] },
      theirs: { present: true, lineCount: 2, preview: [] },
      suggestions: ['手工合并两侧改动', '完成后 git add'],
    });
    expect(line).toBe('[both-modified] a.txt:手工合并两侧改动');
    expect(line).toContain('手工合并两侧改动');
  });
});

describe('dsh-kanban-mode harvest:conflict-plan 真实冲突现场', () => {
  it('buildConflictPlan 在 merge 冲突现场返回结构化条目与预览', async () => {
    const runner = createGitRunner();
    const dir = await makeTempDir('dsh-kanban-harvest-cplan-merge-');
    try {
      await initRepo(runner, dir);
      await commitFile(
        runner,
        dir,
        'a.txt',
        'line1\nline2\nline3\nline4\nline5\nline6\n',
        'chore: 基线',
      );
      await runner.captureOrThrow(['checkout', '-b', 'task'], { cwd: dir });
      await commitFile(
        runner,
        dir,
        'a.txt',
        'task-line1\nline2\nline3\nline4\nline5\nline6\n',
        'feat: task',
      );
      await runner.captureOrThrow(['checkout', 'main'], { cwd: dir });
      await commitFile(
        runner,
        dir,
        'a.txt',
        'main-line1\nline2\nline3\nline4\nline5\nline6\n',
        'feat: main',
      );
      const merge = await runner.capture(['merge', '--no-ff', 'task'], {
        cwd: dir,
      });
      expect(merge.ok).toBe(false);

      const plan = await buildConflictPlan(runner, dir, { previewLines: 2 });
      expect(plan.files).toHaveLength(1);
      const file = plan.files[0];
      expect(file?.path).toBe('a.txt');
      expect(file?.flavor).toBe('both-modified');
      // 三个 stage 都有内容,预览按 previewLines=2 裁剪。
      expect(file?.base.present).toBe(true);
      expect(file?.base.lineCount).toBe(6);
      expect(file?.base.preview).toHaveLength(2);
      expect(file?.ours.preview[0]).toContain('main-line1');
      expect(file?.theirs.preview[0]).toContain('task-line1');
      expect(file?.suggestions.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('无冲突的干净仓库返回空计划', async () => {
    const runner = createGitRunner();
    const dir = await makeTempDir('dsh-kanban-harvest-cplan-clean-');
    try {
      await initRepo(runner, dir);
      await commitFile(runner, dir, 'a.txt', 'hello\n', 'chore: 基线');
      const plan = await buildConflictPlan(runner, dir);
      expect(plan.files).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
