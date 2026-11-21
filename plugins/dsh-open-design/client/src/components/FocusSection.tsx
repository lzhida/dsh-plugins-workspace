/**
 * 当前焦点节：上游 get_active_context（/focus）的只读展示。
 *
 * active=false 是常态（用户没在 Open Design 里打开项目），此时直接展示
 * 上游的 hint 文案；active=true 时逐键展示焦点对象（未知形状兜底 JSON）。
 *
 * @module dsh-open-design/client/components/FocusSection
 */

import * as React from 'react';

import type { FocusPayload } from '../api.ts';
import type { TFn } from '../types.ts';

/** 值渲染：字符串原样，其余 JSON（兜底未知形状）。 */
function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 焦点节 props。 */
export interface FocusSectionProps {
  t: TFn;
  focus: FocusPayload | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}

/**
 * 当前焦点节。
 *
 * @param props - 展示数据与回调（容器层集中取数后下发）。
 */
export function FocusSection(props: FocusSectionProps): React.ReactElement {
  const { t, focus, error, loading, onRetry } = props;

  if (error !== null) {
    return (
      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold">{t('focus.title')}</h3>
        <p className="rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-destructive">
          {t('panel.unavailable')}
          {': '}
          {error}
        </p>
        <div>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent"
            onClick={onRetry}
          >
            {t('panel.retry')}
          </button>
        </div>
      </section>
    );
  }

  if (loading && focus === null) {
    return (
      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold">{t('focus.title')}</h3>
        <p className="text-[12px] text-muted-foreground">
          {t('panel.loading')}
        </p>
      </section>
    );
  }

  const entries =
    focus === null
      ? []
      : Object.entries(focus).filter(([key]) => key !== 'active');

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[13px] font-semibold">{t('focus.title')}</h3>
      {focus === null || focus.active !== true ? (
        <p className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-muted-foreground">
          {focus?.hint !== undefined && focus.hint !== ''
            ? focus.hint
            : t('focus.idle')}
        </p>
      ) : (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]">
          {entries.length === 0 ? (
            <span className="text-muted-foreground">{t('focus.idle')}</span>
          ) : (
            entries.map(([key, value]) => (
              <div key={key} className="flex items-start justify-between gap-2">
                <span className="text-muted-foreground">{key}</span>
                <span className="max-w-[65%] break-all text-right">
                  {renderValue(value)}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}
