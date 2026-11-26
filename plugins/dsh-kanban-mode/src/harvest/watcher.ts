/**
 * 验收联动 watcher：轮询板服务 revision，检测任务状态**进入** done / canceled，
 * 分别触发收割管线（apply）与丢弃管线（discard）。
 *
 * 设计依据 docs/harvest-design.md §13.2（watcher 定稿）/§9（触发编排与留痕）：
 * - 感知：进程内轮询 `boardService.snapshot().revision`（纯内存读，默认 800ms）；
 *   revision 变化 → 对比前后快照，找出状态**进入** done / canceled 的卡。
 *   「进入」= 前后状态不同且新状态是 done/canceled——不是「当前是 done」，
 *   否则插件一启动就会把历史上已验收的卡全部收割一遍（首轮只建基线）。
 * - 队列：所有事件进同一条串行队列逐个处理；同一张卡绝不并发跑 git。
 * - done：解析收割目标 → 管线 apply（无冲突直合并 + 删检出 + 删分支 -d）→
 *   板服务评论留痕；冲突 / 主区脏等拒绝态 → **不动 git**，自动建「收割执行卡」交人。
 * - canceled：先只读采集「分支 tip + 检出脏文件清单」并评论留痕 → 再 discard
 *   （删检出，脏也删；删分支 -D）。**留痕严格先于删除**。
 *
 * 防递归红线：收割执行卡自己完成时同样产生 done 事件——处理前先用
 * `isHarvestExecutionCard` 排除，绝不因收割卡 done 再建收割卡。
 *
 * 运行环境开关（都不改变默认行为）：
 * - `DSH_HARVEST_WATCH_INTERVAL_MS`：轮询间隔（毫秒）。非法或 <=0 回落默认 800。
 * - `DSH_HARVEST_WATCH`：取 `off` / `0` / `false` 时**不启动** watcher；
 *   其余值（含未设置）启动。e2e 用它在「工具直呼」场景关掉自动收割，
 *   避免与手动 `taskboard_harvest` 调用抢同一张卡。
 *
 * @module dsh-kanban-mode/harvest/watcher
 */

import { stat } from 'node:fs/promises';

import { createGitRunner, toPosixPath } from './git-runner.ts';
import type { GitRunner } from './git-runner.ts';
import { createHarvestPipeline, officialWorktreePath } from './pipeline.ts';
import type {
  DiscardRequest,
  DiscardResult,
  HarvestPipeline,
  HarvestRequest,
  HarvestResult,
} from './pipeline.ts';
import {
  HARVEST_CARD_MARKER,
  HARVEST_CARD_TITLE_PREFIX,
  isHarvestExecutionCard,
  latestBranchEvidence,
  resolveHarvestTarget,
} from './task-target.ts';
import type { HarvestTaskFacts, WorkspaceRegistryFace } from './task-target.ts';
import { resolveBoardService } from '../tools/board-contract.ts';
import type {
  BoardAddTaskCommentInput,
  BoardCreateTaskInput,
  BoardLedger,
  BoardServiceContract,
  BoardTaskRecord,
} from '../tools/board-contract.ts';

/** 日志前缀（全仓统一，宿主日志里一眼分辨来源）。 */
const LOG_PREFIX = '[dsh-kanban-mode]';

/** watcher 默认轮询间隔（毫秒）。 */
export const DEFAULT_WATCH_INTERVAL_MS = 800;

/** 环境变量：轮询间隔（毫秒）；非法或 <=0 回落 {@link DEFAULT_WATCH_INTERVAL_MS}。 */
export const WATCH_INTERVAL_ENV = 'DSH_HARVEST_WATCH_INTERVAL_MS';

/** 环境变量：显式关闭开关；`off` / `0` / `false` 即不启动 watcher。 */
export const WATCH_ENABLE_ENV = 'DSH_HARVEST_WATCH';

/**
 * 续跑用的收割工具名。
 *
 * 与工具直呼面同名（`src/tools/harvest.ts`）；工具名若调整，这里要同步，
 * 否则收割执行卡的提示词会让 agent 去调一个不存在的工具。
 */
export const HARVEST_TOOL_NAME = 'taskboard_harvest';

/** 留痕评论的来源标记（写入上游 threadId，便于与用户/会话评论区分）。 */
const COMMENT_SOURCE = 'dsh-kanban-mode';

/** 收割执行卡的预设 id（与 preset-def.ts 的 KANBAN_PRESET_ID 一致）。 */
const HARVEST_CARD_PRESET_ID = 'kanban-mode';

/** 评论正文里最多列出的条目数（上游评论正文上限 4000 字符，别把卡片撑爆）。 */
const MAX_LISTED_ITEMS = 20;

/** watcher 的宿主上下文（板服务与项目注册表都在这里软读取）。 */
export interface HarvestWatcherContext {
  /** cordis Context 的服务软读取（服务缺失时返回 undefined）。 */
  get?(name: string): unknown;
}

