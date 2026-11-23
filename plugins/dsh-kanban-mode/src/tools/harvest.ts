/**
 * 工具 taskboard_harvest：把一张已 done 的看板卡的 worktree 分支「收割」回
 * 目标分支（plan 只读规划 / apply 执行收割）。
 *
 * 为什么工具只做编排、不做 git 动作：收割的全部 git 语义（变基、合并、冲突
 * 现场保留、检出清理、分支安全删除）都实现在 src/harvest/pipeline.ts 里。本
 * 工具只负责「取卡 → 解析目标 → 交给管线 → 渲染结果」，避免同一套 git 语义
 * 在两处各写一份而漂移（设计依据 docs/harvest-design.md §6/§7/§8）。
 *
 * 前置条件（写进工具描述，让模型自己判断能不能调）：
 * - 该卡已 done——非 done 的卡由管线直接 rejected（状态语义在管线里，工具
 *   不重复实现一套）；
 * - 该卡在 worktree 分支上有提交——isolation=none 的旧卡没有分支可收割，
 *   由 resolveHarvestTarget 给出可操作原因。
 *
 * 服务依赖（全部软读取，缺失时给可操作错误，**不改预设依赖**）：
 * - dsh-taskboard 板服务：取卡（见 board-contract.ts）；
 * - 宿主 workspaceRegistry 服务：把 workspaceId 解析成项目目录（见
 *   harvest/task-target.ts 的共享解析口径，watcher 与本工具同源）。
 *
 * @module dsh-kanban-mode/tools/harvest
 */

import {
  requireBoardService,
  TOOL_ERR,
  type BoardServiceConsumerContext,
} from './board-contract.ts';
import { defineTool } from './define-tool.ts';
import { createHarvestPipeline } from '../harvest/pipeline.ts';
import type {
  HarvestConflict,
  HarvestMode,
  HarvestPipeline,
  HarvestRequest,
  HarvestResult,
  HarvestResultKind,
  HarvestStrategy,
} from '../harvest/pipeline.ts';
import { resolveHarvestTarget } from '../harvest/task-target.ts';
import type { WorkspaceRegistryFace } from '../harvest/task-target.ts';
import type { CommitEntry } from '../harvest/inspect.ts';

/** 工具名（与宿主根层 taskboard_* 工具同族，故不用 kanban_* 前缀）。 */
export const HARVEST_TOOL_NAME = 'taskboard_harvest';

/** 宿主工作区注册表服务名（ctx.get 软读取面）。 */
export const WORKSPACE_REGISTRY_SERVICE_NAME = 'workspaceRegistry';

/** 工作区注册表缺失/形状不符时的错误码（与 board-contract 的 TOOL_ERR 同形）。 */
export const ERR_WORKSPACE_REGISTRY = 'workspace_registry_unavailable';

/** 工作区注册表缺失时的可操作文案。 */
export const WORKSPACE_REGISTRY_UNAVAILABLE_MESSAGE =
  'workspaceRegistry 服务不可用：无法解析项目目录';

/** 工具描述（注册进宿主 tools 目录）。 */
export const HARVEST_TOOL_DESCRIPTION =
  '收割看板卡的任务分支：把该卡 worktree 分支上的成果合并回目标分支，并按需清理检出与任务分支。mode=plan 是只读规划（给出待收割提交、改动文件与冲突预检，不改动任何 git 状态），mode=apply 才真正执行收割。前置条件：该卡已 done，且在 worktree 分支上有提交（非 done 的卡会被管线直接拒绝）。需要 dsh-taskboard 插件提供的板服务与宿主 workspaceRegistry 服务。遇到冲突时返回 conflict.files 与处理建议，在同一检出内解决后再次调用 mode=apply 即可续跑。';

/** 入参形状（与 docs/harvest-design.md §5 参数表一致）。 */
export interface HarvestArgs {
  /** 要收割的看板卡 id（必填）。 */
  readonly taskId: string;
  /** 模式：plan=只读规划（缺省），apply=执行收割。 */
  readonly mode?: HarvestMode;
  /** 目标分支；缺省 = 收割时主区当前分支。 */
  readonly targetBranch?: string;
  /** 收割后是否删除任务分支（缺省 true → `git branch -d` 安全删除）。 */
  readonly deleteBranch?: boolean;
  /** 收割后是否保留检出（缺省 false → 收割后删除检出）。 */
  readonly keepWorktree?: boolean;
}

