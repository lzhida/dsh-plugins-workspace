/**
 * Anytype 左侧栏面板（v1 只读状态视图）。
 *
 * 渲染位：`main` 插槽（key = 面板 id），配套侧栏图标注册在
 * `sidebar.panellist` 插槽。数据通道是宿主 webServer 上的两个只读 GET
 * 端点（`/dsh-anytype/panel/status` 与 `/dsh-anytype/panel/queue`），
 * 客户端同源 fetch + 30s 轮询 + 手动刷新（v1 不做 SSE）。
 *
 * 四节（只读）：
 * 1. 连接状态——apiKey 只报「已配置 / 未配置」，**永不回显值**；
 * 2. wiki 待审队列（draft）——只读展示，不含 approve/reject 按钮；
 * 3. 空间列表；
 * 4. 最近笔记。
 *
 * 样式：Tailwind 工具类（shadcn 语义 token，theme.css 映射宿主
 * `--dsw-alias-*`），不使用 iframe、不触碰宿主 DOM。
 *
 * @module dsh-anytype/client/components/AnytypePanel
 */

import * as React from 'react';

import type { TFn } from '../types.ts';

/** 面板 id（main 插槽的 key = sidebar.panellist 的 id）。 */
export const PANEL_ID = 'anytype-panel';

/** status 端点（与宿主 panel/routes.ts 的前缀一致）。 */
export const STATUS_ENDPOINT = '/dsh-anytype/panel/status';

/** queue 端点（与宿主 panel/routes.ts 的前缀一致）。 */
export const QUEUE_ENDPOINT = '/dsh-anytype/panel/queue';

/** 轮询间隔（毫秒）。 */
export const POLL_INTERVAL_MS = 30_000;

/** 连接状态载荷（与宿主 PanelConnection 对齐）。 */
export interface PanelConnection {
  apiKeyConfigured: boolean;
  baseUrl: string;
  reachable: boolean;
  authenticated: boolean;
  latencyMs: number;
  error: string | null;
}

/** 空间摘要。 */
export interface PanelSpace {
  id: string;
  name: string;
}

/** 笔记摘要。 */
export interface PanelNote {
  id: string;
  name: string;
  status: string;
  source: string | null;
  updatedAt: string | null;
}

/** status 端点载荷。 */
export interface PanelStatus {
  connection: PanelConnection;
  spaces: PanelSpace[];
  recentNotes: PanelNote[];
  checkedAt: string;
  warning: string | null;
}

/** queue 端点载荷。 */
export interface PanelQueue {
  spaceId: string | null;
  pending: PanelNote[];
  total: number | null;
  hasMore: boolean;
  checkedAt: string;
  warning: string | null;
}

/** 面板 props（t / onClose 由 plugin 层注入）。 */
export interface AnytypePanelProps {
  t: TFn;
  /** 关闭面板的回调（宿主 layout.selectPanel 的软取结果；缺失时不渲染关闭按钮）。 */
  onClose?: () => void;
}

/** 面板内部状态。 */
interface PanelState {
  status: PanelStatus | null;
  queue: PanelQueue | null;
  /** status 端点失败（只影响连接 / 空间 / 最近笔记三节）。 */
  statusError: string | null;
  /** queue 端点失败（只影响待审队列一节）。 */
  queueError: string | null;
  loading: boolean;
}

/** 取 JSON 信封里的 value（失败抛可读错误）。 */
async function fetchPayload<T>(path: string): Promise<T> {
  // AbortSignal.timeout 在部分宿主/测试环境（jsdom）不存在——降级为无超时。
  const hasTimeout =
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function';
  const response = await fetch(
    path,
    hasTimeout ? { signal: AbortSignal.timeout(10_000) } : {},
  );
  const body = (await response.json()) as {
    ok?: boolean;
    value?: T;
    error?: { message?: string };
  };
  if (body.ok !== true || body.value === undefined) {
    throw new Error(body.error?.message ?? `panel request failed: ${path}`);
  }
  return body.value;
}

/**
 * Anytype 状态面板。
 *
 * @param props - 面板 props（t = 本地化文案，onClose = 面板关闭回调）。
 */
