/**
 * Anytype 连接服务。
 *
 * ## 为什么要有这个服务
 *
 * anytype 系列有多个插件行（`dsh-anytype` 通用工具、`dsh-anytype-memory`
 * 持久记忆、将来还有 `dsh-anytype-wiki`）。它们**共用同一把钥匙、同一份
 * 连接配置、同一个客户端**。若每个插件行各自建 client、各自读一份
 * apiKey，就会出现「钥匙填两处、改一处漏一处」的漂移。
 *
 * 官方的做法是**具名 service**：一个插件行提供服务名，其它插件行用
 * `inject: ['<服务名>']` 声明依赖、等它就绪后从 `ctx.<服务名>` 取用
 * （参考官方 `@deepseek-ai/dsh-tools` 的 `ToolRuntime extends Service`，
 *  它同样以具名方式注册、由别的插件 `inject: ['tools']` 消费）。
 *
 * ## 为什么不是 `class X extends Service`
 *
 * 本仓库的约定是 `@deepseek-ai/cordis` **只做类型引用**（运行时由宿主
 * 提供，插件不打包框架）。要拿到 cordis 的 `Service` 基类就得引入运行时
 * 依赖，违反该约定；而且服务本身**没有需要随卸载释放的资源**（客户端是
 * 无状态的 HTTP 调用）。故此处用「普通类 + `ctx.provide('anytype', …)`」
 * 达到同样的具名服务语义：
 * - 插件行①在 `apply()` 里 `ctx.provide('anytype', service)`（返回注销函数，
 *   随插件卸载自动执行）；
 * - 插件行②声明 `inject: ['anytype']`，cordis 保证服务就绪后才调其
 *   `apply()`，此时 `ctx.get('anytype')` 必非空。
 *
 * ## 配置是「现读」的
 *
 * 服务持有的是**读取器**而不是配置快照：设置面板改完 apiKey/baseUrl
 * 后，下一次工具调用即用新值（与本仓库既有的 volatile 约定一致），无需
 * 重载插件。
 */

import type { Context } from '@deepseek-ai/cordis';

import { AnytypeClient } from '../core/index.ts';

/** 连接参数（服务持有的最小视图）。 */
export interface AnytypeConnection {
  /** Anytype 本地 API 地址（无尾斜杠）。 */
  baseUrl: string;
  /** Bearer 密钥（空串 = 未配置）。 */
  apiKey: string;
  /** `Anytype-Version` 请求头取值。 */
  apiVersion: string;
  /** 单请求超时（毫秒）。 */
  requestTimeoutMs: number;
  /** 工具结果文本截断上限（字符数）。 */
  maxResponseChars: number;
}

/**
 * Anytype 连接服务：持有一个**配置现读**的客户端。
 *
 * 插件行拿它去构造自己的存储层（如 `MemoryStore`），从而多个插件行共享
 * 同一份连接配置与同一个客户端实例。
 */
export class AnytypeService {
  /** 共享客户端（配置现读，改设置面板即生效）。 */
  readonly client: AnytypeClient;

  /** 连接配置读取器。 */
  private readonly read: () => AnytypeConnection;

  /**
   * @param read - 连接配置读取器（每次调用现读 volatile 配置）。
   */
  constructor(read: () => AnytypeConnection) {
    this.read = read;
    this.client = new AnytypeClient(() => {
      const connection = read();
      return {
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        apiVersion: connection.apiVersion,
        timeoutMs: connection.requestTimeoutMs,
      };
    });
  }

  /** 当前生效的连接配置（现读）。 */
  get connection(): AnytypeConnection {
    return this.read();
  }
}

/**
 * 在上下文中注册具名服务 `anytype`。
 *
 * @param ctx - cordis 上下文（`ctx.provide` 由宿主的反射层提供）。
 * @param read - 连接配置读取器。
 * @returns 服务实例与注销函数（注销随宿主 fiber 卸载自动执行）。
 */
export function provideAnytypeService(
  ctx: Context,
  read: () => AnytypeConnection,
): { service: AnytypeService; dispose: () => void } {
  const service = new AnytypeService(read);
  const dispose = ctx.provide('anytype', service);
  return { service, dispose };
}