/** 工具返回值（结构化；字段与 docs/harvest-design.md §5 输出契约一致）。 */
export interface HarvestValue {
  /** 任务卡 id。 */
  readonly taskId: string;
  /** 主仓绝对路径。 */
  readonly repo: string;
  /** 任务分支名。 */
  readonly branch: string;
  /** 检出路径（worktree 主区）。 */
  readonly worktreePath: string;
  /** 目标分支（实际收割到的分支）。 */
  readonly targetBranch: string;
  /** 任务基线提交（用于 base 前进检测）。 */
  readonly baseCommit?: string;
  /** base 前进检测结论（null = 未检查）。 */
  readonly baseAdvanced: boolean | null;
  /** 任务分支领先目标分支的提交。 */
  readonly commits: readonly CommitEntry[];
  /** 差异摘要。 */
  readonly diffStat?: string;
  /** 改动文件清单。 */
  readonly changedFiles: readonly string[];
  /** 冲突现场（冲突时必含 files 清单）。 */
  readonly conflict?: HarvestConflict;
  /** 实际执行的动作清单（审计用）。 */
  readonly actions: readonly string[];
  /** 过程备注。 */
  readonly notes: readonly string[];
  /** 结果分支。 */
  readonly result: HarvestResultKind;
  /** 合并提交（仅 merged 且生成合并提交时）。 */
  readonly mergeCommit?: string;
  /** 拒绝/失败原因。 */
  readonly reason?: string;
  /** 实际采用的策略。 */
  readonly strategy?: HarvestStrategy;
  /** 是否发生降级。 */
  readonly degraded?: boolean;
  /** 主区脏文件清单（脏主区拒绝场景）。 */
  readonly dirtyFiles?: readonly string[];
}

/**
 * 管线工厂（生产缺省新建真实收割管线；单测注入假管线断言请求形状）。
 *
 * 为什么留这个缝：管线里有仓库级串行互斥与冲突续跑状态，单例共享会让两个
 * execute 互相串味；每次 execute 新建一条管线则天然隔离。
 */
export type HarvestPipelineFactory = () => HarvestPipeline;

/** 工具构造可选项。 */
export interface HarvestToolOptions {
  /** 管线工厂；缺省每次 execute 新建真实管线。 */
  readonly createPipeline?: HarvestPipelineFactory;
}

/**
 * 软读取宿主工作区注册表。
 *
 * 缺失（或形状不是 {get(id)}）时抛可操作错误：项目目录解析不出时后续每一步
 * 都会失败，不如在这里一次说清缺哪个服务。
 */
function requireWorkspaceRegistry(
  ctx: BoardServiceConsumerContext,
): WorkspaceRegistryFace {
  const service = ctx.get?.(WORKSPACE_REGISTRY_SERVICE_NAME);
  if (service === undefined || service === null) {
    throw new Error(
      `Error: ${ERR_WORKSPACE_REGISTRY}: ${WORKSPACE_REGISTRY_UNAVAILABLE_MESSAGE}`,
    );
  }
  const getter = (service as { get?: unknown }).get;
  if (typeof getter !== 'function') {
    throw new Error(
      `Error: ${ERR_WORKSPACE_REGISTRY}: ${WORKSPACE_REGISTRY_UNAVAILABLE_MESSAGE}`,
    );
  }
  return service as WorkspaceRegistryFace;
}