export function AnytypePanel(props: AnytypePanelProps): React.ReactElement {
  const { t, onClose } = props;
  const [state, setState] = React.useState<PanelState>({
    status: null,
    queue: null,
    statusError: null,
    queueError: null,
    loading: true,
  });

  const load = React.useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true }));
    // 两个端点各自降级：任一端点失败只影响它那一节，不拖垮整版。
    const [statusResult, queueResult] = await Promise.allSettled([
      fetchPayload<PanelStatus>(STATUS_ENDPOINT),
      fetchPayload<PanelQueue>(QUEUE_ENDPOINT),
    ]);
    const toMessage = (reason: unknown): string =>
      reason instanceof Error ? reason.message : String(reason);
    setState({
      status: statusResult.status === 'fulfilled' ? statusResult.value : null,
      queue: queueResult.status === 'fulfilled' ? queueResult.value : null,
      statusError:
        statusResult.status === 'rejected'
          ? toMessage(statusResult.reason)
          : null,
      queueError:
        queueResult.status === 'rejected'
          ? toMessage(queueResult.reason)
          : null,
      loading: false,
    });
  }, []);

  // 首屏加载 + 30s 轮询（组件卸载即停）。
  React.useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const { status, queue, statusError, queueError, loading } = state;
  // 载荷防御：端点可能只返回部分字段（面板不该因此崩）。
  const pending = queue?.pending ?? [];
  const spaces = status?.spaces ?? [];
  const recentNotes = status?.recentNotes ?? [];
  // connection 同样防御：载荷缺该字段时整节不渲染（面板不该因此崩）。
  const connection = status?.connection ?? null;

  return (
    <div className="flex flex-col gap-3 p-3 text-foreground">
      {/* 标题行 */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">{t('panel.title')}</h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent"
            onClick={() => {
              void load();
            }}
          >
            {t('panel.refresh')}
          </button>
          {onClose ? (
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent"
              onClick={() => onClose()}
            >
              {t('panel.close')}
            </button>
          ) : null}
        </div>
      </div>

      {loading && status === null ? (
        <p className="text-[12px] text-muted-foreground">
          {t('panel.loading')}
        </p>
      ) : null}

      {statusError !== null ? (
        <p className="rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-destructive">
          {t('panel.unavailable')}
          {': '}
          {statusError}
        </p>
      ) : null}

      {queueError !== null ? (
        <p className="rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-destructive">
          {t('panel.unavailable')}
          {': '}
          {queueError}
        </p>
      ) : null}

      {/* ① 连接状态 */}
      {status !== null && connection !== null ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-[13px] font-semibold">{t('panel.connection')}</h3>
          <div className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <span>{t('panel.apiKey')}</span>
              <span>
                {connection.apiKeyConfigured
                  ? t('panel.apiKeyConfigured')
                  : t('panel.apiKeyMissing')}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>{t('panel.desktop')}</span>
              <span>
                {connection.authenticated
                  ? t('panel.connected')
                  : connection.reachable
                    ? t('panel.unauthenticated')
                    : t('panel.unreachable')}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>{t('panel.baseUrl')}</span>
              <span className="truncate">{connection.baseUrl}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>{t('panel.latency')}</span>
              <span>{connection.latencyMs} ms</span>
            </div>
            {connection.error !== null ? (
              <div className="text-muted-foreground">{connection.error}</div>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ② wiki 待审队列（只读） */}
      {queue !== null ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-[13px] font-semibold">{t('panel.queue')}</h3>
          {pending.length === 0 ? (
            <p className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-muted-foreground">
              {t('panel.queueEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {pending.map((note) => (
                <li
                  key={note.id}
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
                >
                  <div className="truncate">{note.name}</div>
                  <div className="text-muted-foreground">
                    {note.source !== null ? note.source : t('panel.noSource')}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* ③ 空间列表 */}
      {status !== null ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-[13px] font-semibold">{t('panel.spaces')}</h3>
          {spaces.length === 0 ? (
            <p className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-muted-foreground">
              {t('panel.spacesEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {spaces.map((space) => (
                <li
                  key={space.id}
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
                >
                  <div className="truncate">{space.name}</div>
                  <div className="truncate text-muted-foreground">
                    {space.id}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* ④ 最近笔记 */}
      {status !== null ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-[13px] font-semibold">{t('panel.recent')}</h3>
          {recentNotes.length === 0 ? (
            <p className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-muted-foreground">
              {t('panel.recentEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {recentNotes.map((note) => (
                <li
                  key={note.id}
                  className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
                >
                  <div className="truncate">{note.name}</div>
                  <div className="text-muted-foreground">
                    {note.status}
                    {note.updatedAt !== null ? ` · ${note.updatedAt}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {status !== null && status.warning !== null ? (
        <p className="text-[12px] text-muted-foreground">{status.warning}</p>
      ) : null}
    </div>
  );
}
