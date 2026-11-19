/**
 * Ambient declaration：扩展 `@deepseek-ai/cordis` 的 Context，
 * 增加本包提供的具名服务 `anytype`，以及宿主可选的 `webServer` 服务面。
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
 *
 * ## `webServer` 为什么是可选属性
 *
 * 面板只读路由要挂在宿主 `webServer` 服务上。该服务的类型在本仓里用
 * **最小结构面**声明（`WebServerLike`，见 panel/routes.ts），不引第三方包
 * ——引依赖会改动 lock 文件，本仓约定禁止。宿主没提供 webServer（如
 * 非 web 组合）时属性为 undefined，面板路由不注册，其余能力不受影响。
 */

import type { AnytypeService } from './services/anytype.ts';
import type { WebServerLike } from './panel/routes.ts';

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Anytype 连接服务（由插件行 `dsh-anytype` 提供）。
     *
     * 插件行 `dsh-anytype-memory` 通过 `inject: ['anytype']` 等待它就绪，
     * 再用 `ctx.anytype.client` 复用同一个客户端——**连接配置只填一次**。
     */
    anytype: AnytypeService;
    /**
     * 宿主 webServer 服务（可选）：面板只读路由挂在它上面。
     *
     * 宿主未提供时为 undefined——插件行据此跳过路由注册，不抛错。
     */
    webServer?: WebServerLike;
  }
}

export {};
