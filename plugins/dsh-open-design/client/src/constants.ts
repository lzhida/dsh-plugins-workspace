/**
 * 客户端半区的固定标识常量。
 *
 * - PKG_NAME 必须与 package.json 的 name 一致——`__ModuleLoader__.load` 的
 *   id 用它（不一致导致宿主 boot graph arrive() 抛 "loaded without
 *   registering"；由 src/client-bundle.test.ts 断言本常量与清单同步）。
 * - PANEL_ID 是左栏面板 id（main 插槽 key = sidebar.panellist id），
 *   卡 3（左栏图标 + 主列面板）启用。
 * - ROUTE_PREFIX 是宿主 HTTP 侧只读路由前缀（卡 2 启用），面板经同源
 *   fetch 取数。
 *
 * @module dsh-open-design/client/constants
 */

/** 包名（module loader 注册 id）。 */
export const PKG_NAME = '@zhidal/dsh-open-design';

/** 插件语义名（客户端插件 name 导出）。 */
export const PLUGIN_NAME = 'dsh-open-design';

/** locale 字典命名空间。 */
export const DICT_NS = 'dsh-open-design';

/** 左栏面板 id（main 插槽 key 与 sidebar.panellist 图标 id 同值）。 */
export const PANEL_ID = 'dsh-open-design';

/** 宿主 HTTP 只读路由前缀（卡 2 注册 /dsh-open-design/*）。 */
export const ROUTE_PREFIX = '/dsh-open-design';
