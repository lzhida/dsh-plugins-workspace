/**
 * 回退队列区块：已选候选列表 + 上移/下移/移除（顺序即回退优先级）。
 *
 * shadcn/ui 映射：序号徽标 → Badge(outline)，操作按钮 → Button(outline,
 * size=icon)，行容器 → border + surface 的工具类布局。
 *
 * @module dsh-llm-fallback/client/components/QueueSection
 */

import * as React from 'react';
import { routeKey, type Route } from '../lib/catalog.ts';
import type { TFn } from '../types.ts';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';

/** 回退队列区块 props。 */
export interface QueueSectionProps {
  t: TFn;
  queue: Route[];
  writable: boolean;
  busy: boolean;
  onMove(index: number, delta: number): void;
  onRemove(index: number): void;
}

/** 配置卡：回退队列（可上移/下移调整顺序）。 */
export function QueueSection(props: QueueSectionProps): React.ReactElement {
  const { t, queue } = props;
  return (
    <section className="flex flex-col gap-2">
      <div className="text-[13px] font-semibold text-foreground">
        {t('queue')}
      </div>
      {queue.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('queueEmpty')}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {queue.map((route, index) => (
            <div
              key={routeKey(route)}
              className="flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5"
            >
              <Badge>{t('fallbackN') + ' ' + (index + 1)}</Badge>
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {route.provider + ' / ' + route.model}
              </span>
              <Button
                variant="outline"
                size="icon"
                disabled={!props.writable || props.busy || index === 0}
                title={t('moveUp')}
                aria-label={t('moveUp')}
                onClick={() => props.onMove(index, -1)}
              >
                ↑
              </Button>
              <Button
                variant="outline"
                size="icon"
                disabled={
                  !props.writable || props.busy || index === queue.length - 1
                }
                title={t('moveDown')}
                aria-label={t('moveDown')}
                onClick={() => props.onMove(index, 1)}
              >
                ↓
              </Button>
              <Button
                variant="outline"
                size="icon"
                disabled={!props.writable || props.busy}
                title={t('remove')}
                aria-label={t('remove')}
                onClick={() => props.onRemove(index)}
              >
                ✕
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
