/**
 * 客户端半区的固定标识常量。
 *
 * - PKG_NAME 必须与 package.json 的 name 一致——`__ModuleLoader__.load` 的
 *   id 与 `plugins.bundle.config` 插槽的 key 都用它（不一致分别导致 boot
 *   graph arrive() 抛 "loaded without registering" 与详情页不渲染配置卡；
 *   由 src/client-bundle.test.ts 断言本常量与 package.json 同步）。
 * - ROW_MAIN / ROW_MEMORY 是两个插件行的 **设置 namespace**（= profile 条目
 *   id = cordis.patch.yml 里的 insert 行 id）：配置卡对两行各取一个
 *   configForms scope（读值 / 写入），二者互不越界。
 *
 * @module dsh-anytype/client/constants
 */

/** 包名（module loader 注册 id + keyed 插槽 key）。 */
export const PKG_NAME = '@zhidal/dsh-anytype';

/** 插件语义名（客户端插件 name 导出）。 */
export const PLUGIN_NAME = 'anytype';

/** locale 字典命名空间。 */
export const DICT_NS = 'anytype';

/** 配置卡注册的目标插槽（plugin-manager 详情页的官方渲染位）。 */
export const CONFIG_SLOT = 'plugins.bundle.config';

/** 插件行①的设置 namespace：通用 Anytype 工具 + 连接类字段。 */
export const ROW_MAIN = 'dsh-anytype';

/** 插件行②的设置 namespace：持久记忆语义类字段。 */
export const ROW_MEMORY = 'dsh-anytype-memory';