/** watcher 构造选项。 */
export interface HarvestWatcherOptions {
  /** 宿主上下文（板服务与 workspaceRegistry 都走它软读取）。 */
  readonly context: HarvestWatcherContext;
  /** 轮询间隔（毫秒）；缺省读环境变量，再缺省 800。 */
  readonly intervalMs?: number;
  /** 收割管线（缺省新建真实管线；单测注入 fake）。 */
  readonly pipeline?: HarvestPipeline;
  /** git 执行器（丢弃前只读采集用；单测注入 fake）。 */
  readonly runner?: GitRunner;
  /** 环境变量面（缺省 process.env）。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** 日志出口（缺省 console.log）。 */
  readonly log?: (message: string) => void;
  /** 告警出口（缺省 console.warn）。 */
  readonly warn?: (message: string) => void;
}

/** watcher 对外接口。 */
export interface HarvestWatcher {
  /** 启动轮询（幂等；被环境变量关闭时不启动）。 */
  start(): void;
  /** 停止轮询（停表、清定时器；不打断已在处理的事件）。 */
  stop(): void;
  /** 手动跑一轮感知（e2e 驱动与单测用；等本轮入队的事件处理完才 resolve）。 */
  poll(): Promise<void>;
}

/**
 * 台账任务记录 + 描述/提示词。
 *
 * 上游记录带 description / prompt，而 lead 的窄契约（board-contract.ts）没声明
 * 这两个字段；这里用 {@link toCardFacts} 做一次**加宽读取**——运行时对象本来就
 * 带着这两个字段（窄契约只是没声明），防递归判定双保险（标题前缀 + 稳定标记）
 * 用得上。
 */
export type HarvestCardFacts = HarvestTaskFacts;

/**
 * 把板服务记录读成卡面事实（含 description / prompt）。
 *
 * 为什么可以加宽读：窄契约 `BoardTaskRecord` 只声明了本包用得到的字段，
 * 上游真实记录还带 description / prompt——这里只做只读加宽，不改任何字段。
 */
function toCardFacts(task: BoardTaskRecord): HarvestCardFacts {
  const wide = task as BoardTaskRecord & {
    readonly description?: string;
    readonly prompt?: string;
  };
  return {
    ...task,
    ...(wide.description !== undefined
      ? { description: wide.description }
      : {}),
    ...(wide.prompt !== undefined ? { prompt: wide.prompt } : {}),
  };
}

/** 丢弃目标（分支 / 检出可缺：旧卡 isolation=none）。 */
export interface DiscardTarget {
  /** 仓库主区绝对路径。 */
  readonly repo: string;
  /** 任务分支（缺省=无分支可删）。 */
  readonly branch?: string;
  /** 检出路径（缺省=无检出可删）。 */
  readonly worktreePath?: string;
}

/** 删除前的只读现场（分支 tip + 检出脏文件清单）。 */
export interface DiscardEvidence {
  readonly branch?: string;
  /** 分支 tip 提交哈希（读不到时缺省）。 */
  readonly branchTip?: string;
  /** 检出内的脏文件清单（删除前的现场）。 */
  readonly dirtyFiles: readonly string[];
  readonly worktreePath?: string;
  /** 采集过程的备注（读不到现场时如实说明）。 */
  readonly notes: readonly string[];
}

/** 一次状态进入事件。 */
interface StatusEntryEvent {
  readonly task: HarvestCardFacts;
  readonly status: 'done' | 'canceled';
  /** 检出该事件时的台账修订号（写进幂等键）。 */
  readonly revision: number;
}

/** 错误转可读文本。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 路径是否存在。 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 `git status --porcelain` 的文件清单（porcelain v1 口径）。
 *
 * 为什么本地再写一份：pipeline.ts 里的同名解析器是模块私有函数，而本卡禁止
 * 改动 pipeline.ts；口径必须与它一致（renames 取新路径、路径 POSIX 归一）。
 */
function parseStatusPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    // porcelain v1:`XY<空格>path`（renames 为 `old -> new`）。
    const rest = line.slice(3).trim();
    const arrow = rest.indexOf(' -> ');
    const filePath = arrow === -1 ? rest : rest.slice(arrow + 4);
    if (filePath.length > 0) paths.push(toPosixPath(filePath));
  }
  return paths;
}

/**
 * 解析轮询间隔（毫秒）：显式参数 > 环境变量 > 默认值。
 *
 * 环境变量非法（非数字 / <=0）时回落默认值——开关只用于 e2e 观察，
 * 写坏了也不该让 watcher 起不来。
 */
export function resolveWatchIntervalMs(
  explicit: number | undefined,
  env: Readonly<Record<string, string | undefined>>,
): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit > 0) {
    return Math.floor(explicit);
  }
  const raw = env[WATCH_INTERVAL_ENV]?.trim();
  if (raw !== undefined && raw.length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return DEFAULT_WATCH_INTERVAL_MS;
}

