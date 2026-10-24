/**
 * dsh-anytype 包根 barrel。
 *
 * 一个包、一个 bundle、多个插件行：
 * - **插件行①** `dsh-anytype` —— 通用 Anytype 工具（30 个 `anytype_*`）+
 *   连接服务 `anytype`；
 * - **插件行②** `dsh-anytype-memory` —— 持久记忆（16 个 `memory_*`），
 *   经 `inject: ['anytype']` 复用插件行①的连接服务；
 * - **留位** `dsh-anytype-wiki` —— 将来的 LLM Wiki 知识编译管道
 *   （本次不注册）。
 *
 * 包根导出**插件行①的插件契约**（`name` / `apply` / `Config`）——这样本包
 * 既能作为 bundle 被 patch 文件激活，也能作为单个 plain dependency 直接
 * 装载（`main` 指向的入口自带 name/apply）。
 *
 * 记忆域的领域能力（schema / 存储 / 纯函数）从 `./memory/index.ts` 导出，
 * 其**插件契约**在 `./entries/memory.ts`（两者刻意分开，避免同名导出冲突）。
 */

// ── 插件行①的插件契约（loader 直接消费） ─────────────────────────────
export {
  name,
  apply,
  inject,
  provide,
  SECTION_NAME,
  SECTION_ORDER,
} from './entries/anytype.ts';
export { Config } from './anytype/config.ts';
export type { ResolvedConfig, ToolGroup } from './anytype/config.ts';
export {
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  TOOL_GROUPS,
} from './anytype/config.ts';

// ── 连接服务 ─────────────────────────────────────────────────────────
export { AnytypeService } from './services/anytype.ts';
export type { AnytypeConnection } from './services/anytype.ts';

// ── 共享底座（client / tools 公共设施 / volatile 支持） ───────────────
export * from './core/index.ts';

// ── anytype 工具族（别名，避免与记忆域同名导出冲突） ─────────────────
export {
  buildTools as buildAnytypeTools,
  buildGroupedTools as buildAnytypeGroupedTools,
} from './anytype/tools/index.ts';
export { anytypeGuidanceSection } from './entries/anytype.ts';

// ── 记忆域（领域能力，不含插件契约） ────────────────────────────────
export * from './memory/index.ts';

// ── 记忆插件行（插件契约单独导出，便于按需引用） ──────────────────────
export {
  name as memoryPluginName,
  apply as applyMemoryPlugin,
  inject as memoryInject,
  memoryGuidanceSection,
  SECTION_NAME as MEMORY_SECTION_NAME,
  SECTION_ORDER as MEMORY_SECTION_ORDER,
} from './entries/memory.ts';
export { Config as MemoryConfig } from './entries/memory.ts';
