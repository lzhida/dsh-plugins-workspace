/**
 * 客户端插件主体：locale 字典注册 + 配置卡插槽注册。
 *
 * 读写配置走 `ctx.configForms.get(ENTRY_NS)`（namespace = profile 条目 id），
 * 与一方插件 dsh-client-ui-settings-subagent 同路径：
 *   scope.getSnapshot() -> { status, value, writable, revision }
 *   scope.mutate([{op:'set', path, value}], revision)
 *
 * 配置卡注册进 `plugins.bundle.config` 插槽（keyed，key = 包名）——这是
 * plugin-manager 的 PackageDetail 页（设置 → 插件 → @zhidal/dsh-llm-fallback）
 * 内部 "the configuration the bundle registered for itself" 的官方渲染位：
 *   renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
 * 且仅当 ledger 里存在 key === pkg.name 的注册时才显示该 data-plugin-config
 * 区块。（曾试过 plugins.item——那是 ItemCard 独立配置页的插槽，与官方
 * settings-subagent/shell/web-search 一样会渲染成独立区块，不符合"嵌在本
 * 插件页内"的诉求，已改用 bundle.config。）
 *
 * locale（0.3.3 起）：bind 返回的 t 在每次调用时按当前激活语言解析（bind
 * 按 ns 缓存，与 LocaleRuntime 同一实例），配合卡片内 locale 快照订阅实现
 * 语言切换即时生效。locale 服务缺失（组合未含 dsh-client-locale）时回退
 * 英文字典的静态 t，配置卡降级可用、apply 不抛错。服务端 Config schema 的
 * 字段描述另经 schemastery i18n 映射（见 src/config.ts 的 desc()）随
 * settings.describe 下发，由前端按同一语言配置解析。
 *
 * @module dsh-llm-fallback/client/plugin
 */

import * as React from 'react';
import {
  CONFIG_SLOT,
  DICT_NS,
  ENTRY_NS,
  PKG_NAME,
  PLUGIN_NAME,
} from './constants.ts';
import { DICT } from './dict.ts';
import { FallbackCard } from './components/FallbackCard.tsx';
import type { CardProps, ClientContext, TFn } from './types.ts';

/** 客户端插件名。 */
export const name = PLUGIN_NAME;

/** 硬服务依赖（宿主按此把服务挂为 ctx 属性并守卫注入）。 */
export const inject = [
  'slots',
  'locale',
  'remote',
  'remote.session',
  'configForms',
];

/**
 * 客户端入口：注册字典与配置卡插槽（副作用全部经 ctx.effect 登记，卸载
 * 时由 cordis 自动清理）。
 */
export function apply(ctx: ClientContext): void {
  // dsh 语言配置入口：ctx.locale 是宿主 locale 服务的 LocaleFace
  // (bind/register/getSnapshot/subscribe)。缺失时回退英文字典的静态 t。
  const locale = ctx.locale;
  let t: TFn;
  if (
    locale &&
    typeof locale.bind === 'function' &&
    typeof locale.register === 'function'
  ) {
    t = locale.bind(DICT_NS);
    ctx.effect(
      () => locale.register(DICT_NS, DICT),
      'llm-fallback: dictionaries',
    );
  } else {
    t = (key: string): string => {
      const entry = DICT.en[key];
      return entry === undefined ? String(key) : entry;
    };
  }

  // namespace = profile 条目 id；dsh-settings 按条目 id 索引 descriptor。
  const scope = ctx.configForms.get(ENTRY_NS);

  /** 插槽渲染位 → 配置卡（t/scope/session 由本闭包供给，view 透传宿主）。 */
  function CardSlot(slotProps: CardProps): React.ReactElement {
    return (
      <FallbackCard
        {...slotProps}
        t={t}
        scope={scope}
        session={ctx.remote.session}
        locale={locale}
      />
    );
  }

  ctx.effect(
    () =>
      ctx.configForms.whileServed([ENTRY_NS], () =>
        ctx.slots.inject(CONFIG_SLOT, () =>
          ctx.slots.register(
            {
              name: CONFIG_SLOT,
              key: PKG_NAME,
              locale: DICT_NS,
              inject: () => ({ t }),
            },
            CardSlot,
          ),
        ),
      ),
    'llm-fallback: package config section',
  );
}