/**
 * watcher 是否启用：环境变量取 `off` / `0` / `false` 时关闭（不启动、不轮询）；
 * 其余值（含未设置）启用。关闭只影响「自动收割」这一条链路，
 * 不影响工具直呼与留痕/建卡逻辑本身。
 */
export function resolveWatchEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = env[WATCH_ENABLE_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return true;
  return !(raw === 'off' || raw === '0' || raw === 'false');
}

/** 起一个不阻塞进程退出的定时器（宿主正常退出时不因 watcher 挂着）。 */
function scheduleTimer(
  fn: () => void,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  const handle = setTimeout(fn, delayMs) as ReturnType<typeof setTimeout> & {
    unref?: () => void;
  };
  handle.unref?.();
  return handle;
}

/** 列表格式化（条目过多时截断，避免评论正文超长）。 */
function formatList(title: string, items: readonly string[]): string[] {
  const lines = [`- ${title}（${items.length}）:`];
  if (items.length === 0) {
    lines.push('  （无）');
    return lines;
  }
  const shown = items.slice(0, MAX_LISTED_ITEMS);
  for (const item of shown) lines.push(`  - ${item}`);
  if (items.length > shown.length) {
    lines.push(`  - …另有 ${items.length - shown.length} 条`);
  }
  return lines;
}

/**
 * 判定这次拒绝是否还需要人工介入。
 *
 * 「任务分支不存在」「目标分支与任务分支相同」属于无事可做（分支都没了 /
 * 无需合并），再建收割卡只是噪音；其余拒绝态（主区脏、base 不匹配、合并进行中、
 * 检出创建失败等）都需要人接手。
 */
function isActionableRejection(result: HarvestResult): boolean {
  const reason = result.reason ?? '';
  if (reason.includes('任务分支不存在')) return false;
  if (reason.includes('目标分支与任务分支相同')) return false;
  return true;
}

/**
 * 解析丢弃目标（仓库必有，分支 / 检出可缺）。
 *
 * 优先复用共享解析器 `resolveHarvestTarget`；它失败时区分两种情况：
 * - 项目目录都解析不出 → 真的没法处理；
 * - 只是这张卡没有分支（isolation=none 的旧卡）→ 仓库仍可解析，走 noop。
 */
export function resolveDiscardTarget(
  card: HarvestTaskFacts,
  registry: WorkspaceRegistryFace,
):
  | { readonly ok: true; readonly target: DiscardTarget }
  | { readonly ok: false; readonly reason: string } {
  const resolution = resolveHarvestTarget(card, registry);
  if (resolution.ok) {
    const target = resolution.target;
    return {
      ok: true,
      target: {
        repo: target.repo,
        branch: target.branch,
        worktreePath:
          target.worktreePath ??
          officialWorktreePath(target.repo, target.branch),
      },
    };
  }
  const workspace = registry.get(card.workspaceId);
  if (workspace === undefined || workspace.path === '') {
    return { ok: false, reason: resolution.reason };
  }
  const evidence = latestBranchEvidence(card);
  const branch = card.branch ?? evidence?.branch;
  const worktreePath =
    evidence?.worktreePath ??
    (branch !== undefined
      ? officialWorktreePath(workspace.path, branch)
      : undefined);
  return {
    ok: true,
    target: {
      repo: workspace.path,
      ...(branch !== undefined ? { branch } : {}),
      ...(worktreePath !== undefined ? { worktreePath } : {}),
    },
  };
}

/**
 * 删除前的只读现场采集：分支 tip + 检出脏文件清单。
 *
 * 用既有 git 封装（`GitRunner.capture` 的参数数组形式），不手写命令字符串；
 * 只读，不改任何 git 状态。
 */
export async function captureDiscardEvidence(
  git: GitRunner,
  target: DiscardTarget,
): Promise<DiscardEvidence> {
  const notes: string[] = [];
  let branchTip: string | undefined;
  if (target.branch !== undefined) {
    const tip = await git.capture(['rev-parse', target.branch], {
      cwd: target.repo,
    });
    if (tip.ok) {
      const hash = tip.stdout.trim();
      if (hash.length > 0) branchTip = hash;
      else notes.push(`分支 tip 为空(${target.branch})`);
    } else {
      notes.push(`分支 tip 读取失败(${target.branch})`);
    }
  }
  const dirtyFiles: string[] = [];
  if (target.worktreePath !== undefined) {
    if (await pathExists(target.worktreePath)) {
      const status = await git.capture(['status', '--porcelain'], {
        cwd: target.worktreePath,
      });
      if (status.ok) dirtyFiles.push(...parseStatusPaths(status.stdout));
      else
        notes.push(`检出状态读取失败(${target.worktreePath}),脏文件清单为空`);
    } else {
      notes.push(`检出已不存在(${target.worktreePath}),无脏文件清单`);
    }
  }
  return {
    ...(target.branch !== undefined ? { branch: target.branch } : {}),
    ...(branchTip !== undefined ? { branchTip } : {}),
    dirtyFiles,
    ...(target.worktreePath !== undefined
      ? { worktreePath: target.worktreePath }
      : {}),
    notes,
  };
}

