import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DashboardData, DailyPoint } from '../../src/types.ts';

type Lang = 'zh' | 'en';
type ViewKey =
  'overview' | 'models' | 'tools' | 'projects' | 'sessions' | 'errors';
export type StatsRangeKey = '7d' | '30d' | '90d' | 'all';
type Theme = 'dark' | 'light';

/* ---------------- i18n ---------------- */

export const STRINGS = {
  zh: {
    brand: 'DSH 会话统计',
    subtitle: '本地会话文件 · 用量观测',
    navOverview: '概览',
    navModels: '模型',
    navTools: '工具',
    navProjects: '项目',
    navSessions: '会话',
    navErrors: '错误',
    viewHintOverview: '核心指标与每日用量趋势',
    viewHintModels: '按 provider/model 粒度的用量分布',
    viewHintTools: '工具调用排行与耗时',
    viewHintProjects: '按工作目录汇总',
    viewHintSessions: '最近的会话活动',
    viewHintErrors: 'LLM 重试与失败码分布',
    range7d: '7 天',
    range30d: '30 天',
    range90d: '90 天',
    rangeAll: '全部',
    sync: '同步',
    syncing: '同步中…',
    loading: '加载中…',
    loadFailed: '加载失败',
    syncDone: '同步完成',
    generatedAt: '生成于',
    justNow: '刚刚',
    minutesAgo: ' 分钟前',
    hoursAgo: ' 小时前',
    daysAgo: ' 天前',
    cardSessions: '会话数',
    cardProjectsSuffix: ' 个项目',
    cardTotalTokens: '总 Token（API 等价）',
    cardInputOutput: '输入 / 输出',
    cardCacheRead: '缓存读取',
    cardMessages: '消息数',
    cardTurnsSuffix: ' 轮 · ',
    cardStepsSuffix: ' 步',
    cardToolCalls: '工具调用',
    toolFailedSuffix: ' 次失败',
    allToolsOk: '全部成功',
    cardActiveDays: '活跃天数',
    cardDailyAvg: '日均 Token',
    cardLlmCallsPrefix: 'LLM 调用 ',
    cardCallsSuffix: ' 次',
    cardTopModel: 'Top 模型',
    cardTopTool: 'Top 工具',
    cardTopToolSub: '按调用次数',
    cardRetries: 'LLM 重试',
    seeErrors: '见错误视图',
    noRetries: '无重试',
    dailyChartTitle: '每日用量',
    dailyChartHint:
      '堆叠：缓存读取 / 输入 / 输出（账本补齐的历史日期带 • 标记）',
    legendCache: '缓存读取',
    legendInput: '输入',
    legendOutput: '输出',
    legendLedger: '账本补齐的历史日期',
    chartEmpty: '范围内没有用量数据 —— 点击「同步」索引最近活动。',
    tableEmpty: '暂无数据',
    thCalls: '调用',
    thInput: '输入',
    thOutput: '输出',
    thCacheRead: '缓存读',
    thCacheWrite: '缓存写',
    thTotal: '总量',
    thModel: '模型',
    thTool: '工具',
    thAvgDuration: '平均耗时',
    thTotalDuration: '累计耗时',
    thProject: '项目',
    thSessions: '会话',
    thMessages: '消息',
    thTokens: 'Token',
    thLastActive: '最后活跃',
    thTitle: '标题',
    thSpan: '跨度',
    thActive: '活跃',
    thCode: '失败码',
    thCount: '次数',
    thProvider: 'Provider',
    thTokenTotal: 'Token 总量',
    hourlyTitle: '小时分布',
    hourlyHint: 'LLM 调用的本地小时热度',
    hourlyTooltipPrefix: ':00 – ',
    hourlyTooltipSuffix: ' 次 LLM 调用',
    errorsTitle: 'LLM 重试 / 错误',
    errorsHint: 'llm/retry 失败码分布',
    errorsEmpty: '范围内没有重试记录',
    toolFailedNote: '（{n} 失败）',
    providersSub: '按 provider 汇总',
    exportRangeNote: '静态导出文件仅包含导出时所选范围的数据。',
    footer: 'dsh-session-stats · 数据来自本地 ~/.dsh 会话文件与 usage-ledger',
    themeTitle: '切换主题',
    langTitle: 'Language',
    openMenu: '打开菜单',
  },
  en: {
    brand: 'DSH Session Stats',
    subtitle: 'Local session files · usage insights',
    navOverview: 'Overview',
    navModels: 'Models',
    navTools: 'Tools',
    navProjects: 'Projects',
    navSessions: 'Sessions',
    navErrors: 'Errors',
    viewHintOverview: 'Key metrics and daily usage trend',
    viewHintModels: 'Usage breakdown by provider/model',
    viewHintTools: 'Tool call ranking and durations',
    viewHintProjects: 'Aggregated by working directory',
    viewHintSessions: 'Recent session activity',
    viewHintErrors: 'LLM retry and failure code distribution',
    range7d: '7d',
    range30d: '30d',
    range90d: '90d',
    rangeAll: 'All',
    sync: 'Sync',
    syncing: 'Syncing…',
    loading: 'Loading…',
    loadFailed: 'Load failed',
    syncDone: 'Sync done',
    generatedAt: 'generated',
    justNow: 'just now',
    minutesAgo: ' min ago',
    hoursAgo: ' h ago',
    daysAgo: ' d ago',
    cardSessions: 'Sessions',
    cardProjectsSuffix: ' projects',
    cardTotalTokens: 'Total Tokens (API-equiv.)',
    cardInputOutput: 'Input / Output',
    cardCacheRead: 'Cache Read',
    cardMessages: 'Messages',
    cardTurnsSuffix: ' turns · ',
    cardStepsSuffix: ' steps',
    cardToolCalls: 'Tool Calls',
    toolFailedSuffix: ' failed',
    allToolsOk: 'all succeeded',
    cardActiveDays: 'Active Days',
    cardDailyAvg: 'Daily Avg Tokens',
    cardLlmCallsPrefix: 'LLM calls ',
    cardCallsSuffix: '',
    cardTopModel: 'Top Model',
    cardTopTool: 'Top Tool',
    cardTopToolSub: 'by call count',
    cardRetries: 'LLM Retries',
    seeErrors: 'see Errors view',
    noRetries: 'no retries',
    dailyChartTitle: 'Daily Usage',
    dailyChartHint:
      'Stacked: cache read / input / output (• marks ledger-only history)',
    legendCache: 'Cache read',
    legendInput: 'Input',
    legendOutput: 'Output',
    legendLedger: 'ledger-only history',
    chartEmpty: 'No usage in this range — hit "Sync" to index recent activity.',
    tableEmpty: 'No data',
    thCalls: 'Calls',
    thInput: 'Input',
    thOutput: 'Output',
    thCacheRead: 'Cache read',
    thCacheWrite: 'Cache write',
    thTotal: 'Total',
    thModel: 'Model',
    thTool: 'Tool',
    thAvgDuration: 'Avg duration',
    thTotalDuration: 'Total duration',
    thProject: 'Project',
    thSessions: 'Sessions',
    thMessages: 'Messages',
    thTokens: 'Tokens',
    thLastActive: 'Last active',
    thTitle: 'Title',
    thSpan: 'Span',
    thActive: 'Active',
    thCode: 'Code',
    thCount: 'Count',
    thProvider: 'Provider',
    thTokenTotal: 'Token total',
    hourlyTitle: 'Peak Hours',
    hourlyHint: 'LLM calls by local hour of day',
    hourlyTooltipPrefix: ':00 – ',
    hourlyTooltipSuffix: ' LLM calls',
    errorsTitle: 'LLM Retries / Errors',
    errorsHint: 'llm/retry failure code distribution',
    errorsEmpty: 'No retries in this range',
    toolFailedNote: '({n} failed)',
    providersSub: 'aggregated by provider',
    exportRangeNote:
      'Static export embeds only the range selected at export time.',
    footer:
      'dsh-session-stats · data from local ~/.dsh session files and usage-ledger',
    themeTitle: 'Toggle theme',
    langTitle: 'Language',
    openMenu: 'Open menu',
  },
} as const;