/** 把管线结果映射成工具输出（可选字段缺省不出现在 JSON 里）。 */
function toHarvestValue(result: HarvestResult): HarvestValue {
  return {
    taskId: result.taskId,
    repo: result.repo,
    branch: result.branch,
    worktreePath: result.worktreePath,
    targetBranch: result.targetBranch,
    ...(result.baseCommit !== undefined
      ? { baseCommit: result.baseCommit }
      : {}),
    baseAdvanced: result.baseAdvanced,
    commits: result.commits,
    ...(result.diffStat !== undefined ? { diffStat: result.diffStat } : {}),
    changedFiles: result.changedFiles,
    ...(result.conflict !== undefined ? { conflict: result.conflict } : {}),
    actions: result.actions,
    notes: result.notes,
    result: result.result,
    ...(result.mergeCommit !== undefined
      ? { mergeCommit: result.mergeCommit }
      : {}),
    ...(result.reason !== undefined ? { reason: result.reason } : {}),
    ...(result.strategy !== undefined ? { strategy: result.strategy } : {}),
    ...(result.degraded !== undefined ? { degraded: result.degraded } : {}),
    ...(result.dirtyFiles !== undefined
      ? { dirtyFiles: result.dirtyFiles }
      : {}),
  };
}

/** 结果一句话摘要（render 首行）。 */
function resultHeadline(value: HarvestValue): string {
  switch (value.result) {
    case 'merged':
      return `收割完成：${value.branch} 的成果已合并到 ${value.targetBranch}`;
    case 'conflict':
      return '收割遇到冲突并保留现场：解决冲突后在同一检出内再次调用 taskboard_harvest(mode=apply) 续跑';
    case 'rejected':
      return `收割被拒绝：${value.reason ?? '（管线未给出原因）'}`;
    case 'noop':
      return `无可收割内容：${value.branch} 没有领先 ${value.targetBranch} 的提交`;
    case 'failed':
      return `收割失败：${value.reason ?? '（管线未给出原因）'}`;
    case 'planned':
      return `规划完成（未改动任何 git 状态）：${value.commits.length} 个待收割提交${value.conflict === undefined ? '' : `，预检冲突文件 ${value.conflict.files.length} 个`}`;
  }
}

/** base 前进检测结论文案。 */
function baseAdvancedText(baseAdvanced: boolean | null): string {
  if (baseAdvanced === null) return '未检查';
  return baseAdvanced
    ? '未前进（基线提交仍是目标分支祖先）'
    : '已前进（基线提交已不在目标分支线上，需要变基）';
}

/** render：把收割结果渲染成模型可读文本（模型唯一可见输出）。 */
function renderHarvest(args: HarvestArgs, value: HarvestValue): string[] {
  const lines: string[] = [];
  lines.push(resultHeadline(value));
  lines.push(
    `- 模式：${args.mode === 'apply' ? 'apply（执行收割）' : 'plan（只读规划）'}`,
  );
  lines.push(`- 任务卡：${value.taskId}`);
  lines.push(`- 仓库：${value.repo}`);
  lines.push(`- 检出：${value.worktreePath}`);
  lines.push(`- 分支：${value.branch} → ${value.targetBranch}`);
  if (value.baseCommit !== undefined) {
    lines.push(`- 基线提交：${value.baseCommit}`);
  }
  lines.push(`- base 前进检测：${baseAdvancedText(value.baseAdvanced)}`);
  lines.push(`- 提交（${value.commits.length}）：`);
  if (value.commits.length === 0) {
    lines.push('  - 无');
  } else {
    for (const commit of value.commits) {
      lines.push(`  - ${commit.hash} ${commit.subject}`);
    }
  }
  if (value.diffStat !== undefined) {
    lines.push(`- 差异摘要：${value.diffStat}`);
  }
  lines.push(`- 改动文件（${value.changedFiles.length}）：`);
  if (value.changedFiles.length === 0) {
    lines.push('  - 无');
  } else {
    for (const file of value.changedFiles) {
      lines.push(`  - ${file}`);
    }
  }
  if (value.conflict !== undefined) {
    lines.push(
      `- 冲突：${value.conflict.kind}（现场 ${value.conflict.side}，路径 ${value.conflict.worktreePath}）`,
    );
    lines.push(`  - 冲突文件（${value.conflict.files.length}）：`);
    if (value.conflict.files.length === 0) {
      lines.push('    - 无');
    } else {
      for (const file of value.conflict.files) {
        lines.push(`    - ${file}`);
      }
    }
    if (value.conflict.suggestions.length > 0) {
      lines.push('  - 处理建议：');
      for (const suggestion of value.conflict.suggestions) {
        lines.push(`    - ${suggestion}`);
      }
    }
    if (value.conflict.resumeCommand.length > 0) {
      lines.push(`  - 续跑命令：${value.conflict.resumeCommand.join(' ')}`);
    }
  }
  if (value.dirtyFiles !== undefined && value.dirtyFiles.length > 0) {
    lines.push(`- 主区脏文件（${value.dirtyFiles.length}）：`);
    for (const file of value.dirtyFiles) {
      lines.push(`  - ${file}`);
    }
  }
  if (value.mergeCommit !== undefined) {
    lines.push(`- 合并提交：${value.mergeCommit}`);
  }
  if (value.strategy !== undefined) {
    lines.push(`- 策略：${value.strategy}`);
  }
  if (value.degraded === true) {
    lines.push('- 降级：是');
  }
  lines.push(`- 动作（${value.actions.length}）：`);
  if (value.actions.length === 0) {
    lines.push('  - 无');
  } else {
    for (const action of value.actions) {
      lines.push(`  - ${action}`);
    }
  }
  lines.push(`- 备注（${value.notes.length}）：`);
  if (value.notes.length === 0) {
    lines.push('  - 无');
  } else {
    for (const note of value.notes) {
      lines.push(`  - ${note}`);
    }
  }
  return lines;
}

