/**
 * 插件版本常量。
 *
 * 与 package.json 的 version 保持一致；src/version.test.ts 会断言二者相等，
 * 避免发布时版本漂移（package.json 是唯一真源，此处只做运行期可读的副本）。
 */
export const PLUGIN_VERSION = '0.1.0';
