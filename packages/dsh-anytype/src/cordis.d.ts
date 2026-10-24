/**
 * Ambient declaration：扩展 `@deepseek-ai/cordis` 的 Context，
 * 增加本包提供的具名服务 `anytype`。
 *
 * ## 为什么是独立 .d.ts 文件而不是 inline `declare module`
 *
 * - TypeScript 的 declaration merging 受 tsconfig include 规则约束；
 *   当外部项目（如 dsh desktop）加载本插件时，host 的 tsconfig 只能
 *   「看到」host 自己 include 的 .d.ts 文件，看不到本仓库 .ts 源码文件内的
 *   augmentation；
 * - 通过本插件 package.json 的 `types` 字段指向这个 .d.ts 文件，dsh desktop
 *   在加载 plugin 时，TypeScript 编译器会沿着 main 的导入链找到这个
 *   ambient 类型，augmentation 跨包生效；
 * - 这样 `ctx.anytype` 就能在 host 的 tsconfig 下编译通过，避免
 *   dsh: warning: ... failed to import 错误。
 *
 * （做法与仓库内 `@zhidal/dsh-llm-fallback` 的 `src/cordis.d.ts` 一致。）
 */

import type { AnytypeService } from './services/anytype.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Anytype 连接服务（由插件行 `dsh-anytype` 提供）。
     *
     * 插件行 `dsh-anytype-memory` 通过 `inject: ['anytype']` 等待它就绪，
     * 再用 `ctx.anytype.client` 复用同一个客户端——**连接配置只填一次**。
     */
    anytype: AnytypeService;
  }
}

export {};
