/**
 * 客户端半区的宿主服务窄接口。
 *
 * 只声明本插件实际使用的方法面（structural typing 对齐宿主运行时对象），
 * 不 import 宿主包类型——client 半区经 `require('react')` 与模块表服务
 * 注入获得运行时能力，类型上保持自包含即可通过 tsc 校验。
 *
 * 契约来源（@deepseek-ai/dsh-client-ui-settings@0.2.1-rc.2）：
 * - `ConfigForms.get(entryId)` → 该条目的读写面；
 * - `ConfigForms.whileServed(namespaces, register)` → 任一 namespace 被宿主
 *   服务时执行 register（回调拿到「当前被服务的全部 namespace」），都不服务
 *   时执行 register 返回的 disposer；
 * - `ConfigForms.describe()` → 跨 namespace 的只读面（含 secret 槽位状态）。
 *
 * @module dsh-anytype/client/types
 */

/** 翻译函数（locale.bind(ns) 的返回面）。 */
export type TFn = (key: string) => string;

// ── locale（dsh-client-locale 的 LocaleFace 窄化）────────────────────

/** locale 快照（revision 随语言切换 / 字典注册递增）。 */
export interface LocaleSnapshot {
  active: string;
  revision: number;
}

/** locale 服务面：字典绑定 / 注册 + 快照订阅（语言切换即时联动）。 */
export interface LocaleFace {
  bind(ns: string): TFn;
  register(ns: string, dict: unknown): () => void;
  getSnapshot(): LocaleSnapshot;
  subscribe(fn: () => void): () => void;
}

// ── configForms（dsh-client-ui-settings 的配置表单存储面）────────────

/** 配置存储快照：status 非 ready 时 value 不可读（UI 显示 loading/unavailable）。 */
export interface ConfigSnapshot {
  status: 'loading' | 'ready' | 'unavailable';
  /** 已接受的值（脱敏后——secret 字段不在其中）；未就绪时为 undefined。 */
  value: Record<string, unknown> | undefined;
  /** 组合层（宿主解析出的默认值层）。 */
  base: unknown;
  /** 原始用户层（字段在此出现 = 用户覆盖过）。 */
  user: unknown;
  /** 写入栅栏（下次写入回带的 revision）；宿主尚未应答时为 undefined。 */
  revision: number | undefined;
  /** 宿主文档是否接受写入。 */
  writable: boolean;
}

/** 单条配置变更：set 写值、unset 清除（清除让字段回落组合层默认值）。 */
export type MutationOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] };

/** 单个插件条目的配置读写面（namespace = profile 条目 id）。 */
export interface ConfigScope {
  getSnapshot(): ConfigSnapshot;
  subscribe(fn: () => void): () => void;
  /**
   * 排队一次原子写入。返回 true = 宿主接受；false = 宿主拒绝（栅栏不符 /
   * 校验失败，已回读宿主状态）；传输异常 reject。
   */
  mutate(
    ops: readonly MutationOp[],
    expectedRevision?: number,
  ): Promise<boolean>;
}

/** schema 声明的 secret 槽位（值永不过线，只报「是否已设置」）。 */
export interface SecretSlot {
  /** 从 section 根到被移除字段的路径。 */
  path: string[];
  /** 该槽位当前是否有值。 */
  set: boolean;
}

/** 一个设置 namespace 的只读视图（describe 面）。 */
export interface NamespaceView {
  /** namespace 键（= profile 条目 id）。 */
  ns: string;
  /** 没有自定义页面时宿主是否自动生成表单页。 */
  autoGenerate: boolean;
  /** 已脱敏的解析值（schema 默认 → 组合层 → 用户层）。 */
  value: unknown;
  /** 已脱敏的用户层原始段。 */
  user?: unknown;
  /** 该 namespace 的 secret 槽位。 */
  secrets: SecretSlot[];
  /** 条目配置的版本号（写入栅栏）。 */
  revision: number;
}

/** describe 面的当前答案。 */
export interface DescribeView {
  namespaces: readonly NamespaceView[];
  writable: boolean;
  hasDocument: boolean;
}

/** describe 面快照。 */
export interface DescribeSnapshot {
  status: 'idle' | 'loading' | 'ready';
  view: DescribeView | undefined;
  error: string | null;
}

/** 跨 namespace 的只读面（取 secret 槽位状态用）。 */
export interface DescribeFace {
  getSnapshot(): DescribeSnapshot;
  subscribe(fn: () => void): () => void;
  ensure(): Promise<void>;
}

/** configForms 服务面：取条目 scope + 服务期间注册守卫 + describe 面。 */
export interface ConfigFormsFace {
  get(entryId: string): ConfigScope;
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ): () => void;
  describe(): DescribeFace;
}

// ── slots（dsh-client-ui-slots 的插槽注册面）────────────────────────

/** 插槽注册 options（keyed 插槽：key = 包名）。 */
export interface SlotOptions {
  name: string;
  key: string;
  locale: string;
  /** 插槽注入物（渲染时传给组件 props，本卡只注入 t）。 */
  inject(): { t: TFn };
}

/** slots 服务面：占位注册 + 条件注册（inject 返回注销器）。 */
export interface SlotsFace {
  inject(slot: string, registrar: () => unknown): () => void;
  register(options: SlotOptions, component: unknown): () => void;
}

// ── 客户端上下文与插件导出面 ─────────────────────────────────────────

/** 本插件 apply 收到的客户端上下文（inject 声明的服务全部挂为属性）。 */
export interface ClientContext {
  effect(fn: () => unknown, label?: string): void;
  locale?: LocaleFace;
  configForms: ConfigFormsFace;
  slots: SlotsFace;
}

/** 客户端插件导出面（loader 只读 name/inject/apply）。 */
export interface ClientPluginExports {
  name: string;
  inject: string[];
  apply(ctx: ClientContext): void;
}

/** plugins.bundle.config 插槽传给配置卡的 props（view 区分两个渲染位）。 */
export interface CardProps {
  view?: 'summary' | 'page';
  t?: TFn;
}
