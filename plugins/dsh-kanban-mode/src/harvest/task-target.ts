/**
 * 收割目标解析：任务卡 → 仓库主区路径 / 任务分支 / 检出路径 / 基线提交。
 *
 * 单一真源：`src/tools/harvest.ts`（工具直呼）与 `src/harvest/watcher.ts`
 * （验收联动自动收割）共用同一份解析口径——两边各写一份必然漂移，而漂移的
 * 后果是「工具合到 A 分支、watcher 合到 B 分支」。
 *
 * 数据来源（全部软读取，零跨包 import）：
 * - 板服务任务记录：`workspaceId` / `branch` / `executions[].{branch,worktreePath,baseCommit}`；
 * - 宿主 `workspaceRegistry` 服务：`workspaceId` → 项目目录绝对路径。
 *
 * @module dsh-kanban-mode/harvest/task-target
 */

import type {
  BoardExecutionEvidence,
  BoardTaskRecord,
} from '../tools/board-contract.ts';

/** 宿主 workspaceRegistry 服务的本地窄接口（照 dsh-taskboard 宿主用法）。 */
export interface WorkspaceRegistryFace {
  /** 按项目 id 取项目；不存在返回 undefined。项目对象带绝对路径 `path`。 */
  get(
    id: string,
  ):
    | { readonly id: string; readonly path: string; readonly title?: string }
    | undefined;
}

/** 收割解析用到的任务事实面（BoardTaskRecord 的子集）。 */
export interface HarvestTaskFacts {
  readonly id: string;
  readonly title?: string;
  readonly workspaceId: string;
  readonly status: string;
  readonly branch?: string;
  readonly isolation?: string;
  readonly executions?: readonly BoardExecutionEvidence[];
  readonly prompt?: string;
  readonly description?: string;
  readonly presetId?: string;
}

/** 解析出的收割目标。 */
export interface HarvestTarget {
  /** 任务 id。 */
  readonly taskId: string;
  /** 所属项目 id。 */
  readonly workspaceId: string;
  /** 主仓绝对路径（git 操作的工作目录）。 */
  readonly repo: string;
  /** 任务分支名。 */
  readonly branch: string;
  /** 已知检出路径（执行记录里的官方池路径；缺省由管线自行定位）。 */
  readonly worktreePath?: string;
  /** 基线提交（用于 base 前进检测）。 */
  readonly baseCommit?: string;
  /** 任务当前状态（管线据此拒绝非 done 的收割）。 */
  readonly status: string;
}

/** 解析结果（成功给目标，失败给可操作原因）。 */
export type TargetResolution =
  | { readonly ok: true; readonly target: HarvestTarget }
  | { readonly ok: false; readonly reason: string };

/** 收割执行卡的标题前缀（识别收割卡，防 watcher 递归建卡）。 */
export const HARVEST_CARD_TITLE_PREFIX = '收割执行：';

/** 收割执行卡的稳定标记（写进卡片描述，识别收割卡，防递归）。 */
export const HARVEST_CARD_MARKER = '[taskboard_harvest]';

/**
 * 取最后一条带分支信息的执行记录。
 *
 * 台账只保留有限条执行记录（上游 MAX_EXECUTIONS 裁剪），且最新一条可能是
 * 「降级到原目录执行」的记录（isolation=none，无分支）——所以从后往前找
 * 第一条带 branch 的记录。
 */
export function latestBranchEvidence(
  task: HarvestTaskFacts,
): BoardExecutionEvidence | undefined {
  const executions = task.executions ?? [];
  for (let i = executions.length - 1; i >= 0; i -= 1) {
    const record = executions[i];
    if (
      record !== undefined &&
      record.branch !== undefined &&
      record.branch !== ''
    ) {
      return record;
    }
  }
  return undefined;
}

/** 取最后一次执行记录（不论是否带分支）。 */
export function latestExecution(
  task: HarvestTaskFacts,
): BoardExecutionEvidence | undefined {
  const executions = task.executions ?? [];
  return executions.length > 0 ? executions[executions.length - 1] : undefined;
}

/**
 * 解析收割目标。
 *
 * 失败情形只有两类，都给可操作原因：
 * - 项目目录解析不出（项目 id 不在 workspaceRegistry 里）；
 * - 任务没有分支（isolation=none 的旧卡，或尚未产生执行记录）。
 */
export function resolveHarvestTarget(
  task: HarvestTaskFacts,
  registry: WorkspaceRegistryFace,
): TargetResolution {
  const workspace = registry.get(task.workspaceId);
  if (workspace === undefined || workspace.path === '') {
    return {
      ok: false,
      reason: `无法解析项目目录（workspaceId=${task.workspaceId}）`,
    };
  }
  const evidence = latestBranchEvidence(task);
  const branch = task.branch ?? evidence?.branch;
  if (branch === undefined || branch === '') {
    return {
      ok: false,
      reason: `该卡没有任务分支（isolation=${task.isolation ?? 'unknown'}），无可收割的分支`,
    };
  }
  const baseCommit = evidence?.baseCommit;
  const worktreePath = evidence?.worktreePath;
  return {
    ok: true,
    target: {
      taskId: task.id,
      workspaceId: task.workspaceId,
      repo: workspace.path,
      branch,
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(baseCommit !== undefined ? { baseCommit } : {}),
      status: task.status,
    },
  };
}

/**
 * 判断一张卡是不是「收割执行卡」（watcher 自己建的冲突交接卡）。
 *
 * 收割卡完成时同样会产生 done 事件——不显式排除就会无限递归建卡。
 * 判定口径双保险：标题前缀 + 描述/提示词里的稳定标记。
 */
export function isHarvestExecutionCard(
  task: Pick<HarvestTaskFacts, 'title' | 'description' | 'prompt'>,
): boolean {
  const title = task.title ?? '';
  if (title.startsWith(HARVEST_CARD_TITLE_PREFIX)) return true;
  const text = `${task.description ?? ''}\n${task.prompt ?? ''}`;
  return text.includes(HARVEST_CARD_MARKER);
}

/** 收割目标解析的输入类型（板服务任务记录直接可用）。 */
export type HarvestTaskInput = HarvestTaskFacts &
  Partial<Pick<BoardTaskRecord, 'blockedBy'>>;
