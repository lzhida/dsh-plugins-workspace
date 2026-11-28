/**
 * decision-tools 客户端自包含类型面（不 import 宿主包——bundle 经宿主
 * factory 注入的 require 解析 react，其余一律窄接口）。
 *
 * 形状对齐 plugins/dsh-llm-fallback/client/src/types.ts（同仓先例），
 * 裁掉目录/远端面（本卡不消费 modelCatalog）。
 *
 * @module dsh-decision/client/types
 */

/** 宿主注入的 require（factory 闭包内可用）。 */
export type ClientRequire = (id: string) => unknown;

/** 双语文案函数（locale.bind 的产物或静态回退）。 */
export type TFn = (key: string) => string;

/** locale 服务最小面。 */
export type LocaleSnapshot = { active: string; revision: number };
export type LocaleFace = {
  bind(ns: string): TFn;
  register(ns: string, dict: unknown): () => void;
  getSnapshot(): LocaleSnapshot;
  subscribe(listener: () => void): () => void;
};

/** configForms 服务最小面。 */
export type MutationOp = { op: 'set'; path: string[]; value: unknown };
export type ConfigSnapshot = {
  status: string;
  value: Record<string, unknown> | null;
  writable: boolean;
  revision: number;
};
export type ConfigScope = {
  getSnapshot(): ConfigSnapshot;
  subscribe(listener: () => void): () => void;
  mutate(ops: MutationOp[], revision: number): Promise<void>;
};
export type ConfigFormsFace = {
  get(ns: string): ConfigScope;
  whileServed(ns: string[], register: () => () => void): () => void;
};

/** slots 服务最小面。 */
export type SlotOptions = {
  name: string;
  key: string;
  locale: string;
  inject: () => { t: TFn };
};
export type SlotsFace = {
  inject(slot: string, registrar: () => () => void): () => void;
  register(options: SlotOptions, component: unknown): () => void;
};

/** 客户端插件上下文（effect 为可选——client fiber 上可用）。 */
export type ClientContext = {
  effect(fn: () => () => void, label?: string): void;
  locale?: LocaleFace;
  configForms: ConfigFormsFace;
  slots: SlotsFace;
};

/** 客户端插件三符号。 */
export type ClientPluginExports = {
  name: string;
  inject: string[];
  apply(ctx: ClientContext): void;
};

/** 配置卡插槽 props（宿主注入 view）。 */
export type CardProps = {
  view?: 'summary' | 'page';
  t?: TFn;
};