/** 目标解析失败的留痕正文。 */
export function buildResolveFailureBody(
  card: Pick<HarvestCardFacts, 'id' | 'title'>,
  reason: string,
): string {
  return [
    '【验收联动】未能自动收割：目标解析失败',
    `- 任务：${card.title ?? card.id}`,
    `- 原因：${reason}`,
    '- 说明：未执行任何 git 动作（主区与检出均未被触碰）。',
  ].join('\n');
}

/** 收割成功的留痕正文（含 mergeCommit / diffStat / 结果 / 改动文件数 / 动作清单）。 */
export function buildMergedBody(result: HarvestResult): string {
  const lines: string[] = [
    '【验收联动】收割完成：任务分支已合并',
    `- 结果：${result.result}`,
    `- 任务分支：${result.branch}`,
    `- 目标分支：${result.targetBranch || '(未知)'}`,
    `- 合并提交：${result.mergeCommit ?? '(未生成合并提交)'}`,
    `- 差异摘要：${result.diffStat ?? '(无)'}`,
    `- 改动文件：${result.changedFiles.length} 个`,
  ];
  if (result.strategy !== undefined)
    lines.push(`- 采用策略：${result.strategy}`);
  if (result.degraded === true) lines.push('- 降级：本次收割发生了策略降级');
  lines.push(...formatList('执行动作', result.actions));
  lines.push(...formatList('备注', result.notes));
  return lines.join('\n');
}

/** 未完成收割（冲突 / 拒绝）的留痕正文。 */
export function buildUnmergedBody(result: HarvestResult): string {
  const lines: string[] = [
    '【验收联动】自动收割未完成：已转人工处理',
    `- 结果：${result.result}`,
    `- 任务分支：${result.branch}`,
    `- 目标分支：${result.targetBranch || '(未知)'}`,
    `- 原因：${result.reason ?? '(未给出原因)'}`,
  ];
  if (result.conflict !== undefined) {
    lines.push(
      `- 冲突类型：${result.conflict.kind}（${result.conflict.side}）`,
    );
    lines.push(`- 冲突现场：${result.conflict.worktreePath}`);
    lines.push(...formatList('冲突文件', result.conflict.files));
  }
  if (result.dirtyFiles !== undefined && result.dirtyFiles.length > 0) {
    lines.push(...formatList('主区脏文件', result.dirtyFiles));
  }
  lines.push(...formatList('备注', result.notes));
  return lines.join('\n');
}

/** 无事可做的留痕正文（noop）。 */
export function buildNoopBody(result: HarvestResult): string {
  return [
    '【验收联动】无需收割',
    `- 结果：${result.result}`,
    `- 任务分支：${result.branch}`,
    `- 原因：${result.reason ?? '(未给出原因)'}`,
    '- 说明：未执行任何 git 动作。',
  ].join('\n');
}

/** 收割失败的留痕正文。 */
export function buildFailedBody(result: HarvestResult): string {
  const lines: string[] = [
    '【验收联动】收割失败：已留痕，未自动重试',
    `- 结果：${result.result}`,
    `- 任务分支：${result.branch}`,
    `- 目标分支：${result.targetBranch || '(未知)'}`,
    `- 原因：${result.reason ?? '(未给出原因)'}`,
  ];
  lines.push(...formatList('执行动作', result.actions));
  lines.push(...formatList('备注', result.notes));
  return lines.join('\n');
}

/** 丢弃留痕正文（删除前现场：分支 tip + 脏文件清单）。 */
export function buildDiscardTraceBody(
  target: DiscardTarget,
  evidence: DiscardEvidence,
): string {
  const lines: string[] = [
    '【验收联动】丢弃留痕（删除前现场）',
    `- 分支：${target.branch ?? '(无分支,仅清检出)'}`,
    `- 分支 tip：${evidence.branchTip ?? '(未取到)'}`,
    `- 检出路径：${target.worktreePath ?? '(无)'}`,
    ...formatList('脏文件清单', evidence.dirtyFiles),
    '- 说明：以上为删除前现场；随后将强制删除检出（脏检出也删）与分支（-D）。',
  ];
  if (evidence.notes.length > 0) {
    lines.push(...formatList('采集备注', evidence.notes));
  }
  return lines.join('\n');
}

/** 丢弃结果留痕正文。 */
export function buildDiscardResultBody(result: DiscardResult): string {
  const lines: string[] = [
    '【验收联动】丢弃完成',
    `- 结果：${result.result}`,
    `- 分支已删除：${result.branchDeleted ? '是' : '否'}`,
    `- 检出已删除：${result.worktreeRemoved ? '是' : '否'}`,
  ];
  if (result.reason !== undefined) lines.push(`- 原因：${result.reason}`);
  lines.push(...formatList('执行动作', result.actions));
  lines.push(...formatList('备注', result.notes));
  return lines.join('\n');
}

