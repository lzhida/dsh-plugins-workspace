/**
 * 客户端插件主体：locale 字典注册 + 左栏面板与图标插槽注册（系列 3/6）。
 *
 * 插槽注册范式（对齐 dsh-anytype）：
 * - `main` 插槽（key = 面板 id）渲染主列面板，`sidebar.panellist` 插槽
 *   （id = 面板 id）渲染侧栏图标——宿主侧栏行自带按钮，点击行即打开
 *   面板，图标组件只渲染 glyph（嵌套 button 是无效 HTML）。
 * - 两处注册嵌套在同一 `ctx.slots.inject` 内（外层注销时内层一并注销）。
 * - layout 服务软取（`ctx.get?.('layout')`）：插槽回调的上下文没有
 *   layout，直接读 `ctx.layout` 会抛 "cannot get property 'layout'
 *   without inject"——软取拿不到时降级为无面板关闭按钮。
 *
 * locale（对齐 dsh-anytype / dsh-llm-fallback）：bind 返回的 t 在每次
 * 调用时按当前激活语言解析；locale 服务缺失时回退英文字典的静态 t。
 * slots 服务缺失（组合未含 dsh-client-ui-slots）时只注册字典并告警，
 * apply 不抛错。
 *
 * 样式挂载：import './theme.ts' 在模块体（factory 执行内）同步注入
 * <style data-plugin-css>，宿主 claimStyles 立即认领——绝不懒注入。
 *
 * @module dsh-open-design/client/plugin
 */

import * as React from 'react';

import { DICT_NS, PLUGIN_NAME, PANEL_ID } from './constants.ts';
import { DICT } from './dict.ts';
// 样式挂载副作用：factory materialize 即同步注入 <style>（theme.ts 模块体）。
import './theme.ts';
import { OpenDesignIcon } from './components/OpenDesignIcon.tsx';
import { OpenDesignPanel } from './components/OpenDesignPanel.tsx';
import type { ClientContext, LayoutFace, TFn } from './types.ts';

/** 客户端插件名。 */
export const name = PLUGIN_NAME;

/** 硬服务依赖（宿主按此把服务挂为 ctx 属性并守卫注入）。 */
export const inject = ['locale', 'slots'];

/**
 * 客户端入口：注册字典与面板/图标插槽（副作用全部经 ctx.effect 登记，
 * 卸载时由 cordis 自动清理）。
 */
export function apply(ctx: ClientContext): void {
  // ctx.locale 是宿主 locale 服务的 LocaleFace；缺失时回退英文静态 t。
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
      'dsh-open-design: dictionaries',
    );
  } else {
    t = (key: string): string => {
      const entry = DICT.en[key];
      return entry === undefined ? String(key) : entry;
    };
  }

  const slots = ctx.slots;
  if (!slots || typeof slots.inject !== 'function') {
    console.warn(
      '[dsh-open-design] slots 服务不可用，跳过面板与图标注册（仅字典生效）',
    );
    console.log('[dsh-open-design] client loaded');
    return;
  }

  // layout 软取：拿不到时面板没有关闭按钮（宿主行点击仍可切换）。
  const layout = ctx.get?.('layout') as LayoutFace | undefined;

  /** 面板渲染位（t/onClose 由本闭包供给，组件不接触 ctx）。 */
  function PanelSlot(): React.ReactElement {
    return <OpenDesignPanel t={t} onClose={() => layout?.selectPanel(null)} />;
  }

  /** 图标渲染位（只渲染 glyph，宿主行自带按钮）。 */
  function IconSlot(): React.ReactElement {
    return <OpenDesignIcon />;
  }

  ctx.effect(
    () =>
      slots.inject('main', () =>
        slots.inject('sidebar.panellist', () => {
          const disposePanel = slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: DICT_NS,
              inject: () => ({ t }),
            },
            PanelSlot,
          );
          const disposeIcon = slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 20,
              label: () => t('panel.tabLabel'),
              locale: DICT_NS,
              inject: () => ({ t }),
            },
            IconSlot,
          );
          return () => {
            disposePanel();
            disposeIcon();
          };
        }),
      ),
    'dsh-open-design: sidebar panel',
  );

  console.log('[dsh-open-design] client loaded');
}
