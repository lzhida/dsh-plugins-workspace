/**
 * 连接状态节：诊断快照（/status）的只读展示。
 *
 * 字段与 src/diag-tools.ts 的 DiagnosticReport 一一对应；env 值宿主侧已
 * 脱敏（凭据键 → <redacted>），本节不展示 env（内容属配置卡职责）。
 *
 * @module dsh-open-design/client/components/StatusSection
 */

import * as React from 'react';

import type { DiagnosticReport } from '../api.ts';
import type { TFn } from '../types.ts';

/** 连接状态文案键（宿主连接状态机的五个稳定态）。 */
const CONNECTION_KEYS: Record<string, string> = {
  connected: 'connection.connected',
  connecting: 'connection.connecting',
  reconnecting: 'connection.reconnecting',
  failed: 'connection.failed',
  closed: 'connection.closed',
};

/** 单行（label + value）。 */
function Row(props: { t: TFn; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-[12px] text-muted-foreground">
        {props.t(props.label)}
      </span>
      <span className="max-w-[65%] break-all text-right text-[12px]">
        {props.children}
      </span>
    </div>
  );
}

/** 状态节 props。 */
export interface StatusSectionProps {
  t: TFn;
  report: DiagnosticReport | null;
  error: string | null;
  loading: boolean;
  /** 重新检测进行中（按钮禁用与文案切换）。 */
  busy: boolean;
  onRetry: () => void;
  onRedetect: () => void;
}

/**
 * 连接状态节。
 *
 * @param props - 展示数据与回调（容器层集中取数后下发）。
 */
export function StatusSection(props: StatusSectionProps): React.ReactElement {
  const { t, report, error, loading, busy, onRetry, onRedetect } = props;

  if (error !== null) {
    return (
      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold">{t('status.title')}</h3>
        <p className="rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-destructive">
          {t('panel.unavailable')}
          {': '}
          {error}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent"
            onClick={onRetry}
          >
            {t('panel.retry')}
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent"
            onClick={onRedetect}
            disabled={busy}
          >
            {busy ? t('panel.redetecting') : t('panel.redetect')}
          </button>
        </div>
      </section>
    );
  }

  if (loading && report === null) {
    return (
      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold">{t('status.title')}</h3>
        <p className="text-[12px] text-muted-foreground">
          {t('panel.loading')}
        </p>
      </section>
    );
  }

  if (report === null) {
    return (
      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold">{t('status.title')}</h3>
        <p className="text-[12px] text-muted-foreground">{t('focus.idle')}</p>
      </section>
    );
  }

  const connectionKey = CONNECTION_KEYS[report.connectionState];
  const skipped = report.upstreamSkippedTools ?? [];

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[13px] font-semibold">{t('status.title')}</h3>
      <div className="flex flex-col gap-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]">
        <Row t={t} label="status.connection">
          {connectionKey === undefined
            ? report.connectionState
            : t(connectionKey)}
        </Row>
        <Row t={t} label="status.method">
          {report.detectionMethod === 'none'
            ? t('status.none')
            : report.detectionMethod}
        </Row>
        <Row t={t} label="status.endpoint">
          {report.endpoint === '' ? '—' : report.endpoint}
        </Row>
        <Row t={t} label="status.installDir">
          {report.installDir === '' ? '—' : report.installDir}
        </Row>
        <Row t={t} label="status.tools">
          {report.upstreamToolCount}
        </Row>
        <Row t={t} label="status.skipped">
          {skipped.length === 0
            ? '0'
            : `${skipped.length} (${skipped.join(', ')})`}
        </Row>
        {report.lastError !== null && report.lastError !== '' ? (
          <div className="break-all text-muted-foreground">
            {t('status.lastError')}
            {': '}
            {report.lastError}
          </div>
        ) : null}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent"
            onClick={onRedetect}
            disabled={busy}
          >
            {busy ? t('panel.redetecting') : t('panel.redetect')}
          </button>
        </div>
      </div>
    </section>
  );
}