/** 收割执行卡的描述（含稳定标记，防递归判定用）。 */
export function buildHarvestCardDescription(
  card: HarvestCardFacts,
  result: HarvestResult,
): string {
  const lines: string[] = [
    `${HARVEST_CARD_MARKER} 验收联动 watcher 自动收割未完成，转人工处理。`,
    '',
    `- 原任务：${card.title ?? card.id}（taskId=${card.id}）`,
    `- 仓库主区：${result.repo}`,
    `- 任务分支：${result.branch}`,
    `- 目标分支：${result.targetBranch || '(未知)'}`,
    `- 结果：${result.result}`,
    `- 原因：${result.reason ?? '(未给出原因)'}`,
  ];
  if (result.conflict !== undefined) {
    lines.push(
      `- 冲突类型：${result.conflict.kind}（${result.conflict.side}）`,
    );
    lines.push(`- 冲突现场：${result.conflict.worktreePath}`);
    lines.push(...formatList('冲突文件', result.conflict.files));
  }
  if (result.dirtyFiles !== undefined && result.dirtyFiles.length > 0) {
    lines.push(...formatList('主区脏文件', result.dirtyFiles));
  }
  lines.push(...formatList('备注', result.notes));
  lines.push(
    '',
    `标记：${HARVEST_CARD_MARKER}（watcher 据此识别收割卡，避免递归建卡）`,
  );
  return lines.join('\n');
}

/** 收割执行卡的提示词（内置冲突解决纪律）。 */
export function buildHarvestCardPrompt(
  card: HarvestCardFacts,
  result: HarvestResult,
): string {
  const repo = result.repo;
  const worktree = result.conflict?.worktreePath ?? result.worktreePath;
  return [
    '你接手一张「收割执行卡」：验收联动 watcher 检测到原任务验收通过，但自动收割无法安全完成，需要你接手把冲突/脏态处理到能合并。',
    '',
    '## 现场',
    `- 原任务：${card.title ?? card.id}（taskId=${card.id}）`,
    `- 仓库主区绝对路径：${repo}`,
    `- 任务分支：${result.branch}`,
    `- 目标分支：${result.targetBranch || '(未知)'}`,
    `- 检出路径：${worktree}`,
    `- 自动收割未完成的原因：${result.reason ?? '(未给出原因)'}`,
    '',
    '## 执行纪律（必须遵守）',
    `1. 所有 git 操作一律使用绝对路径：\`git -C "${repo}" ...\`。会话的工作目录与目标仓库可能不在同一处，不要依赖相对路径。`,
    `2. 冲突在任务检出内解决：检出 \`${worktree}\`；变基冲突走 \`git -C "${worktree}" rebase --continue\`，主区合并冲突走 \`git -C "${repo}" commit --no-edit\`。`,
    `3. 解决冲突并 \`git add\` 之后，调用工具 \`${HARVEST_TOOL_NAME}(mode=apply)\` 续跑收割（管线自带续跑状态机：检出内 rebase 进行中 → rebase --continue；主区 merge 进行中 → commit --no-edit）。`,
    '4. 不 push、不改写历史、不 force push。',
    '5. 主区脏时不要替人清理未提交改动：先判断这些改动能否安全丢弃，不确定就停下来说明。',
    '6. 收割成功后由管线删除检出与分支；本卡只负责把冲突/脏态处理到能合并的状态。',
    '',
    '## 完成标准',
    `- \`${HARVEST_TOOL_NAME}(mode=apply)\` 的结果为 merged；`,
    '- 在本卡描述里回链合并提交哈希与差异摘要。',
  ].join('\n');
}

/**
 * 构造验收联动 watcher。
 *
 * 板服务与项目注册表都在**轮询时**软读取（不在构造期解析）——插件注册期
 * 板服务可能还没就绪，注册期解析会让 watcher 直接报废。
 */
