/**
 * 会话任务清单（官方 todo 投影）与卡片验收清单的同步内核（看板增强系列 3/6）。
 *
 * 两侧口径（与看板模式系列的清单纪律一致）：
 * - 会话任务清单：官方 `todo_write` 工具维护的 todo 投影，每项 pending → in_progress → completed。
 * - 卡片验收清单：看板卡的 DoD 条目，由 `taskboard_checklist` 维护，勾选必须带证据 note。
 *
 * 本模块提供纯函数与注册助手，host 层负责真正的 append / 台账写入：
 * 1. 初始化注入：执行会话首个 `agent/pre-step` 内，由宿主把卡片验收清单映射为初始
 *    todos（已勾选 → completed，其余 → pending）并 `session.append('todo/write', …)`。
 *    注入点选 pre-step 是确定性的：todo 投影在 turn/start 清空，而 pre-step 位于
 *    Session.append 发布之外（官方 dsh-plan-mode 同款先例），append 安全且必然生效。
 * 2. 单向回写：宿主监听会话 `todo/write` 事件，把标记 completed 的项幂等勾选到卡片清单——
 *    先按文本精确匹配，再对未匹配项做字符 bigram 近似匹配（agent 常把 DoD 原文改写后
 *    再写回 todo，纯精确匹配会漏掉这种常见情形）；只推进、绝不取消勾选，冲突以卡片验收清单为准。
 *
 * 官方事件面的形状（事件名、载荷字段）一律软读取/结构断言，绝不运行时 import 官方包。
 * 本地新增文件住在 `src/local/`——该目录不在 vendored 逐字一致性的统计口径内
 * （见 src/local/package-contract.test.ts 的 collectVendoredSources）。
 */

import type { ChecklistItem } from '../shared/protocol.ts';

/** 官方 todo 条目的精确形状（与 dsh-tool-todo 的投影一致）。 */
export type OfficialTodo = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
};

/** 会话 todo 事件的原始载荷形状。 */
export type TodoEventData = { todos?: unknown };

/** pre-step 载荷里本插件真正用到的那一小块 agent 面（永不 import 官方包）。 */
export type PreStepAgentFace = {
  /** 会话 id（官方 ReactLoopAgent 的 `id: SessionId`）。 */
  id?: unknown;
  /** 官方 Session 的最小面：只需要 append 一个日志事件。 */
  session?: { append(type: string, data: unknown): void };
};

/** 单次 todo 事件的条目上限（防御异常载荷；官方清单上限同量级）。 */
const MAX_TODO_ITEMS = 100;

/** 宿主自动回写时附在勾选项上的证据 note（≤400 字，与 taskboard_checklist 同字段）。 */
export const TODO_WRITE_BACK_NOTE =
  '会话任务清单标记完成（todo_write 自动回写）';

/**
 * 解析会话 `todo/write` 事件载荷。
 * @param data - 事件数据（`{ todos: [...] }`）。
 * @returns 合法的 todos；形状不符时返回 undefined（不是本插件该管的事件）。
 */
export function todosFromEventData(data: unknown): OfficialTodo[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const raw = (data as TodoEventData).todos;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TODO_ITEMS)
    return undefined;
  const todos: OfficialTodo[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const content = (entry as { content?: unknown }).content;
    const status = (entry as { status?: unknown }).status;
    if (typeof content !== 'string' || content.trim().length === 0)
      return undefined;
    if (
      status !== 'pending' &&
      status !== 'in_progress' &&
      status !== 'completed'
    )
      return undefined;
    todos.push({ content, status });
  }
  return todos;
}

/**
 * 把卡片验收清单映射为初始会话 todos。
 * @param items - 卡片验收清单条目。
 * @returns 初始 todos：已勾选 → completed，其余 → pending。
 */
export function todosFromChecklist(
  items: readonly ChecklistItem[],
): OfficialTodo[] {
  return items.map((item) => ({
    content: item.text,
    status: item.checked ? ('completed' as const) : ('pending' as const),
  }));
}

/**
 * 归一化待比较文本：折叠空白、去掉常见语气前缀（已/曾）与句末标点、统一大小写。
 *
 * 注意：否定词「未」**不**剥离——「未完成 X」归一后仍以「未」开头，
 * 不会与卡片条目「完成 X」近似勾上（agent 回写否定句时宁可匹配失败）。
 *
 * @param text - 原始文本。
 * @returns 归一化后的文本。
 */
export function normalizeTodoText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^[已曾]+/, '')
    .replace(/[了的地。！!？?；;，,、:：]+$/u, '')
    .trim()
    .toLowerCase();
}

/**
 * 文本相似度（字符 bigram 的 Dice 系数）。
 *
 * 中文没有空格分词，按字符 bigram 比较比 token 化更稳；完全一致返回 1。
 *
 * @param a - 文本 A。
 * @param b - 文本 B。
 * @returns 0..1 的相似度。
 */
