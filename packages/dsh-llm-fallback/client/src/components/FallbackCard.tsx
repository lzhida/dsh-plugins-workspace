/**
 * 配置卡容器：两个渲染位 + 完整配置表单。
 *
 * - `view === 'summary'`：插件列表行/详情头的一句话说明（在调用任何
 *   hook 之前提前返回，符合 hooks 规则）。
 * - 其余（`view === 'page'`）：插件详情页「配置」区块的完整表单——
 *   启用开关、回退队列、模型目录（搜索+勾选）、最大切换候选数、
 *   每候选重试次数、失败候选冷却、保存/放弃操作区。
 *
 * 状态模型（对齐旧版手写实现）：
 * - configForms 快照订阅（scope.getSnapshot/subscribe 契约）；
 * - 单一草稿对象（旧版 8 个 useState 平铺的收敛；null = 无未保存编辑），
 *   保存闸 = isDirty（脏检查）+
 *   revision 一致性（冲突检测，err.code SETTINGS_CONFLICT 同映射）；
 * - 模型目录共享（useModelCatalog）；
 * - locale 快照订阅（useLocaleTick）驱动语言切换即时重渲染。
 *
 * 样式体系：Tailwind 工具类（shadcn/ui 语义 token，theme.css 映射宿主
 * --dsw-alias-*），文本色在卡片根节点显式声明，不依赖宿主容器继承链。
 *
 * @module dsh-llm-fallback/client/components/FallbackCard
 */

import * as React from 'react';
import { useLocaleTick, useModelCatalog } from '../hooks.ts';
import {
  pruneStaleRoutes,
  staleRouteKeys,
  type CatalogSnapshotLike,
} from '../lib/catalog.ts';
import {
  beginDraft,
  buildMutations,
  isDirty,
  readSavedSettings,
  resolveView,
  toSelectedMap,
  type DraftState,
} from '../lib/settings.ts';
import type {
  CardProps,
  ConfigScope,
  LocaleFace,
  RemoteSessionFace,
  TFn,
} from '../types.ts';
import { NumberRow, SwitchRow } from './fields.tsx';
import { CatalogPicker, type CatalogData } from './CatalogPicker.tsx';
import { QueueSection } from './QueueSection.tsx';
import { Button } from './ui/button.tsx';

/** 配置卡 props（t 由 plugin 层注入；scope/session 来自客户端上下文）。 */
export interface FallbackCardProps extends CardProps {
  t: TFn;
  scope: ConfigScope;
  session: RemoteSessionFace;
  /** locale 服务（组合未含 dsh-client-locale 时缺省——静态英文回退）。 */
  locale?: LocaleFace;
}

/** 配置卡入口：按 view 分发（summary 不进 hooks）。 */
export function FallbackCard(props: FallbackCardProps): React.ReactElement {
  if (props.view === 'summary') {
    return <span>{props.t('intro')}</span>;
  }
  return <FallbackCardPage {...props} />;
}

/** 保存错误态（conflict = revision 冲突）。 */
type SaveError = 'conflict' | 'failed' | null;

