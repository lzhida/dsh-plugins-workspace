/**
 * decision-tools 客户端插件装配（决策工具系列 6/11）。
 *
 * 照抄 llm-fallback plugin.tsx 范式：locale 在则 bind + 注册字典（缺失
 * 回退静态 t）；configForms 取 scope；配置卡注册进宿主 PackageDetail 的
 * 'plugins.bundle.config' 插槽（key=包名）。
 *
 * @module dsh-decision/client/plugin
 */

import * as React from 'react';

// 样式挂载副作用：factory materialize 即同步注入 <style>（theme.ts 模块体）。
import './theme.ts';

import {
  CONFIG_SLOT,
  DICT_NS,
  ENTRY_NS,
  PKG_NAME,
  PLUGIN_NAME,
} from './constants.ts';
import { DICT, staticT } from './dict.ts';
import { DecisionCard } from './components/decision-card.tsx';
import type { ClientContext, TFn } from './types.ts';

/** 客户端插件名（样式挂载键）。 */
export const name = PLUGIN_NAME;

/** 宿主注入的服务（web seed 短名；与 fanqie-novel 同款口径）。 */
export const inject = ['slots', 'locale', 'configForms'];

export function apply(ctx: ClientContext): void {
  const locale = ctx.locale;
  let t: TFn = staticT;
  if (
    locale &&
    typeof locale.bind === 'function' &&
    typeof locale.register === 'function'
  ) {
    t = locale.bind(DICT_NS);
    ctx.effect(
      () => locale.register(DICT_NS, DICT),
      'decision-tools: dictionaries',
    );
  }

  const scope = ctx.configForms.get(ENTRY_NS);

  function CardSlot(slotProps: {
    view?: 'summary' | 'page';
    t?: TFn;
  }): React.ReactElement {
    return <DecisionCard {...slotProps} t={t} scope={scope} />;
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
    'decision-tools: package config section',
  );
}