/**
 * 构造 taskboard_harvest 工具定义（execute 时惰性软读取板服务与工作区注册表）。
 *
 * @param ctx - 插件上下文（ctx.get 软读取面）。
 * @param options - 可选项（管线工厂；缺省每次 execute 新建真实管线）。
 */
export function buildHarvestTool(
  ctx: BoardServiceConsumerContext,
  options: HarvestToolOptions = {},
): ReturnType<typeof defineTool<HarvestArgs, HarvestValue>> {
  const createPipeline: HarvestPipelineFactory =
    options.createPipeline ?? (() => createHarvestPipeline());
  return defineTool<HarvestArgs, HarvestValue>({
    name: HARVEST_TOOL_NAME,
    description: HARVEST_TOOL_DESCRIPTION,
    parameters: {
      taskId: {
        type: 'string',
        description: '要收割的看板卡 id（必填）',
        required: true,
      },
      mode: {
        type: 'string',
        description:
          'plan=只读规划（缺省，不改动任何 git 状态）；apply=执行收割（变基/合并/清理）',
        enum: ['plan', 'apply'],
      },
      targetBranch: {
        type: 'string',
        description: '目标分支；缺省 = 收割时主区当前分支',
      },
      deleteBranch: {
        type: 'boolean',
        description:
          '收割后是否删除任务分支（缺省 true → `git branch -d` 安全删除，非强制）',
      },
      keepWorktree: {
        type: 'boolean',
        description: '收割后是否保留检出（缺省 false → 收割后删除检出）',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (args, value) => [
        { type: 'text', text: renderHarvest(args, value).join('\n') },
      ],
    },
    async execute(args) {
      const board = requireBoardService(ctx);
      const registry = requireWorkspaceRegistry(ctx);
      const task = board.getTask(args.taskId);
      if (task === undefined) {
        throw new Error(`Error: ${TOOL_ERR.notFound}: no task ${args.taskId}`);
      }
      const resolution = resolveHarvestTarget(task, registry);
      if (!resolution.ok) {
        throw new Error(
          `Error: ${TOOL_ERR.invalidInput}: ${resolution.reason}`,
        );
      }
      const target = resolution.target;
      const mode: HarvestMode = args.mode ?? 'plan';
      const request: HarvestRequest = {
        taskId: target.taskId,
        repo: target.repo,
        branch: target.branch,
        ...(args.targetBranch !== undefined
          ? { targetBranch: args.targetBranch }
          : {}),
        mode,
        deleteBranch: args.deleteBranch ?? true,
        keepWorktree: args.keepWorktree ?? false,
        ...(target.baseCommit !== undefined
          ? { baseCommit: target.baseCommit }
          : {}),
        status: target.status,
      };
      const pipeline = createPipeline();
      const result =
        mode === 'apply'
          ? await pipeline.apply(request)
          : await pipeline.plan(request);
      return toHarvestValue(result);
    },
  });
}
