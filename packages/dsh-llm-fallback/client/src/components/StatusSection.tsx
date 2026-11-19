/**
 * 运行时状态区块（0.9.0 切换可观测性）：今日计数、装配事故、最近切换
 * 事件与冷却中候选的只读展示。
 *
 * 数据来自插件宿主 HTTP 路由（/dsh-llm-fallback/status，仅本机回环），
 * 由 useRuntimeStatus 加载与轮询；ready 态才渲染，加载失败时区块整体
 * 不出现（配置卡其余功能不受影响）。
 *
 * shadcn/ui 映射：标题行沿用 section 样式，计数用 Badge，行卡与
 * QueueSection 同款 border+surface 布局，刷新按钮 → Button(outline, sm)。
 *
 * @module dsh-llm-fallback/client/components/StatusSection
 */

import * as React from 'react';
import type { RuntimeStatusState } from '../hooks.ts';
import type { TFn } from '../types.ts';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';

/** 运行时状态区块 props。 */
export interface StatusSectionProps {
  t: TFn;
  state: RuntimeStatusState;
  onReload(): void;
}

/** 运行时状态区块（只读；非 ready 态不渲染）。 */
export function StatusSection(props: StatusSectionProps): React.ReactElement {
  const { t, state } = props;
  if (state.status !== 'ready') {
    return <React.Fragment />;
  }
  const { value } = state;
  const recent = value.recent.slice(0, 8);
  return (
    <section className="flex flex-col gap-2" data-testid="status-section">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-foreground">
          {t('runtimeTitle')}
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={props.onReload}
          aria-label={t('runtimeReload')}
        >
          {t('runtimeReload')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">
          {t('runtimeAttempts') + ' ' + String(value.totals.attempts)}
        </Badge>
        <Badge variant="outline">
          {t('runtimeFailures') + ' ' + String(value.totals.failures)}
        </Badge>
        <Badge variant="outline">
          {t('runtimeSwitches') + ' ' + String(value.totals.switches)}
        </Badge>
        {value.incidents > 0 ? (
          <Badge
            variant="outline"
            className="border-destructive/60 text-destructive"
            title={t('runtimeIncidentsHint')}
          >
            {t('runtimeIncidents') + ' ' + String(value.incidents)}
          </Badge>
        ) : null}
        <Badge variant="outline">
          {t('runtimeCooldowns') + ' ' + String(value.cooldowns.length)}
        </Badge>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="text-xs text-muted-foreground">
          {t('runtimeRecent')}
        </div>
        {recent.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            {t('runtimeRecentEmpty')}
          </div>
        ) : (
          recent.map((event, index) => (
            <div
              key={String(event.at) + '-' + String(index)}
              className="flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-[13px]"
            >
              <span className="min-w-0 flex-1 truncate">
                {event.from + ' → ' + event.to}
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {event.reason}
                </span>
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
