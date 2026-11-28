/**
 * decision-tools 客户端半区常量（决策工具系列 6/11）。
 *
 * - PKG_NAME 必须与 package.json name 一致（module loader 注册 id 与
 *   keyed 插槽 key 都用它）；
 * - ENTRY_NS 是设置 namespace（= cordis.patch.yml insert 行 id）；
 * - PLUGIN_NAME 是客户端插件 name 导出 + 样式挂载键。
 *
 * @module dsh-decision/client/constants
 */

/** 宿主 module loader 注册 id / configForms slot key（= 包名）。 */
export const PKG_NAME = '@zhidal/dsh-decision';

/** 客户端插件 name 导出 + <style data-plugin-css> 挂载键。 */
export const PLUGIN_NAME = 'decision-tools';

/**
 * 设置 namespace（= profile 条目 id = cordis.patch.yml 的 insert 行 id）。
 *
 * **必须与 patch 行 id 一致**——宿主按 namespace 取配置 scope；取不到 scope
 * 时 `configForms.whileServed` 不会触发，插件详情页就**不渲染配置卡**（页面
 * 其它部分照常，看起来像「设置页没做出来」）。本包有两行：`ask-gate` 与
 * `decision-tools`；设置卡属于决策工具行，故取 `decision-tools`。
 *
 * 由 `client/src/constants.test.ts` 断言与 cordis.patch.yml 的行 id 同步。
 */
export const ENTRY_NS = 'decision-tools';

/** 双语字典 namespace。 */
export const DICT_NS = 'decision-tools';

/** 宿主 PackageDetail 页的官方配置卡插槽。 */
export const CONFIG_SLOT = 'plugins.bundle.config';

/** 同源验证路由（host 半区 webServer.register 的 exact 路径）。 */
export const VERIFY_ROUTE_PATH = '/dsh-decision/verify';

/** 十个工具开关的配置字段名（与 src/config/decision-tools.ts 一致）。 */
export const TOOL_SWITCH_FIELDS = [
  'toolsDecideEnabled',
  'toolsGateEnabled',
  'toolsRerankEnabled',
  'toolsBatchEnabled',
  'toolsLocateEnabled',
  'toolsUsageEnabled',
  'toolsHistoryEnabled',
  'toolsRecheckEnabled',
  'toolsCalibrateEnabled',
  'toolsArbiterEnabled',
] as const;

export type ToolSwitchField = (typeof TOOL_SWITCH_FIELDS)[number];

/** 工具开关 → 字典 key 的映射（label 走双语字典）。 */
export const TOOL_SWITCH_LABEL_KEYS: Record<ToolSwitchField, string> = {
  toolsDecideEnabled: 'tool.decide',
  toolsGateEnabled: 'tool.gate',
  toolsRerankEnabled: 'tool.rerank',
  toolsBatchEnabled: 'tool.batch',
  toolsLocateEnabled: 'tool.locate',
  toolsUsageEnabled: 'tool.usage',
  toolsHistoryEnabled: 'tool.history',
  toolsRecheckEnabled: 'tool.recheck',
  toolsCalibrateEnabled: 'tool.calibrate',
  toolsArbiterEnabled: 'tool.arbiter',
};
