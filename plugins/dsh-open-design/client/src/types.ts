/**
 * 客户端半区的宿主服务窄接口。
 *
 * 只声明本插件实际使用的方法面（structural typing 对齐宿主运行时对象），
 * 不 import 宿主包类型——client 半区经 `require('react')` 与模块表服务
 * 注入获得运行时能力，类型上保持自包含即可通过 tsc 校验。
 *
 * 契约来源（@deepseek-ai/dsh-client-locale@0.2.x）：
 * - `locale.bind(ns)` 返回的 t 在每次调用时按当前激活语言解析；
 * - `locale.register(ns, dict)` 注册字典，返回注销器。
 *
 * @module dsh-open-design/client/types
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

// ── slots（dsh-client-ui-slots 的插槽注册面，卡 3 启用）──────────────

/**
 * 插槽注册 options。
 *
 * - 面板插槽：main 用 key = 面板 id，sidebar.panellist 用 id + order + label。
 * - inject 返回值是**渲染时传给组件 props 的服务包**。
 */
export interface SlotOptions {
  /** 插槽名（main / sidebar.panellist …）。 */
  name: string;
  /** keyed 插槽的 key（main 面板 = 面板 id）。 */
  key?: string;
  /** 侧栏图标插槽的 id（= 面板 id）。 */
  id?: string;
  /** 侧栏图标排序（小到大；宿主据此排布）。 */
  order?: number;
  /** 侧栏图标标签（返回本地化文案）。 */
  label?: () => string;
  /** 字典命名空间（宿主据此选语言）。 */
  locale?: string;
  /** 插槽注入物（渲染时传给组件 props）。 */
  inject(): Record<string, unknown>;
}

/** slots 服务面：占位注册 + 条件注册（inject 返回注销器）。 */
export interface SlotsFace {
  inject(slot: string, registrar: () => unknown): () => void;
  register(options: SlotOptions, component: unknown): () => void;
}

/**
 * layout 服务面（可选）：面板开关。
 *
 * selectPanel(面板 id) 打开面板；selectPanel(null) 关闭当前面板。
 * 宿主未提供该服务时为 undefined——面板仍可注册，只是没有快捷开关。
 */
export interface LayoutFace {
  selectPanel(id: string | null): void;
}

// ── 客户端上下文与插件导出面 ─────────────────────────────────────────

/** 本插件 apply 收到的客户端上下文（inject 声明的服务全部挂为属性）。 */
export interface ClientContext {
  effect(fn: () => unknown, label?: string): void;
  locale?: LocaleFace;
  slots?: SlotsFace;
  /**
   * 软取服务（宿主 client runtime 的 get 面）。
   *
   * layout 服务用软取而非硬 inject：插槽回调的上下文（sidebar.panellist）
   * 没有 layout——直接读 ctx.layout 会抛 "cannot get property 'layout'
   * without inject"，导致整个插槽注册崩溃。软取拿不到时降级为无面板开关。
   */
  get?(name: string): unknown;
}

/** 客户端插件导出面（loader 只读 name/inject/apply）。 */
export interface ClientPluginExports {
  name: string;
  inject: string[];
  apply(ctx: ClientContext): void;
}