export type StringKey = keyof (typeof STRINGS)['zh'];

export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem('dsh-stats-lang');
    if (stored === 'en' || stored === 'zh') return stored;
  } catch {
    /* ignore */
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/* ---------------- 格式化 ---------------- */

function fmtInt(value: number | undefined): string {
  return Number(value ?? 0).toLocaleString('en-US');
}

function fmtTokens(value: number | undefined): string {
  const n = Number(value ?? 0);
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return fmtInt(n);
}

function fmtDuration(ms: number | undefined): string {
  const n = Number(ms ?? 0);
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  if (n < 3_600_000) {
    const m = Math.floor(n / 60_000);
    const s = Math.round((n % 60_000) / 1000);
    return `${m}m${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(n / 3_600_000);
  const m = Math.round((n % 3_600_000) / 60_000);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

function fmtDateTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtAgo(ms: number, t: (key: StringKey) => string): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return t('justNow');
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}${t('minutesAgo')}`;
  if (diff < 86_400_000)
    return `${Math.floor(diff / 3_600_000)}${t('hoursAgo')}`;
  return `${Math.floor(diff / 86_400_000)}${t('daysAgo')}`;
}

/* ---------------- Tooltip ---------------- */

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

/** 坐标基于插件根元素(absolute 定位),嵌入模式不会飘出面板。 */
function tipFromEvent(
  event: { clientX: number; clientY: number },
  content: ReactNode,
  origin?: DOMRect | null,
): Tip {
  return {
    x: event.clientX - (origin?.left ?? 0) + 14,
    y: event.clientY - (origin?.top ?? 0) + 14,
    content,
  };
}

/* ---------------- 导航与范围 ---------------- */

const NAV_ITEMS: Array<{ key: ViewKey; icon: string; labelKey: StringKey }> = [
  { key: 'overview', icon: '◔', labelKey: 'navOverview' },
  { key: 'models', icon: '▦', labelKey: 'navModels' },
  { key: 'tools', icon: '⚙', labelKey: 'navTools' },
  { key: 'projects', icon: '▤', labelKey: 'navProjects' },
  { key: 'sessions', icon: '❯', labelKey: 'navSessions' },
  { key: 'errors', icon: '⚠', labelKey: 'navErrors' },
];

const RANGES: Array<[StatsRangeKey, StringKey]> = [
  ['7d', 'range7d'],
  ['30d', 'range30d'],
  ['90d', 'range90d'],
  ['all', 'rangeAll'],
];

function validView(key: string): ViewKey {
  return (
    NAV_ITEMS.some((item) => item.key === key) ? key : 'overview'
  ) as ViewKey;
}

function currentHashView(): ViewKey {
  return validView(window.location.hash.replace(/^#\/?/, ''));
}

function viewTitleKey(view: ViewKey): StringKey {
  const map: Record<ViewKey, StringKey> = {
    overview: 'navOverview',
    models: 'navModels',
    tools: 'navTools',
    projects: 'navProjects',
    sessions: 'navSessions',
    errors: 'navErrors',
  };
  return map[view];
}

function viewHintKey(view: ViewKey): StringKey {
  const map: Record<ViewKey, StringKey> = {
    overview: 'viewHintOverview',
    models: 'viewHintModels',
    tools: 'viewHintTools',
    projects: 'viewHintProjects',
    sessions: 'viewHintSessions',
    errors: 'viewHintErrors',
  };
  return map[view];
}

/* ---------------- 通用小组件 ---------------- */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>{title}</h2>
        {hint ? <span className="hint">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

interface Column {
  label: string;
  num?: boolean;
}

function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: Column[];
  rows: ReactNode[][];
  empty: string;
}) {
  if (rows.length === 0) return <div className="empty">{empty}</div>;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} className={c.num ? 'num' : ''}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i}>
              {cells.map((cell, j) => (
                <td key={j} className={columns[j]?.num ? 'num' : ''}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- 概览卡片 ---------------- */

function Cards({
  data,
  t,
}: {
  data: DashboardData;
  t: (key: StringKey) => string;
}) {
  const o = data.overview;
  const u = o.usage;
  const cards: Array<{ label: string; value: ReactNode; sub: ReactNode }> = [
    {
      label: t('cardSessions'),
      value: fmtInt(o.sessions),
      sub: `${fmtInt(o.projects)}${t('cardProjectsSuffix')}`,
    },
    {
      label: t('cardTotalTokens'),
      value: fmtTokens(u.totalTokens),
      sub: `${t('thInput')} ${fmtTokens(u.inputTokens)} · ${t('thOutput')} ${fmtTokens(u.outputTokens)} · ${t('thCacheRead')} ${fmtTokens(u.cacheReadTokens)} · ${t('thCacheWrite')} ${fmtTokens(u.cacheWriteTokens)}`,
    },
    {
      label: t('cardInputOutput'),
      value: `${fmtTokens(u.inputTokens)} / ${fmtTokens(u.outputTokens)}`,
      sub: `${t('thCacheRead')} ${fmtTokens(u.cacheReadTokens)} · ${t('thCacheWrite')} ${fmtTokens(u.cacheWriteTokens)}`,
    },
    {
      label: t('cardCacheRead'),
      value: fmtTokens(u.cacheReadTokens),
      sub: `${t('thCacheWrite')} ${fmtTokens(u.cacheWriteTokens)}`,
    },
    {
      label: t('cardMessages'),
      value: fmtInt(o.messages),
      sub: `${fmtInt(o.turns)}${t('cardTurnsSuffix')}${fmtInt(o.steps)}${t('cardStepsSuffix')}`,
    },
    {
      label: t('cardToolCalls'),
      value: fmtInt(o.toolCalls),
      sub:
        o.toolErrors > 0 ? (
          <span className="bad">
            {fmtInt(o.toolErrors)}
            {t('toolFailedSuffix')}
          </span>
        ) : (
          t('allToolsOk')
        ),
    },
    {
      label: t('cardActiveDays'),
      value: fmtInt(o.activeDays),
      sub: o.firstDay ? `${o.firstDay} ~ ${o.lastDay}` : '—',
    },
    {
      label: t('cardDailyAvg'),
      value: fmtTokens(o.avgTokensPerActiveDay),
      sub: `${t('cardLlmCallsPrefix')}${fmtInt(u.calls)}${t('cardCallsSuffix')}`,
    },
    {
      label: t('cardTopModel'),
      value: o.topModel ? o.topModel.split('/').slice(1).join('/') : '—',
      sub: o.topModel ? o.topModel.split('/')[0] : '',
    },
    {
      label: t('cardTopTool'),
      value: o.topTool ?? '—',
      sub: t('cardTopToolSub'),
    },
    {
      label: t('cardRetries'),
      value: fmtInt(o.retryCount),
      sub: o.retryCount > 0 ? t('seeErrors') : t('noRetries'),
    },
  ];
  return (
    <section className="cards">
      {cards.map((c) => (
        <div className="card" key={c.label}>
          <div className="label">{c.label}</div>
          <div className="value">{c.value}</div>
          <div className="sub">{c.sub}</div>
        </div>
      ))}
    </section>
  );
}

/* ---------------- 每日堆叠图 ---------------- */

const CHART_W = 1000;
const CHART_H = 240;
const PAD_L = 46;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 26;

function DailyChart({
  daily,
  t,
  setTip,
  getOrigin,
}: {
  daily: DailyPoint[];
  t: (key: StringKey) => string;
  setTip: (tip: Tip | null) => void;
  getOrigin: () => DOMRect | null;
}) {
  const geometry = useMemo(() => {
    const plotH = CHART_H - PAD_T - PAD_B;
    const maxTotal = Math.max(...daily.map((d) => d.totalTokens), 1);
    const y = (v: number): number => PAD_T + plotH - (v / maxTotal) * plotH;
    return { plotH, maxTotal, y };
  }, [daily]);

  if (daily.length === 0) {
    return <div className="empty">{t('chartEmpty')}</div>;
  }

  const { plotH, y } = geometry;
  const step = (CHART_W - PAD_L - PAD_R) / daily.length;
  const barW = Math.max(1, step * 0.72);
  const labelEvery = Math.max(1, Math.ceil(daily.length / 12));

  const gridLines: ReactNode[] = [];
  for (let gy = 0; gy <= 4; gy++) {
    const value = (geometry.maxTotal / 4) * gy;
    const yy = y(value);
    gridLines.push(
      <line
        key={gy}
        x1={PAD_L}
        y1={yy}
        x2={CHART_W - PAD_R}
        y2={yy}
        stroke="var(--border)"
        strokeWidth={1}
        strokeDasharray={gy === 0 ? undefined : '3 4'}
      />,
      <text
        key={`t${gy}`}
        x={PAD_L - 6}
        y={yy + 4}
        textAnchor="end"
        fontSize={10}
        fill="var(--text-dim)"
      >
        {fmtTokens(value)}
      </text>,
    );
  }

  const tipFor = (d: DailyPoint): ReactNode => (
    <>
      <b>{d.date}</b>
      {d.source === 'ledger' ? (
        <span className="warn"> ({t('legendLedger')})</span>
      ) : null}
      <br />
      {t('thTotal')} {fmtTokens(d.totalTokens)} · {t('thCalls')}{' '}
      {fmtInt(d.calls)}
      {d.sessions > 0
        ? ` · ${fmtInt(d.sessions)} ${t('navSessions').toLowerCase()}`
        : ''}
      <br />
      {t('thInput')} {fmtTokens(d.inputTokens)} · {t('thOutput')}{' '}
      {fmtTokens(d.outputTokens)}
      <br />
      {t('thCacheRead')} {fmtTokens(d.cacheReadTokens)} · {t('thCacheWrite')}{' '}
      {fmtTokens(d.cacheWriteTokens)}
    </>
  );

  return (
    <div className="daily-chart">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        role="img"
      >
        {gridLines}
        {daily.map((d, i) => {
          const cx = PAD_L + step * i + step / 2;
          const x0 = cx - barW / 2;
          const segs: Array<{ v: number; color: string; key: string }> = [
            { v: d.cacheReadTokens, color: 'var(--chart-cache)', key: 'cache' },
            { v: d.inputTokens, color: 'var(--chart-input)', key: 'input' },
            { v: d.outputTokens, color: 'var(--chart-output)', key: 'output' },
          ];
          let acc = 0;
          const bars = segs
            .filter((seg) => seg.v > 0)
            .map((seg) => {
              const y0 = y(acc + seg.v);
              const h = Math.max(1, y(acc) - y(acc + seg.v));
              acc += seg.v;
              return (
                <rect
                  key={seg.key}
                  x={x0}
                  y={y0}
                  width={barW}
                  height={h}
                  fill={seg.color}
                  rx={1}
                />
              );
            });
          return (
            <g key={d.date}>
              {bars}
              {i % labelEvery === 0 ? (
                <text
                  x={cx}
                  y={CHART_H - 8}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--text-dim)"
                >
                  {d.date.slice(5)}
                </text>
              ) : null}
              {d.source === 'ledger' ? (
                <circle
                  cx={cx}
                  cy={y(d.totalTokens) - 6}
                  r={2.5}
                  fill="var(--warn)"
                />
              ) : null}
              <rect
                className="hit"
                x={x0 - 1}
                y={PAD_T}
                width={barW + 2}
                height={plotH}
                fill="transparent"
                onMouseEnter={(e) =>
                  setTip(tipFromEvent(e, tipFor(d), getOrigin()))
                }
                onMouseMove={(e) =>
                  setTip(tipFromEvent(e, tipFor(d), getOrigin()))
                }
                onMouseLeave={() => setTip(null)}
              />
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span>
          <span className="dot" style={{ background: 'var(--chart-cache)' }} />
          {t('legendCache')}
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--chart-input)' }} />
          {t('legendInput')}
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--chart-output)' }} />
          {t('legendOutput')}
        </span>
        <span>
          <span
            className="dot"
            style={{ background: 'var(--warn)', borderRadius: '50%' }}
          />
          {t('legendLedger')}
        </span>
      </div>
    </div>
  );
}

/* ---------------- 小时热力 ---------------- */

function HourlyHeat({
  hourly,
  t,
  setTip,
  getOrigin,
}: {
  hourly: number[];
  t: (key: StringKey) => string;
  setTip: (tip: Tip | null) => void;
  getOrigin: () => DOMRect | null;
}) {
  const max = Math.max(...hourly, 1);
  return (
    <div className="hourly-heat">
      {hourly.map((v, hour) => {
        const intensity = v / max;
        const style =
          v > 0
            ? {
                background: `color-mix(in srgb, var(--accent) ${Math.round(15 + intensity * 85)}%, transparent)`,
                color: intensity > 0.5 ? '#fff' : 'var(--text-dim)',
              }
            : undefined;
        const content = `${String(hour).padStart(2, '0')}${t('hourlyTooltipPrefix')}${fmtInt(v)}${t('hourlyTooltipSuffix')}`;
        return (
          <div
            key={hour}
            className="hour-cell"
            style={style}
            onMouseEnter={(e) => setTip(tipFromEvent(e, content, getOrigin()))}
            onMouseMove={(e) => setTip(tipFromEvent(e, content, getOrigin()))}
            onMouseLeave={() => setTip(null)}
          >
            {hour}
          </div>
        );
      })}
    </div>
  );
}

function ProviderTable({
  data,
  t,
}: {
  data: DashboardData;
  t: (key: StringKey) => string;
}) {
  const max = Math.max(...data.providers.map((p) => p.totalTokens), 1);
  return (
    <DataTable
      empty={t('tableEmpty')}
      columns={[
        { label: t('thProvider') },
        { label: t('thCalls'), num: true },
        { label: t('thTokenTotal'), num: true },
      ]}
      rows={data.providers.map((p) => {
        const pct = ((p.totalTokens / max) * 100).toFixed(1);
        return [
          <span className="mono" key="k">
            {p.provider}
          </span>,
          fmtInt(p.calls),
          <span key="t">
            {fmtTokens(p.totalTokens)} <span className="dim">({pct}%)</span>
            <span className="share-bar">
              <span
                style={{ display: 'block', height: '100%', width: `${pct}%` }}
              />
            </span>
          </span>,
        ];
      })}
    />
  );
}

/* ---------------- 仪表盘主组件 ---------------- */

export interface StatsDashboardProps {
  /** 仪表盘数据端点（同源绝对路径）。 */
  dataBase: string;
  /** 同步端点（POST）。 */
  syncBase: string;
  /** 独立页模式：hash 视图路由、?lang= 参数、document.title 跟随。 */
  standalone?: boolean;
  /** 内嵌数据（静态导出）。 */
  initialData?: DashboardData | null;
  initialRange?: StatsRangeKey;
  initialLang?: Lang;
  /** 是否显示侧栏（内嵌窄视图可关闭）。默认显示。 */
  showSidebar?: boolean;
}

function detectTheme(): Theme {
  try {
    const stored = localStorage.getItem('dsh-stats-theme');
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* ignore */
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

export function StatsDashboard(props: StatsDashboardProps): ReactNode {
  const { dataBase, syncBase, standalone = false, showSidebar = true } = props;
  const embedded = props.initialData ?? null;
  const [lang, setLang] = useState<Lang>(
    () => props.initialLang ?? detectLang(),
  );
  const [theme, setTheme] = useState<Theme>(() => detectTheme());
  const [view, setView] = useState<ViewKey>(() =>
    standalone && typeof window !== 'undefined'
      ? currentHashView()
      : 'overview',
  );
  const [range, setRange] = useState<StatsRangeKey>(
    props.initialRange ?? '30d',
  );
  const [data, setData] = useState<DashboardData | null>(embedded);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const getRootRect = useCallback(
    (): DOMRect | null => rootRef.current?.getBoundingClientRect() ?? null,
    [],
  );
  const isEmbedded = embedded !== null;
  const t = useCallback((key: StringKey) => STRINGS[lang][key], [lang]);

  useEffect(() => {
    if (!standalone) return;
    document.documentElement.lang = lang;
    document.title = STRINGS[lang].brand;
  }, [lang, standalone]);

  useEffect(() => {
    try {
      localStorage.setItem('dsh-stats-lang', lang);
    } catch {
      /* ignore */
    }
  }, [lang]);

  useEffect(() => {
    if (!standalone) return;
    const onHash = (): void => setView(currentHashView());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [standalone]);

  const loadStats = useCallback(
    async (rangeKey: StatsRangeKey) => {
      setError(null);
      try {
        const res = await fetch(
          `${dataBase}?range=${encodeURIComponent(rangeKey)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setData((await res.json()) as DashboardData);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [dataBase],
  );

  const changeRange = useCallback(
    (key: StatsRangeKey) => {
      setRange(key);
      if (isEmbedded) {
        setStatus(STRINGS[lang].exportRangeNote);
        return;
      }
      void loadStats(key);
    },
    [isEmbedded, lang, loadStats],
  );

  const doSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch(syncBase, { method: 'POST' });
      const result = (await res.json()) as {
        files: number;
        processed: number;
        sessions: number;
        durationMs: number;
      };
      setStatus(
        `${STRINGS[lang].syncDone}: ${result.files} / ${result.processed} / ${result.sessions} (${result.durationMs}ms)`,
      );
      await loadStats(range);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [lang, loadStats, range, syncBase]);

  useEffect(() => {
    if (embedded) return;
    void loadStats(range);
    // 仅首次挂载取数，切换范围走 changeRange。
  }, []);

  const toggleTheme = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try {
      localStorage.setItem('dsh-stats-theme', next);
    } catch {
      /* ignore */
    }
    if (standalone) document.documentElement.dataset.theme = next;
  }, [standalone, theme]);

  const navigate = useCallback(
    (key: ViewKey) => {
      if (standalone) window.location.hash = `#/${key}`;
      setView(key);
      setDrawerOpen(false);
    },
    [standalone],
  );

  const o = data?.overview;

  return (
    <div
      ref={rootRef}
      className={`dss-scope${standalone ? '' : ' dss-embedded'}${drawerOpen ? ' drawer-open' : ''}`}
      data-theme={theme}
    >
      <div className="app">
        {showSidebar ? (
          <aside className="sidebar">
            <div className="brand">
              <span className="brand-icon">◈</span>
              <span className="brand-text">
                {t('brand')}
                <small>{t('subtitle')}</small>
              </span>
            </div>
            <nav className="nav">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={`nav-item${view === item.key ? ' active' : ''}`}
                  onClick={() => navigate(item.key)}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span>{t(item.labelKey)}</span>
                </button>
              ))}
            </nav>
            <div className="sidebar-footer">
              <div className="lang-switch" title={t('langTitle')}>
                <button
                  type="button"
                  className={lang === 'zh' ? 'active' : ''}
                  onClick={() => setLang('zh')}
                >
                  中文
                </button>
                <button
                  type="button"
                  className={lang === 'en' ? 'active' : ''}
                  onClick={() => setLang('en')}
                >
                  EN
                </button>
              </div>
              <button
                className="btn full"
                type="button"
                title={t('themeTitle')}
                onClick={toggleTheme}
              >
                ◐ {t('themeTitle')}
              </button>
            </div>
          </aside>
        ) : null}
        <button
          type="button"
          className="scrim"
          aria-label={t('openMenu')}
          onClick={() => setDrawerOpen(false)}
        />

        <main className="main">
          <header className="topbar">
            <div className="topbar-title">
              <h1>{t(viewTitleKey(view))}</h1>
              <span className="subtitle">{t(viewHintKey(view))}</span>
            </div>
            <div className="topbar-actions">
              <button
                type="button"
                className="btn icon menu-btn"
                aria-label={t('openMenu')}
                title={t('openMenu')}
                onClick={() => setDrawerOpen(true)}
              >
                ☰
              </button>
              <div className="range-tabs" role="tablist">
                {RANGES.map(([key, labelKey]) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    className={range === key ? 'active' : ''}
                    onClick={() => changeRange(key)}
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
              {isEmbedded ? null : (
                <button
                  className="btn"
                  type="button"
                  disabled={syncing}
                  onClick={() => void doSync()}
                >
                  {syncing ? t('syncing') : t('sync')}
                </button>
              )}
            </div>
          </header>

          <div className="meta-line">
            {error ? (
              <span className="bad">
                {t('loadFailed')}: {error}
              </span>
            ) : (
              <>
                {status}
                {data && o
                  ? `${status ? ' · ' : ''}${t('generatedAt')} ${fmtDateTime(data.generatedAt)} · ${fmtAgo(data.generatedAt, t)}`
                  : !status
                    ? t('loading')
                    : ''}
              </>
            )}
          </div>

          {data && o ? (
            <>
              {view === 'overview' ? (
                <>
                  <Cards data={data} t={t} />
                  <Section
                    title={t('dailyChartTitle')}
                    hint={t('dailyChartHint')}
                  >
                    <DailyChart
                      daily={data.daily}
                      t={t}
                      setTip={setTip}
                      getOrigin={getRootRect}
                    />
                  </Section>
                  <Section title={t('hourlyTitle')} hint={t('hourlyHint')}>
                    <HourlyHeat
                      hourly={data.hourly}
                      t={t}
                      setTip={setTip}
                      getOrigin={getRootRect}
                    />
                  </Section>
                </>
              ) : null}

              {view === 'models' ? (
                <>
                  <Section title={t('navModels')} hint={t('viewHintModels')}>
                    <DataTable
                      empty={t('tableEmpty')}
                      columns={[
                        { label: t('thModel') },
                        { label: t('thCalls'), num: true },
                        { label: t('thInput'), num: true },
                        { label: t('thOutput'), num: true },
                        { label: t('thCacheRead'), num: true },
                        { label: t('thTotal'), num: true },
                      ]}
                      rows={data.models.map((m) => [
                        <span className="mono" key="k">
                          {m.provider}/{m.model}
                        </span>,
                        fmtInt(m.calls),
                        fmtTokens(m.inputTokens),
                        fmtTokens(m.outputTokens),
                        fmtTokens(m.cacheReadTokens),
                        fmtTokens(m.totalTokens),
                      ])}
                    />
                  </Section>
                  <Section title={t('thProvider')} hint={t('providersSub')}>
                    <ProviderTable data={data} t={t} />
                  </Section>
                </>
              ) : null}

              {view === 'tools' ? (
                <Section title={t('navTools')} hint={t('viewHintTools')}>
                  <DataTable
                    empty={t('tableEmpty')}
                    columns={[
                      { label: t('thTool') },
                      { label: t('thCalls'), num: true },
                      { label: t('thAvgDuration'), num: true },
                      { label: t('thTotalDuration'), num: true },
                    ]}
                    rows={data.tools.map((tool) => [
                      <span className="mono" key="k">
                        {tool.name}
                      </span>,
                      fmtInt(tool.calls),
                      fmtDuration(tool.avgDurationMs),
                      <>
                        {fmtDuration(tool.totalDurationMs)}
                        {tool.errors > 0 ? (
                          <span className="bad">
                            {t('toolFailedNote').replace(
                              '{n}',
                              String(tool.errors),
                            )}
                          </span>
                        ) : null}
                      </>,
                    ])}
                  />
                </Section>
              ) : null}

              {view === 'projects' ? (
                <Section title={t('navProjects')} hint={t('viewHintProjects')}>
                  <DataTable
                    empty={t('tableEmpty')}
                    columns={[
                      { label: t('thProject') },
                      { label: t('thSessions'), num: true },
                      { label: t('thMessages'), num: true },
                      { label: t('thTokens'), num: true },
                      { label: t('thLastActive'), num: true },
                    ]}
                    rows={data.projects.map((p) => [
                      p.project,
                      fmtInt(p.sessions),
                      fmtInt(p.messages),
                      fmtTokens(p.usage.totalTokens),
                      <span className="dim" key="k">
                        {fmtAgo(p.lastActiveAt, t)}
                      </span>,
                    ])}
                  />
                </Section>
              ) : null}

              {view === 'sessions' ? (
                <Section title={t('navSessions')} hint={t('viewHintSessions')}>
                  <DataTable
                    empty={t('tableEmpty')}
                    columns={[
                      { label: t('thTitle') },
                      { label: t('thProject') },
                      { label: t('thModel') },
                      { label: t('thMessages'), num: true },
                      { label: t('navTools'), num: true },
                      { label: t('thTokens'), num: true },
                      { label: t('thSpan'), num: true },
                      { label: t('thActive'), num: true },
                    ]}
                    rows={data.recent.map((s) => [
                      <span key="k" title={s.id}>
                        {s.title}
                      </span>,
                      s.project,
                      <span className="mono" key="m">
                        {s.model}
                      </span>,
                      fmtInt(s.messages),
                      fmtInt(s.toolCalls),
                      fmtTokens(s.usage.totalTokens),
                      fmtDuration(s.activeMs),
                      <span
                        className="dim"
                        key="a"
                        title={fmtDateTime(s.lastActiveAt)}
                      >
                        {fmtAgo(s.lastActiveAt, t)}
                      </span>,
                    ])}
                  />
                </Section>
              ) : null}

              {view === 'errors' ? (
                <Section title={t('errorsTitle')} hint={t('errorsHint')}>
                  <DataTable
                    empty={t('errorsEmpty')}
                    columns={[
                      { label: t('thCode') },
                      { label: t('thCount'), num: true },
                    ]}
                    rows={data.errors.map((e) => [
                      <span className="mono" key="k">
                        {e.code}
                      </span>,
                      fmtInt(e.count),
                    ])}
                  />
                </Section>
              ) : null}
            </>
          ) : null}

          <footer className="footer">{t('footer')}</footer>
        </main>
      </div>

      {tip ? (
        <div
          className="tooltip"
          style={{
            left: Math.max(
              8,
              Math.min(
                tip.x,
                (rootRef.current?.clientWidth ?? window.innerWidth) - 340,
              ),
            ),
            top: Math.max(8, tip.y),
          }}
        >
          {tip.content}
        </div>
      ) : null}
    </div>
  );
}
