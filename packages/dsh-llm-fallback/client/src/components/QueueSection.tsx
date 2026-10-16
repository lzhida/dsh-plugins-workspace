/**
 * 回退队列区块：已选候选列表 + 上移/下移/移除（顺序即回退优先级）。
 *
 * @module dsh-llm-fallback/client/components/QueueSection
 */

import * as React from 'react';
import { routeKey, type Route } from '../lib/catalog.ts';
import type { TFn } from '../types.ts';
import { S } from '../styles.ts';

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
    <div style={S.section}>
      <div style={S.label}>{t('queue')}</div>
      {queue.length === 0 ? (
        <div style={S.hint}>{t('queueEmpty')}</div>
      ) : (
        <div style={S.section}>
          {queue.map((route, index) => (
            <div key={routeKey(route)} style={S.queueRow}>
              <span style={S.badge}>{t('fallbackN') + ' ' + (index + 1)}</span>
              <span style={S.grow}>{route.provider + ' / ' + route.model}</span>
              <button
                type="button"
                style={S.btn}
                disabled={!props.writable || props.busy || index === 0}
                title={t('moveUp')}
                onClick={() => props.onMove(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                style={S.btn}
                disabled={
                  !props.writable || props.busy || index === queue.length - 1
                }
                title={t('moveDown')}
                onClick={() => props.onMove(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                style={S.btn}
                disabled={!props.writable || props.busy}
                title={t('remove')}
                onClick={() => props.onRemove(index)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