export function todoTextSimilarity(a: string, b: string): number {
  const na = normalizeTodoText(a);
  const nb = normalizeTodoText(b);
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  const grams = (text: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    if (text.length === 1) set.add(text);
    return set;
  };
  const ga = grams(na);
  const gb = grams(nb);
  let intersection = 0;
  for (const gram of ga) {
    if (gb.has(gram)) intersection += 1;
  }
  return (2 * intersection) / (ga.size + gb.size);
}

/** 近似匹配阈值：低于此相似度不认为是同一条目。 */
const FUZZY_MATCH_THRESHOLD = 0.6;
/** 近似匹配的最优/次优差距下限：差距太小说明存在歧义，宁可不匹配。 */
const FUZZY_MATCH_MARGIN = 0.1;

/**
 * 把会话清单里标记 completed 的条目匹配到卡片验收清单条目。
 *
 * 两轮匹配，一对一（一条 todo 最多对应一个 DoD 条目）：
 * 1. 精确匹配：trim 后全等（宿主注入的原文不改写时命中）。
 * 2. 近似匹配：字符 bigram Dice 系数 ≥ {@link FUZZY_MATCH_THRESHOLD}，
 *    且与次优候选的差距 ≥ {@link FUZZY_MATCH_MARGIN}（歧义则不匹配）。
 *
 * @param todos - 会话 todos。
 * @param items - 卡片验收清单条目。
 * @returns 可勾选的 DoD 条目 id 集合（只含未勾选且被匹配上的条目）。
 */
export function matchCompletedTodos(
  todos: readonly OfficialTodo[],
  items: readonly ChecklistItem[],
): Set<string> {
  const completed = todos.filter((todo) => todo.status === 'completed');
  const matched = new Set<string>();
  const usedTodos = new Set<number>();

  for (const item of items) {
    if (item.checked) continue;
    const index = completed.findIndex(
      (todo, i) =>
        !usedTodos.has(i) && todo.content.trim() === item.text.trim(),
    );
    if (index >= 0) {
      usedTodos.add(index);
      matched.add(item.id);
    }
  }

  for (const item of items) {
    if (item.checked || matched.has(item.id)) continue;
    let bestIndex = -1;
    let bestScore = 0;
    let secondScore = 0;
    completed.forEach((todo, i) => {
      if (usedTodos.has(i)) return;
      const score = todoTextSimilarity(todo.content, item.text);
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        bestIndex = i;
      } else if (score > secondScore) {
        secondScore = score;
      }
    });
    const ambiguous =
      secondScore > 0 && bestScore - secondScore < FUZZY_MATCH_MARGIN;
    if (bestIndex >= 0 && bestScore >= FUZZY_MATCH_THRESHOLD && !ambiguous) {
      usedTodos.add(bestIndex);
      matched.add(item.id);
    }
  }

  return matched;
}

/**
 * 在宿主作用域上注册官方首个 pre-step 钩子（'agent/pre-step' 瀑布事件）。
 *
 * 官方熔合派发器把载荷派发为 `{ messages, turn, step, signal, modelSelection, agent }`
 * （`agent` 由派发器注入）；本监听器注入完成后**必须**调用 `next()` 并返回其结果，
 * 否则瀑布链断裂。官方 scope 过滤对未打 scope 标签的上下文一律放行
 * （dsh-scope 的 scopeTarget：`scopeOf(ctx) === undefined` 直接 admit），
 * 因此注册在插件可触达的任意普通上下文上均可收到 agent 级派发。
 *
 * @param scope - 宿主上下文（结构面：`on(name, listener)` 返回注销函数）。
 * @param handler - 注入回调；收到的 agent 面见 {@link PreStepAgentFace}。
 * @returns 注销函数；作用域无 `on` 能力时返回空操作（软降级，不阻塞执行）。
 */
export function onAgentPreStep(
  scope: unknown,
  handler: (agent: PreStepAgentFace) => Promise<void> | void,
): () => void {
  const target = scope as
    | {
        on?(
          name: string,
          listener: (
            payload: unknown,
            next: () => Promise<unknown>,
          ) => Promise<unknown>,
        ): unknown;
      }
    | undefined;
  if (target === undefined || typeof target.on !== 'function')
    return () => undefined;
  const dispose = target.on(
    'agent/pre-step',
    async (payload: unknown, next: () => Promise<unknown>) => {
      const agent = (payload as { agent?: unknown } | undefined)?.agent as
        PreStepAgentFace | undefined;
      if (agent !== undefined) {
        try {
          await handler(agent);
        } catch (error) {
          // 注入失败不阻塞执行；injectChecklistTodos 未标记成功时下个 pre-step 会重试。
          console.error(
            '[dsh-taskboard] pre-step checklist injection failed:',
            error,
          );
        }
      }
      return await next();
    },
  );
  return typeof dispose === 'function'
    ? (dispose as () => void)
    : () => undefined;
}
