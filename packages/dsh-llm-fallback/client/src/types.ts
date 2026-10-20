/**
 * 客户端半区的宿主服务窄接口。
 *
 * 只声明本插件实际使用的方法面（structural typing 对齐宿主运行时对象），
 * 不 import 宿主包类型——client 半区经 `require('react')` 与模块表服务
 * 注入获得运行时能力，类型上保持自包含即可通过 tsc 校验。
 *
 * @module dsh-llm-fallback/client/types
 */

/** 宿主模块表解析面（factory 注入的 require 的窄化）。 */
export type ClientRequire = (specifier: string) => unknown;

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
  status: string;
  value: Record<string, unknown> | null;
  writable: boolean;
  revision: number;
}

/** 单条配置变更（本插件只使用 set）。 */
export interface MutationOp {
  op: 'set';
  path: string[];
  value: unknown;
}

/** 单个插件条目的配置读写面（namespace = profile 条目 id）。 */
export interface ConfigScope {
  getSnapshot(): ConfigSnapshot;
  subscribe(fn: () => void): () => void;
  mutate(ops: MutationOp[], revision: number): Promise<void>;
}

/** configForms 服务面：按条目 id 取 scope + 服务期间注册守卫。 */
export interface ConfigFormsFace {
  get(ns: string): ConfigScope;
  whileServed(ns: string[], register: () => unknown): void;
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

/** slots 服务面：占位注册 + 条件注册。 */
export interface SlotsFace {
  inject(slot: string, registrar: () => unknown): unknown;
  register(options: SlotOptions, component: unknown): () => void;
}

// ── remote（dsh-api-remotes / dsh-api-session-controller 的模型目录面）──

/** 模型目录里的一个模型条目。 */
export interface CatalogModel {
  id: string;
  name?: string;
}

/** 模型目录按 provider 分组。 */
export interface CatalogGroup {
  id: string;
  models: CatalogModel[];
}

/** 目录查询失败的 provider（宿主把它隔离在 failures，不进 groups）。 */
export interface CatalogProviderFailure {
  id: string;
  name: string;
  message: string;
}

/** modelCatalog 响应面（宿主 Result 包装）。 */
export interface ModelCatalogResponse {
  ok: boolean;
  value?: {
    groups?: CatalogGroup[];
    failures?: CatalogProviderFailure[];
  };
}

/** remote.session 面本卡只取模型目录。 */
export interface RemoteSessionFace {
  modelCatalog(): Promise<ModelCatalogResponse>;
}

/** remote 服务面。 */
export interface RemoteFace {
  session: RemoteSessionFace;
}

// ── 客户端上下文与插件导出面 ─────────────────────────────────────────

/** 本插件 apply 收到的客户端上下文（inject 声明的服务全部挂为属性）。 */
export interface ClientContext {
  effect(fn: () => unknown, label?: string): void;
  locale?: LocaleFace;
  configForms: ConfigFormsFace;
  slots: SlotsFace;
  remote: RemoteFace;
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
