/**
 * dsh-anytype-wiki 插件入口（**留位**，本次不注册）。
 *
 * ## 它将来是什么
 *
 * 官方 Anytwo 平台已有一版「LLM Wiki」知识编译管道：受规则约束、单向派生
 * （Raw → Wiki → Index）+ 人类控制回路。本插件行是它在本仓库的落点
 * （看板卡 `t-mvge7pbb-z8575m`），预期职责：
 *
 * - **Raw 层** = Anytype 里的一个专属空间；插件**只读**，不提供任何写 Raw
 *   的工具（人类增删，AI 只读——架构硬约束）；
 * - **Wiki 层** = 派生对象集合，页间用 Anytype 对象链接成图，带
 *   `memory_status`（draft/approved/archived）承载审核态；
 * - **工具面**：`wiki_ingest`（读 Raw 编译进 Wiki，幂等键 = raw 对象 id +
 *   内容 hash）、`wiki_query`（只读 + Raw 溯源）、`wiki_lint`（矛盾/孤立页/
 *   失效链接巡检）、`wiki_review`（待审列表 + 裁决）。
 *
 * ## 为什么现在不注册它
 *
 * 一个**空插件行**会在工具面板与装载日志里留下噪音，且没有任何能力可言。
 * 因此本次只把**位置与契约**定下来（目录、命名、与连接 service 的关系），
 * 等那张卡开工时：实现 `src/wiki/**` → 在本文件补齐 `apply` → 在
 * `cordis.patch.yml` 追加第三行 `- id: dsh-anytype-wiki`。
 *
 * ## 与其它插件行的关系
 *
 * 与 `entries/memory.ts` 同构：`inject: ['tools', 'systemPrompt', 'anytype']`
 * ——复用插件行①提供的连接服务，**连接配置同样只填一次**。
 */

/** Cordis 插件名（loader 依赖）。 */
export const name = 'dsh-anytype-wiki';
/**
 * 依赖注入：工具注册表 + system-prompt + 连接服务（由插件行①提供）。
 *
 * 将来实现时照此声明即可——`anytype` 服务就绪前本插件行停在 PENDING。
 */
export const inject: string[] = ['tools', 'systemPrompt', 'anytype'];

/**
 * 插件入口（**占位**：本次不注册工具）。
 *
 * 将来实现时这里会接上 `ctx.tools.register(...)` 注册 `wiki_*` 工具。
 */
export function apply(): void {
  console.log(`[${name}] reserved plugin row (not registered yet)`);
}