export function createHarvestWatcher(
  options: HarvestWatcherOptions,
): HarvestWatcher {
  const env = options.env ?? process.env;
  const log = options.log ?? ((message: string): void => console.log(message));
  const warn =
    options.warn ?? ((message: string): void => console.warn(message));
  const pipeline = options.pipeline ?? createHarvestPipeline();
  const runner = options.runner ?? createGitRunner();
  const intervalMs = resolveWatchIntervalMs(options.intervalMs, env);
  const enabled = resolveWatchEnabled(env);

  /** 定时器句柄（停表时清）。 */
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 运行态（stop 之后不再排下一轮）。 */
  let running = false;
  /** 是否已有一轮感知在飞（防重入）。 */
  let polling = false;
  /** 上次读到的台账修订号。 */
  let lastRevision: number | undefined;
  /** 是否已建立基线（首轮只建基线，不把历史 done 卡当进入事件）。 */
  let baselined = false;
  /** 上次快照的状态表（任务 id → 状态）。 */
  let statuses = new Map<string, string>();
  /** 已处理的事件键（`任务id:状态`），保证同卡重复事件不重复处理。 */
  const handled = new Set<string>();
  /**
   * 清掉某张卡的去重记录。
   * 卡离开 done/canceled 后，它下一次再进入 done/canceled 是一次**新**事件
   * （例：验收退回 todo 后再次验收），必须允许再次收割与留痕。
   */
  const forgetHandled = (taskId: string): void => {
    const prefix = `${taskId}:`;
    for (const key of handled) {
      if (key.startsWith(prefix)) handled.delete(key);
    }
  };
  /** 串行事件队列。 */
  let queue: Promise<void> = Promise.resolve();
  /** 板服务缺席只告警一次（不刷屏）。 */
  let boardMissingWarned = false;

  /** 软读取板服务（缺席时告警一次并返回 undefined）。 */
  const board = (): BoardServiceContract | undefined => {
    const service = resolveBoardService(options.context);
    if (service === undefined) {
      if (!boardMissingWarned) {
        boardMissingWarned = true;
        warn(
          `${LOG_PREFIX} 未找到 dsh-taskboard 板服务，验收联动 watcher 降级为不动作`,
        );
      }
      return undefined;
    }
    boardMissingWarned = false;
    return service;
  };

  /** 软读取项目注册表（缺席时退化为「解析不出任何项目」）。 */
  const registry = (): WorkspaceRegistryFace => {
    const service = options.context.get?.('workspaceRegistry');
    if (service === undefined || service === null) {
      return { get: () => undefined };
    }
    return service as WorkspaceRegistryFace;
  };

  /**
   * 卡片所属项目是否「不在本实例」：项目注册表缺席，或该 workspaceId 未注册。
   *
   * 这类卡片属于别的机器 / 别的项目（本实例根本没有它的目录），静默跳过即可：
   * 既无从收割，也不该往用户的看板上刷「未能收割」评论。
   */
  const isForeignWorkspace = (card: HarvestCardFacts): boolean => {
    const service = options.context.get?.('workspaceRegistry');
    if (service === undefined || service === null) return true;
    const workspace = (service as WorkspaceRegistryFace).get(card.workspaceId);
    return workspace === undefined || workspace.path === '';
  };

  /**
   * 目标解析失败时是否「静默跳过」（不写看板评论，只记日志）。
   *
   * - 项目不在本实例注册 → 别的机器 / 别的项目，与本实例无关（台账是多项目
   *   共享的，这类卡在用户看板上刷屏就是纯噪声）。
   *
   * 注意：项目已注册、只是「卡没有任务分支」时**不**静默——那是本实例该管
   * 的卡，留痕告诉用户「这张卡没被收割」才是设计要的纪律。
   */
  const shouldSkipSilently = (card: HarvestCardFacts): boolean =>
    isForeignWorkspace(card);

  /** 写留痕评论（降级：通道缺失 / 失败都不抛穿，只告警）。 */
  const comment = async (
    service: BoardServiceContract,
    taskId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<void> => {
    const writer = service.addTaskComment;
    if (writer === undefined || typeof writer !== 'function') {
      warn(
        `${LOG_PREFIX} 板服务缺少评论写通道(addTaskComment)，跳过留痕：${taskId}`,
      );
      return;
    }
    const input: BoardAddTaskCommentInput = {
      taskId,
      body,
      source: COMMENT_SOURCE,
      idempotencyKey,
    };
    try {
      const result = await writer.call(service, input);
      if (!result.ok) {
        warn(
          `${LOG_PREFIX} 留痕写入失败：${taskId}：${result.error?.message ?? '未知错误'}`,
        );
      }
    } catch (error) {
      warn(`${LOG_PREFIX} 留痕写入异常：${taskId}：${describeError(error)}`);
    }
  };

  /** 自动建收割执行卡（冲突 / 主区脏交人处理）。 */
  const createHarvestCard = async (
    service: BoardServiceContract,
    card: HarvestCardFacts,
    result: HarvestResult,
  ): Promise<string | undefined> => {
    const input: BoardCreateTaskInput = {
      title: `${HARVEST_CARD_TITLE_PREFIX}${card.title ?? card.id}`,
      workspaceId: card.workspaceId,
      urgency: 'normal',
      presetId: HARVEST_CARD_PRESET_ID,
      description: buildHarvestCardDescription(card, result),
      prompt: buildHarvestCardPrompt(card, result),
      // 机器门禁：目标卡交付前收割执行卡不应被认领。注意（dsh-taskboard 0.10.1
      // 起）该门禁只在依赖总开关开启时生效——上游缺省关闭，本仓 vendored 版缺省
      // 钉为开启（local-patches.json 第 16 条）；总开关被用户显式关闭期间这里传
      // 参会被静默丢弃，顺序兜底完全靠收割 prompt 里的「显式确认 done」纪律。
      blockedBy: [card.id],
      execution: { mode: 'claim' },
    };
    try {
      const created = await service.createTask(input);
      return created.id;
    } catch (error) {
      warn(
        `${LOG_PREFIX} 建收割执行卡失败：${card.id}：${describeError(error)}`,
      );
      return undefined;
    }
  };

  /** done → 收割。 */
  const handleDone = async (
    card: HarvestCardFacts,
    revision: number,
  ): Promise<void> => {
    const service = board();
    if (service === undefined) return;
    const key = `harvest-done:${card.id}:${revision}`;
    const resolution = resolveHarvestTarget(card, registry());
    if (!resolution.ok) {
      if (shouldSkipSilently(card)) {
        // 项目不在本实例注册 / 卡不是收割候选：静默跳过，不刷用户看板。
        log(
          `${LOG_PREFIX} 跳过收割（非收割候选）：${card.id}：${resolution.reason}`,
        );
        return;
      }
      await comment(
        service,
        card.id,
        buildResolveFailureBody(card, resolution.reason),
        key,
      );
      log(`${LOG_PREFIX} 收割目标解析失败：${card.id}：${resolution.reason}`);
      return;
    }
    const target = resolution.target;
    const request: HarvestRequest = {
      taskId: target.taskId,
      repo: target.repo,
      branch: target.branch,
      status: 'done',
      deleteBranch: true,
      keepWorktree: false,
      ...(target.baseCommit !== undefined
        ? { baseCommit: target.baseCommit }
        : {}),
    };
    let result: HarvestResult;
    try {
      result = await pipeline.apply(request);
    } catch (error) {
      await comment(
        service,
        card.id,
        [
          '【验收联动】收割异常：管线抛出未捕获错误',
          `- 任务：${card.title ?? card.id}`,
          `- 原因：${describeError(error)}`,
        ].join('\n'),
        key,
      );
      warn(`${LOG_PREFIX} 收割管线异常：${card.id}：${describeError(error)}`);
      return;
    }
    switch (result.result) {
      case 'merged': {
        await comment(service, card.id, buildMergedBody(result), key);
        log(
          `${LOG_PREFIX} 收割完成：${card.id}：${result.mergeCommit ?? '(未知提交)'}`,
        );
        break;
      }
      case 'conflict':
      case 'rejected': {
        await comment(service, card.id, buildUnmergedBody(result), key);
        if (!isActionableRejection(result)) {
          log(
            `${LOG_PREFIX} 收割无事可做：${card.id}：${result.reason ?? result.result}`,
          );
          break;
        }
        const createdId = await createHarvestCard(service, card, result);
        log(
          `${LOG_PREFIX} 已建收割执行卡：${card.id} → ${createdId ?? '(建卡失败)'}`,
        );
        break;
      }
      case 'noop': {
        await comment(service, card.id, buildNoopBody(result), key);
        log(`${LOG_PREFIX} 无需收割：${card.id}：${result.reason ?? ''}`);
        break;
      }
      case 'failed':
      case 'planned': {
        await comment(service, card.id, buildFailedBody(result), key);
        warn(
          `${LOG_PREFIX} 收割失败：${card.id}：${result.reason ?? '未知原因'}`,
        );
        break;
      }
    }
  };

  /** canceled → 丢弃（先留痕，再删除）。 */
  const handleCanceled = async (
    card: HarvestCardFacts,
    revision: number,
  ): Promise<void> => {
    const service = board();
    if (service === undefined) return;
    const traceKey = `harvest-canceled-trace:${card.id}:${revision}`;
    const resultKey = `harvest-canceled-result:${card.id}:${revision}`;
    const resolution = resolveDiscardTarget(card, registry());
    if (!resolution.ok) {
      if (shouldSkipSilently(card)) {
        // 项目不在本实例注册 / 卡不是收割候选：静默跳过，不刷用户看板。
        log(
          `${LOG_PREFIX} 跳过丢弃（非收割候选）：${card.id}：${resolution.reason}`,
        );
        return;
      }
      await comment(
        service,
        card.id,
        buildResolveFailureBody(card, resolution.reason),
        traceKey,
      );
      log(`${LOG_PREFIX} 丢弃目标解析失败：${card.id}：${resolution.reason}`);
      return;
    }
    const target = resolution.target;
    // ① 先留痕：只读采集删除前现场（分支 tip + 检出脏文件清单）。
    const evidence = await captureDiscardEvidence(runner, target);
    await comment(
      service,
      card.id,
      buildDiscardTraceBody(target, evidence),
      traceKey,
    );
    // ② 再删除：删检出（脏也删）+ 删分支 -D。
    const request: DiscardRequest = {
      taskId: card.id,
      repo: target.repo,
      ...(target.branch !== undefined ? { branch: target.branch } : {}),
      ...(target.worktreePath !== undefined
        ? { worktreePath: target.worktreePath }
        : {}),
    };
    let result: DiscardResult;
    try {
      result = await pipeline.discard(request);
    } catch (error) {
      warn(`${LOG_PREFIX} 丢弃管线异常：${card.id}：${describeError(error)}`);
      await comment(
        service,
        card.id,
        [
          '【验收联动】丢弃异常：管线抛出未捕获错误',
          `- 任务：${card.title ?? card.id}`,
          `- 原因：${describeError(error)}`,
        ].join('\n'),
        resultKey,
      );
      return;
    }
    // ③ 结果留痕。
    await comment(service, card.id, buildDiscardResultBody(result), resultKey);
    log(`${LOG_PREFIX} 已丢弃：${card.id}：${result.result}`);
  };

  /** 处理一个状态进入事件。 */
  const handleEvent = async (event: StatusEntryEvent): Promise<void> => {
    const key = `${event.task.id}:${event.status}`;
    if (handled.has(key)) return;
    handled.add(key);
    const card: HarvestCardFacts = event.task;
    log(
      `${LOG_PREFIX} 检测到任务进入 ${event.status}：${card.id}（${card.title ?? ''}）`,
    );
    // 防递归红线：收割执行卡自己完成时同样产生 done 事件，绝不再建收割卡。
    if (isHarvestExecutionCard(card)) {
      log(`${LOG_PREFIX} 跳过收割执行卡（防递归）：${card.id}`);
      return;
    }
    if (event.status === 'done') {
      await handleDone(card, event.revision);
      return;
    }
    await handleCanceled(card, event.revision);
  };

  /** 事件入队（串行：同一张卡绝不并发跑 git）。 */
  const enqueue = (event: StatusEntryEvent): void => {
    queue = queue
      .then(() => handleEvent(event))
      .catch((error: unknown) => {
        warn(`${LOG_PREFIX} 处理状态进入事件异常：${describeError(error)}`);
      });
  };

  /** 感知一轮：读台账 → 比对状态 → 入队「进入」事件。 */
  const detect = (): void => {
    const service = board();
    if (service === undefined) return;
    let ledger: BoardLedger;
    try {
      ledger = service.snapshot();
    } catch (error) {
      warn(`${LOG_PREFIX} 读取板服务快照失败：${describeError(error)}`);
      return;
    }
    const revision = ledger.revision;
    // revision 没变 → 台账没动 → 无事可做（纯内存读，不打日志）。
    if (baselined && revision !== undefined && revision === lastRevision)
      return;
    const current = new Map<string, string>();
    for (const task of ledger.tasks) current.set(task.id, task.status);
    if (!baselined) {
      // 首轮只建基线：历史遗留的 done 卡不是「进入 done」，不得触发收割。
      baselined = true;
      lastRevision = revision;
      statuses = current;
      return;
    }
    const events: StatusEntryEvent[] = [];
    for (const task of ledger.tasks) {
      // 只认「已知状态 → 变 done/canceled」的跃迁。
      // 首次见到的卡（台账刚加载完、快照瞬时不完整、历史存量卡）只登记状态，
      // 不得当成跃迁——否则重启一次就会把全台账的历史 done 卡当成「刚验收完」，
      // 逐张去收割并往用户看板上刷评论。
      if (!statuses.has(task.id)) continue;
      const previous = statuses.get(task.id);
      if (previous === task.status) continue;
      if (task.status !== 'done' && task.status !== 'canceled') {
        // 卡离开了 done/canceled（例如验收退回 todo 后再次验收）：
        // 必须清掉它的去重记录，否则第二轮跃迁会被永久丢弃、永不收割。
        forgetHandled(task.id);
        continue;
      }
      events.push({
        task: toCardFacts(task),
        status: task.status,
        revision: revision ?? lastRevision ?? 0,
      });
    }
    // 增量登记：快照瞬时不完整（台账加载中 / 分片）不得抹掉已知状态，
    // 否则下一轮会把存量卡当成新卡跃迁。
    for (const [id, status] of current) statuses.set(id, status);
    lastRevision = revision;
    for (const event of events) enqueue(event);
  };

  /** 手动跑一轮感知（等本轮入队的事件处理完才 resolve）。 */
  const poll = async (): Promise<void> => {
    // 开关关闭时连手动感知也不做——否则「关掉自动收割」就名存实亡。
    if (!enabled) return;
    if (polling) return;
    polling = true;
    try {
      detect();
    } catch (error) {
      warn(`${LOG_PREFIX} 感知轮询异常：${describeError(error)}`);
    } finally {
      polling = false;
    }
    await queue;
  };

  /** 启动轮询（幂等）。 */
  const start = (): void => {
    if (!enabled) {
      log(
        `${LOG_PREFIX} watcher 已按环境变量 ${WATCH_ENABLE_ENV} 关闭，不启动自动收割`,
      );
      return;
    }
    if (running) return;
    running = true;
    const loop = async (): Promise<void> => {
      if (!running) return;
      await poll();
      if (!running) return;
      timer = scheduleTimer(() => {
        void loop();
      }, intervalMs);
    };
    timer = scheduleTimer(() => {
      void loop();
    }, intervalMs);
  };

  /** 停止轮询（停表、清定时器；不打断已在处理的事件）。 */
  const stop = (): void => {
    running = false;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return { start, stop, poll };
}
