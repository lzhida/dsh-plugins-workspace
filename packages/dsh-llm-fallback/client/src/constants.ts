/**
 * 客户端半区的固定标识常量。
 *
 * - PKG_NAME 必须与 package.json 的 name 一致——`__ModuleLoader__.load` 的
 *   id 与 `plugins.bundle.config` 插槽的 key 都用它（不一致分别导致 boot
 *   graph arrive() 抛 "loaded without registering" 与详情页不渲染配置卡；
 *   曾因包改名漏改硬编码发布过坏版本 0.3.0，现由 client-bundle.test.ts
 *   断言本常量与 package.json 同步）。
 * - ENTRY_NS 是设置 namespace = profile 条目 id，由 cordis.patch.yml 的
 *   insert 行 id 决定（同由测试断言同步）。
 *
 * @module dsh-llm-fallback/client/constants
 */

/** 包名（module loader 注册 id + keyed 插槽 key）。 */
export const PKG_NAME = '@zhidal/dsh-llm-fallback';

/** 插件语义名（客户端插件 name 导出）。 */
export const PLUGIN_NAME = 'llm-fallback';

/** 设置 namespace = profile 条目 id。 */
export const ENTRY_NS = 'dsh-llm-fallback';

/** locale 字典命名空间。 */
export const DICT_NS = 'llm-fallback';

/** 配置卡注册的目标插槽（plugin-manager 详情页的官方渲染位）。 */
export const CONFIG_SLOT = 'plugins.bundle.config';
