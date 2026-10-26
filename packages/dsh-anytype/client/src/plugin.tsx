/**
 * 客户端插件主体：locale 字典注册 + bundle 配置卡插槽注册。
 *
 * 读写配置走 `ctx.configForms.get(<条目 id>)`（namespace = profile 条目 id），
 * 与本仓库 dsh-llm-fallback 同路径：
 *   scope.getSnapshot() -> { status, value, writable, revision }
 *   scope.mutate([{op:'set', path, value}], revision)
 *
 * 配置卡注册进 `plugins.bundle.config` 插槽（keyed，key = 包名）——这是
 * plugin-manager 的 bundle 详情页（Plugins → @lzhida/dsh-anytype）内部
 * "the configuration the bundle registered for itself" 的官方渲染位：
 *   renderSlot("plugins.bundle.config", { view: "page" }, { entryKey: pkg.name })
 * 且仅当 ledger 里存在 key === pkg.name 的注册时才显示该 data-plugin-config
 * 区块。
 *
 * **两个插件行**（`dsh-anytype` 连接类 / `dsh-anytype-memory` 记忆语义类）
 * 共用这一张卡：宿主只有一个 bundle 级渲染位，故卡片内部按行分区，两行
 * 各自持有一个 scope（独立写入栅栏与草稿）。注册守卫用
 * `configForms.whileServed([两行 id], …)`——任一行被宿主服务时卡片即注册，
 * 两行都没被服务（插件行被禁用）时卡片自动注销。
 *
 * locale（对齐 dsh-llm-fallback）：bind 返回的 t 在每次调用时按当前激活
 * 语言解析（bind 按 ns 缓存，与 LocaleRuntime 同一实例），配合卡片内
 * locale 快照订阅实现语言切换即时生效。locale 服务缺失（组合未含
 * dsh-client-locale）时回退英文字典的静态 t，配置卡降级可用、apply 不抛错。
 *
 * @module dsh-anytype/client/plugin
 */

import * as React from 'react';
import {
  CONFIG_SLOT,
  DICT_NS,
  PKG_NAME,
  PLUGIN_NAME,
  ROW_MAIN,
  ROW_MEMORY,
} from './constants.ts';
import { DICT } from './dict.ts';
import { AnytypeCard } from './components/AnytypeCard.tsx';
// 样式挂载副作用：factory materialize 即同步注入 <style>（theme.ts 模块体）。
import './theme.ts';
import type { CardProps, ClientContext, TFn } from './types.ts';

/** 客户端插件名。 */
export const name = PLUGIN_NAME;

/** 硬服务依赖（宿主按此把服务挂为 ctx 属性并守卫注入）。 */
export const inject = ['slots', 'locale', 'configForms'];

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
    ctx.effect(() => locale.register(DICT_NS, DICT), 'anytype: dictionaries');
  } else {
    t = (key: string): string => {
      const entry = DICT.en[key];
      return entry === undefined ? String(key) : entry;
    };
  }

  /** 插槽渲染位 → 配置卡（t/scope 由本闭包供给，view 透传宿主）。 */
  function CardSlot(slotProps: CardProps): React.ReactElement {
    return (
      <AnytypeCard
        {...slotProps}
        t={t}
        configForms={ctx.configForms}
        locale={locale}
      />
    );
  }

  ctx.effect(
    () =>
      ctx.configForms.whileServed([ROW_MAIN, ROW_MEMORY], () =>
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
    'anytype: package config section',
  );
}