/** 完整配置表单（page 视图）。 */
function FallbackCardPage(props: FallbackCardProps): React.ReactElement {
  const { t, scope, session, locale } = props;

  // 语言联动（bump 重渲染）与配置快照订阅。
  useLocaleTick(locale);
  const [snap, setSnap] = React.useState(scope.getSnapshot());
  React.useEffect(
    () => scope.subscribe(() => setSnap(scope.getSnapshot())),
    [scope],
  );

  // 草稿与操作态。
  const [draft, setDraft] = React.useState<DraftState | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<SaveError>(null);

  // 队列 picker 的搜索词（纯视图过滤：不影响草稿、队列与保存逻辑）。
  const [search, setSearch] = React.useState('');

  // 模型目录（队列 picker 数据源）。
  const { cat, reload } = useModelCatalog(session);
  const catalog = React.useMemo<CatalogData>(
    () => ({ groups: cat.groups, status: cat.status, onRetry: reload }),
    [cat, reload],
  );

  // 失效判定目录快照：仅目录 ready 时提供（loading/error/idle → null，
  // 绝不误标）；含查询失败的 provider 集（这些 provider 的条目不标失效）。
  const catalogSnapshot = React.useMemo<CatalogSnapshotLike | null>(
    () =>
      cat.status === 'ready'
        ? { groups: cat.groups, unverifiedProviders: cat.unverified }
        : null,
    [cat],
  );

  // 快照 → 已保存视图 → 叠加草稿 → 保存闸。
  const saved = React.useMemo(
    () => readSavedSettings(snap.value, snap.revision),
    [snap],
  );
  const view = resolveView(saved, draft);
  const dirty = isDirty(view, saved);
  const writable = snap.writable;

  /** 取当前草稿（无草稿则从已保存视图初始化——旧版 beginDraft）。 */
  function ensureDraft(): DraftState {
    const base = draft ?? beginDraft(saved);
    if (draft === null) setDraft(base);
    return base;
  }

  /** 草稿不可变更新（函数式收口：所有编辑先 ensureDraft 再覆盖字段）。 */
  function patchDraft(patch: (base: DraftState) => Partial<DraftState>): void {
    const base = ensureDraft();
    setDraft({ ...base, ...patch(base) });
  }

  function toggleModel(provider: string, model: string): void {
    if (!writable || busy) return;
    const key = provider + '/' + model;
    const base = ensureDraft().queue;
    const exists = base.some((r) => r.provider + '/' + r.model === key);
    const next = exists
      ? base.filter((r) => r.provider + '/' + r.model !== key)
      : base.concat([{ provider, model }]);
    patchDraft(() => ({ queue: next }));
    setError(null);
  }

  function move(index: number, delta: number): void {
    if (!writable || busy) return;
    const base = ensureDraft().queue.slice();
    const target = index + delta;
    if (target < 0 || target >= base.length) return;
    const tmp = base[index];
    base[index] = base[target];
    base[target] = tmp;
    patchDraft(() => ({ queue: base }));
  }
  function removeAt(index: number): void {
    if (!writable || busy) return;
    const base = ensureDraft().queue.slice();
    base.splice(index, 1);
    patchDraft(() => ({ queue: base }));
  }

  /** 一键清理失效条目：显式草稿动作（仍需保存生效）。无可清理项时 no-op。 */
  function clearStale(): void {
    if (!writable || busy) return;
    const base = ensureDraft().queue;
    const kept = pruneStaleRoutes(catalogSnapshot, base);
    if (kept === base) return;
    patchDraft(() => ({ queue: kept }));
  }

  function discard(): void {
    setDraft(null);
    setError(null);
  }

  function save(): void {
    if (busy || !writable) return;
    const revision = draft?.revision ?? snap.revision;
    if (draft !== null && snap.revision !== draft.revision) {
      setError('conflict');
      return;
    }
    // 保存路径剔除失效条目（分支 B）：写入载荷不含"不在当前目录"的候选
    // ——剔除是本次显式保存动作的一部分，不做任何服务端/后台静默剔除。
    // 目录不可用（catalogSnapshot null）时 pruneStaleRoutes 原样返回，
    // 行为与旧版一致。
    const staleCount = staleRouteKeys(catalogSnapshot, view.queue).size;
    const effView =
      staleCount > 0
        ? { ...view, queue: pruneStaleRoutes(catalogSnapshot, view.queue) }
        : view;
    setBusy(true);
    setError(null);
    scope
      .mutate(buildMutations(effView), revision)
      .then(() => {
        setBusy(false);
        discard();
      })
      .catch((err: { code?: string } | null) => {
        setBusy(false);
        setError(
          err && err.code === 'SETTINGS_CONFLICT' ? 'conflict' : 'failed',
        );
      });
  }

  // 非.ready 快照：显示 loading / unavailable。
  if (snap.status !== 'ready') {
    const notice =
      snap.status === 'unavailable' ? t('unavailable') : t('loading');
    return (
      <div className="py-1 text-[13px] text-muted-foreground">{notice}</div>
    );
  }

  const selected = toSelectedMap(view.queue);

  // 状态行文案（只读 / 冲突 / 失败 / 保存中 / 未保存）。
  const statusText: string | null = !writable
    ? t('readonly')
    : error === 'conflict'
      ? t('conflict')
      : error === 'failed'
        ? t('failed')
        : busy
          ? t('saving')
          : dirty
            ? t('dirty')
            : null;

  return (
    <div className="flex flex-col gap-4 py-1 text-foreground">
      <div className="text-[13px] text-muted-foreground">{t('intro')}</div>

      <SwitchRow
        checked={view.enabled}
        disabled={!writable || busy}
        onChange={() => patchDraft(() => ({ enabled: !view.enabled }))}
        label={t('enabled')}
        hint={t('enabledDesc')}
      />

      <QueueSection
        t={t}
        queue={view.queue}
        catalog={catalogSnapshot}
        writable={writable}
        busy={busy}
        onMove={move}
        onRemove={removeAt}
        onClearStale={clearStale}
      />

      <CatalogPicker
        t={t}
        hintKey="catalogHint"
        catalog={catalog}
        selected={selected}
        onToggle={toggleModel}
        writable={writable}
        busy={busy}
        search={search}
        onSearch={setSearch}
      />

      <NumberRow
        label={t('retriesBeforeSwitch')}
        hint={t('retriesHint')}
        value={view.retriesBeforeSwitch}
        disabled={!writable || busy}
        onChange={(n) => patchDraft(() => ({ retriesBeforeSwitch: n }))}
      />

      <NumberRow
        label={t('maxRetries')}
        hint={t('maxRetriesHint')}
        value={view.maxRetries}
        disabled={!writable || busy}
        onChange={(n) => patchDraft(() => ({ maxRetries: n }))}
      />

      <SwitchRow
        checked={view.cooldownEnabled}
        disabled={!writable || busy}
        onChange={() =>
          patchDraft(() => ({ cooldownEnabled: !view.cooldownEnabled }))
        }
        label={t('cooldownEnabled')}
        hint={t('cooldownEnabledHint')}
      />

      <NumberRow
        label={t('cooldownMs')}
        hint={t('cooldownMsHint')}
        value={view.cooldownMs}
        disabled={!writable || busy}
        onChange={(n) => patchDraft(() => ({ cooldownMs: n }))}
      />

      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] text-muted-foreground">{statusText}</div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!dirty || busy} onClick={discard}>
            {t('discard')}
          </Button>
          <Button disabled={!dirty || busy || !writable} onClick={save}>
            {busy ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
