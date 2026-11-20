/**
 * 回退队列区块：已选候选列表 + 上移/下移/移除（顺序即回退优先级）。
 *
 * 显示名实时化（分支 A）：条目主文本从目录 `name` 实时解析
 * （queueEntryLabel），用户在 dsh 侧重命名模型后无需重新保存即跟随；
 * 目录缺失/未命中时回退 `provider/model` 路由键。
 *
 * 失效标记（分支 B）：条目路由不在当前目录（目录可用时）渲染失效徽标，
 * 区块提供一键清理（显式草稿动作，仍需保存生效）。
 *
 * 候选级参数覆盖（0.7.0）：每行内联两个小输入——推理力度（自由文本，
 * 留空沿用会话力度）与输出上限（正整数 token，留空透传会话原值）。
 * 编辑走 onPatch 落进草稿，保存时随 fallbackChains 一起提交。
 *
 * shadcn/ui 映射：序号徽标 → Badge(outline)，失效徽标 → Badge(outline +
 * destructive token)，操作按钮 → Button(outline, size=icon)，行容器 →
 * border + surface 的工具类布局。
 *
 * @module dsh-llm-fallback/client/components/QueueSection
 */

import * as React from 'react';
import {
  queueEntryLabel,
  routeKey,
  staleRouteKeys,
  type CatalogSnapshotLike,
  type Route,
} from '../lib/catalog.ts';
import type { TFn } from '../types.ts';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';

/** 回退队列区块 props。 */
export interface QueueSectionProps {
  t: TFn;
  queue: Route[];
  /** 目录快照（null = 目录未加载/加载失败：不标失效、显示名回退路由键）。 */
  catalog: CatalogSnapshotLike | null;
  writable: boolean;
  busy: boolean;
  onMove(index: number, delta: number): void;
  onRemove(index: number): void;
  /** 一键清理：把全部失效条目从草稿队列移除（仍需保存生效）。 */
  onClearStale(): void;
  /** 行内编辑候选级覆盖字段（0.7.0）：patch 合并进该条草稿路由。 */
  onPatch(index: number, patch: Partial<Route>): void;
}

/** 行内小输入的公共样式（高度对齐 Badge/图标按钮行）。 */
const INLINE_INPUT_CLASS =
  'h-6 rounded border border-border bg-background px-1.5 text-xs ' +
  'text-foreground placeholder:text-muted-foreground/70 ' +
  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

/** 行内编辑单条候选的参数覆盖字段。 */
function RouteOverrides(props: {
  t: TFn;
  route: Route;
  disabled: boolean;
  onPatch(patch: Partial<Route>): void;
}): React.ReactElement {
  const { t, route, disabled } = props;
  return (
    <span className="flex items-center gap-1">
      <input
        className={INLINE_INPUT_CLASS + ' w-20'}
        value={route.reasoningEffort ?? ''}
        placeholder={t('queueEffortPlaceholder')}
        title={t('queueEffortHint')}
        aria-label={t('queueEffort')}
        disabled={disabled}
        onChange={(e) => props.onPatch({ reasoningEffort: e.target.value })}
      />
      <input
        className={INLINE_INPUT_CLASS + ' w-16'}
        value={route.maxTokens === undefined ? '' : String(route.maxTokens)}
        placeholder={t('queueMaxTokensPlaceholder')}
        title={t('queueMaxTokensHint')}
        aria-label={t('queueMaxTokens')}
        disabled={disabled}
        inputMode="numeric"
        onChange={(e) => {
          const text = e.target.value.trim();
          if (text === '') {
            // 清空 = 未配置（透传会话原值）
            props.onPatch({ maxTokens: undefined });
            return;
          }
          const parsed = Number(text);
          props.onPatch({
            maxTokens:
              Number.isFinite(parsed) && parsed > 0
                ? Math.floor(parsed)
                : undefined,
          });
        }}
      />
    </span>
  );
}

/** 配置卡：回退队列（可上移/下移调整顺序、行内编辑参数覆盖）。 */
export function QueueSection(props: QueueSectionProps): React.ReactElement {
  const { t, queue, catalog } = props;
  // 失效判定只在目录可用时进行（catalog null → 空集，绝不误标）。
  const staleKeys = React.useMemo(
    () => staleRouteKeys(catalog, queue),
    [catalog, queue],
  );
  const staleCount = staleKeys.size;
  const editDisabled = !props.writable || props.busy;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-foreground">
          {t('queue')}
        </div>
        {staleCount > 0 ? (
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs text-destructive"
            disabled={editDisabled}
            title={t('clearStaleHint')}
            aria-label={t('clearStale')}
            onClick={props.onClearStale}
          >
            {t('clearStale') + ' (' + String(staleCount) + ')'}
          </Button>
        ) : null}
      </div>
      {queue.length === 0 ? (
        <div className="text-xs text-muted-foreground">{t('queueEmpty')}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {queue.map((route, index) => {
            const key = routeKey(route);
            const stale = staleKeys.has(key);
            return (
              <div
                key={key}
                className={
                  'flex items-center gap-2 rounded-md border px-2 py-1.5 ' +
                  (stale
                    ? 'border-destructive/50 bg-surface'
                    : 'border-border bg-surface')
                }
              >
                <Badge>{t('fallbackN') + ' ' + (index + 1)}</Badge>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {queueEntryLabel(catalog, route)}
                  <span className="ml-1.5 text-xs text-muted-foreground">
                    {key}
                  </span>
                </span>
                {stale ? (
                  <Badge
                    variant="outline"
                    className="border-destructive/60 text-destructive"
                    title={t('staleHint')}
                  >
                    {t('stale')}
                  </Badge>
                ) : null}
                <RouteOverrides
                  t={t}
                  route={route}
                  disabled={editDisabled}
                  onPatch={(patch) => props.onPatch(index, patch)}
                />
                <Button
                  variant="outline"
                  size="icon"
                  disabled={editDisabled || index === 0}
                  title={t('moveUp')}
                  aria-label={t('moveUp')}
                  onClick={() => props.onMove(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={editDisabled || index === queue.length - 1}
                  title={t('moveDown')}
                  aria-label={t('moveDown')}
                  onClick={() => props.onMove(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  disabled={editDisabled}
                  title={t('remove')}
                  aria-label={t('remove')}
                  onClick={() => props.onRemove(index)}
                >
                  ✕
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
