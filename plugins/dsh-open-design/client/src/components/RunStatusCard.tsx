/**
 * 运行状态卡：单次生成任务的状态机展示与轮询（系列 4/6）。
 *
 * 轮询策略（写死在此，宿主路由按 runId 单查）：
 * - 初始间隔 1500ms；连续 4 次状态未变化 → 间隔翻倍，6000ms 封顶；
 *   状态变化即重置回 1500ms（避免打爆 daemon）。
 * - 页面隐藏（visibilitychange=hidden）暂停轮询，恢复可见时立即拉一次。
 * - 终态（succeeded/failed/canceled）停止轮询。
 * - 取消语义如实呈现：点取消只代表「已请求取消」，终态以上游 get_run 为准。
 *
 * @module dsh-open-design/client/components/RunStatusCard
 */

import * as React from 'react';

import type { PanelApi, RunPayload } from '../api.ts';
import type { TFn } from '../types.ts';

/** 终态集合（到达即停止轮询）。 */
export const TERMINAL_RUN_STATUSES = new Set([
  'succeeded',
  'failed',
  'canceled',
]);

/** 初始轮询间隔。 */
export const DEFAULT_POLL_INTERVAL_MS = 1500;

/** 轮询间隔上限（退避封顶）。 */
export const MAX_POLL_INTERVAL_MS = 6000;

/** 连续多少次同状态后开始退避。 */
export const POLL_BACKOFF_STEPS = 4;

/** 状态文案键（未知状态回退到 run.status.unknown）。 */
const STATUS_KEYS: Record<string, string> = {
  queued: 'run.status.queued',
  running: 'run.status.running',
  succeeded: 'run.status.succeeded',
  failed: 'run.status.failed',
  canceled: 'run.status.canceled',
};

export interface RunStatusCardProps {
  t: TFn;
  api: PanelApi;
  runId: string;
  /** 轮询间隔（测试注入小值；默认 DEFAULT_POLL_INTERVAL_MS）。 */
  pollIntervalMs?: number;
  /** 初始载荷（恢复场景：已知上次状态立即渲染）。 */
  initial?: RunPayload | null;
  /** 到达终态时的回调（容器可据此清理会话存储中的 runId）。 */
  onTerminal?: (payload: RunPayload) => void;
}

/** 把上游 error 字段（字符串或对象）压成可读文本。 */
function describeError(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * 运行状态卡。
 *
 * @param props - runId、取数面与文案函数。
 */
export function RunStatusCard(props: RunStatusCardProps): React.ReactElement {
  const { t, api, runId } = props;
  const baseInterval = props.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const [payload, setPayload] = React.useState<RunPayload | null>(
    props.initial ?? null,
  );
  const [status, setStatus] = React.useState<string>(
    typeof props.initial?.status === 'string' ? props.initial.status : 'queued',
  );
  const [error, setError] = React.useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = React.useState(false);
  const [cancelError, setCancelError] = React.useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = React.useState(0);

  const startedAt = React.useRef(Date.now());
  const terminalRef = React.useRef(false);

  // 耗时计时（每秒一跳，终态后停）。
  React.useEffect(() => {
    const timer = setInterval(() => {
      if (!terminalRef.current) {
        setElapsedMs(Date.now() - startedAt.current);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // 轮询：状态变化重置间隔；隐藏暂停、可见立即刷新；终态停止。
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interval = baseInterval;
    let stableCount = 0;
    let lastStatus = status;

    const schedule = (delay: number): void => {
      timer = setTimeout(() => {
        void tick();
      }, delay);
    };

    const tick = async (): Promise<void> => {
      if (disposed || terminalRef.current) return;
      try {
        const data = await api.run(runId);
        if (disposed) return;
        setPayload(data);
        setError(null);
        const next = typeof data.status === 'string' ? data.status : lastStatus;
        if (next === lastStatus) {
          stableCount += 1;
        } else {
          stableCount = 0;
          lastStatus = next;
          interval = baseInterval;
        }
        setStatus(next);
        if (TERMINAL_RUN_STATUSES.has(next)) {
          terminalRef.current = true;
          setElapsedMs(Date.now() - startedAt.current);
          props.onTerminal?.(data);
          return;
        }
        if (stableCount >= POLL_BACKOFF_STEPS) {
          interval = Math.min(interval * 2, MAX_POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (disposed) return;
        // 单次失败不终止轮询：下一轮继续重试（daemon 可能正在重启）。
        setError(err instanceof Error ? err.message : String(err));
      }
      schedule(interval);
    };

    const onVisibilityChange = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return; // 隐藏：不请求，等可见。
      }
      void tick();
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    schedule(interval);

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [api, runId, baseInterval]);

  const cancel = async (): Promise<void> => {
    setCancelError(null);
    setCancelRequested(true);
    try {
      await api.cancelRun(runId);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    }
  };

  const statusKey = STATUS_KEYS[status] ?? 'run.status.unknown';
  const previewUrl =
    typeof payload?.previewUrl === 'string' ? payload.previewUrl : '';
  const agentMessage =
    typeof payload?.agentMessage === 'string' ? payload.agentMessage : '';
  const upstreamError = describeError(payload?.error);
  const isTerminal = TERMINAL_RUN_STATUSES.has(status);
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t('run.title')}</span>
        <span className="rounded border border-border px-1 text-[11px]">
          {t(statusKey)}
        </span>
      </div>
      <div className="break-all text-muted-foreground">{runId}</div>
      <div className="text-muted-foreground">
        {t('run.elapsed')}
        {': '}
        {seconds}
        {'s'}
      </div>
      {error !== null ? (
        <div className="break-all text-destructive">
          {t('run.error')}
          {': '}
          {error}
        </div>
      ) : null}
      {upstreamError !== '' ? (
        <div className="break-all text-destructive">
          {t('run.error')}
          {': '}
          {upstreamError}
        </div>
      ) : null}
      {cancelError !== null ? (
        <div className="break-all text-destructive">
          {t('run.cancelFailed')}
          {': '}
          {cancelError}
        </div>
      ) : null}
      {agentMessage !== '' ? (
        <details>
          <summary className="cursor-pointer text-muted-foreground">
            {t('run.agentMessage')}
          </summary>
          <p className="whitespace-pre-wrap break-words pt-1">{agentMessage}</p>
        </details>
      ) : null}
      {previewUrl !== '' ? (
        <a
          className="text-[12px] underline"
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('run.preview')}
        </a>
      ) : null}
      {!isTerminal ? (
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent"
            onClick={() => {
              void cancel();
            }}
            disabled={cancelRequested}
          >
            {t('run.cancel')}
          </button>
          {cancelRequested ? (
            <span className="text-muted-foreground">
              {t('run.cancelRequested')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
