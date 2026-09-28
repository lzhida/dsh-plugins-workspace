import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { DashboardData, DailyPoint } from '../../src/types.ts';

/** export 模式内嵌数据;serve 模式为 null。 */
declare global {
  interface Window {
    __STATS_DATA__?: DashboardData | null;
  }
}

const RANGES: Array<[StatsRangeKey, string]> = [
  ['7d', '7 天'],
  ['30d', '30 天'],
  ['90d', '90 天'],
  ['all', '全部'],
];
type StatsRangeKey = '7d' | '30d' | '90d' | 'all';

/* ---------------- 格式化 ---------------- */

function fmtInt(value: number | undefined): string {
  return Number(value ?? 0).toLocaleString('zh-CN');
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

function fmtAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

/* ---------------- Tooltip ---------------- */

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function tipFromEvent(
  event: { clientX: number; clientY: number },
  content: ReactNode,
): Tip {
  return { x: event.clientX + 14, y: event.clientY + 14, content };
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
  );
}

/* ---------------- 概览卡片 ---------------- */

function Cards({ data }: { data: DashboardData }) {
  const o = data.overview;
  const u = o.usage;
  const cards: Array<{ label: string; value: ReactNode; sub: ReactNode }> = [
    {
      label: '会话数',
      value: fmtInt(o.sessions),
      sub: `${fmtInt(o.projects)} 个项目`,
    },
    {
      label: '总 Token（API 等价）',
      value: fmtTokens(u.totalTokens),
      sub: `输入 ${fmtTokens(u.inputTokens)} · 输出 ${fmtTokens(u.outputTokens)} · 缓存读 ${fmtTokens(u.cacheReadTokens)} · 缓存写 ${fmtTokens(u.cacheWriteTokens)}`,
    },
    {
      label: '输入 / 输出',
      value: `${fmtTokens(u.inputTokens)} / ${fmtTokens(u.outputTokens)}`,
      sub: `推理 ${fmtTokens(u.reasoningTokens)}`,
    },
    {
      label: '缓存读取',
      value: fmtTokens(u.cacheReadTokens),
      sub: `缓存写 ${fmtTokens(u.cacheWriteTokens)}`,
    },
    {
      label: '消息数',
      value: fmtInt(o.messages),
      sub: `${fmtInt(o.turns)} 轮 · ${fmtInt(o.steps)} 步`,
    },
    {
      label: '工具调用',
      value: fmtInt(o.toolCalls),
      sub: o.toolErrors > 0 ? `${fmtInt(o.toolErrors)} 次失败` : '全部成功',
    },
    {
      label: '活跃天数',
      value: fmtInt(o.activeDays),
      sub: o.firstDay ? `${o.firstDay} ~ ${o.lastDay}` : '—',
    },
    {
      label: '日均 Token',
      value: fmtTokens(o.avgTokensPerActiveDay),
      sub: `LLM 调用 ${fmtInt(u.calls)} 次`,
    },
    {
      label: 'Top 模型',
      value: o.topModel ? o.topModel.split('/').slice(1).join('/') : '—',
      sub: o.topModel ? o.topModel.split('/')[0] : '',
    },
    { label: 'Top 工具', value: o.topTool ?? '—', sub: '按调用次数' },
    {
      label: 'LLM 重试',
      value: fmtInt(o.retryCount),
      sub: o.retryCount > 0 ? '见底部错误分布' : '无重试',
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
  setTip,
}: {
  daily: DailyPoint[];
  setTip: (tip: Tip | null) => void;
}) {
  const geometry = useMemo(() => {
    const plotH = CHART_H - PAD_T - PAD_B;
    const maxTotal = Math.max(...daily.map((d) => d.totalTokens), 1);
    const y = (v: number): number => PAD_T + plotH - (v / maxTotal) * plotH;
    return { plotH, maxTotal, y };
  }, [daily]);

  if (daily.length === 0) {
    return (
      <div className="empty">
        范围内没有用量数据 —— 点击「同步」索引最近活动。
      </div>
    );
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
      {d.source === 'ledger' ? <span className="warn">（账本）</span> : null}
      <br />总 {fmtTokens(d.totalTokens)} · 调用 {fmtInt(d.calls)} 次
      {d.sessions > 0 ? ` · ${fmtInt(d.sessions)} 会话` : ''}
      <br />
      输入 {fmtTokens(d.inputTokens)} · 输出 {fmtTokens(d.outputTokens)}
      <br />
      缓存读 {fmtTokens(d.cacheReadTokens)} · 缓存写{' '}
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
                onMouseEnter={(e) => setTip(tipFromEvent(e, tipFor(d)))}
                onMouseMove={(e) => setTip(tipFromEvent(e, tipFor(d)))}
                onMouseLeave={() => setTip(null)}
              />
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span>
          <span className="dot" style={{ background: 'var(--chart-cache)' }} />
          缓存读取
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--chart-input)' }} />
          输入
        </span>
        <span>
          <span className="dot" style={{ background: 'var(--chart-output)' }} />
          输出
        </span>
        <span>
          <span
            className="dot"
            style={{ background: 'var(--warn)', borderRadius: '50%' }}
          />
          账本补齐的历史日期
        </span>
      </div>
    </div>
  );
}

/* ---------------- 小时热力 ---------------- */

function HourlyHeat({
  hourly,
  setTip,
}: {
  hourly: number[];
  setTip: (tip: Tip | null) => void;
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
        return (
          <div
            key={hour}
            className="hour-cell"
            style={style}
            onMouseEnter={(e) =>
              setTip(
                tipFromEvent(
                  e,
                  `${String(hour).padStart(2, '0')}:00 – ${fmtInt(v)} 次 LLM 调用`,
                ),
              )
            }
            onMouseMove={(e) =>
              setTip(
                tipFromEvent(
                  e,
                  `${String(hour).padStart(2, '0')}:00 – ${fmtInt(v)} 次 LLM 调用`,
                ),
              )
            }
            onMouseLeave={() => setTip(null)}
          >
            {hour}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- App ---------------- */

function App() {
  const embedded =
    typeof window !== 'undefined' && window.__STATS_DATA__
      ? window.__STATS_DATA__
      : null;
  const [range, setRange] = useState<StatsRangeKey>(
    embedded ? (embedded.range as StatsRangeKey) : '30d',
  );
  const [data, setData] = useState<DashboardData | null>(embedded);
  const [status, setStatus] = useState<string>(embedded ? '' : '加载中…');
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const isEmbedded = embedded !== null;

  const loadStats = useCallback(async (rangeKey: StatsRangeKey) => {
    setStatus('加载中…');
    setError(null);
    try {
      const res = await fetch(
        `/api/stats?range=${encodeURIComponent(rangeKey)}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as DashboardData);
      setStatus('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const changeRange = useCallback(
    (key: StatsRangeKey) => {
      setRange(key);
      if (isEmbedded) {
        setStatus('静态导出文件仅包含导出时所选范围的数据。');
        return;
      }
      void loadStats(key);
    },
    [isEmbedded, loadStats],
  );

  const doSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/sync');
      const result = (await res.json()) as {
        files: number;
        processed: number;
        sessions: number;
        durationMs: number;
      };
      setStatus(
        `同步完成：${result.files} 文件 / ${result.processed} 重解码 / ${result.sessions} 会话（${result.durationMs}ms）`,
      );
      await loadStats(range);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }, [loadStats, range]);

  useEffect(() => {
    if (!isEmbedded) void loadStats(range);
    // 仅首次挂载取数，切换范围走 changeRange。
  }, []);

  const toggleTheme = useCallback(() => {
    const next =
      document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('dsh-stats-theme', next);
    } catch {
      /* 忽略存储失败 */
    }
  }, []);

  const o = data?.overview;

  return (
    <>
      <header className="topbar">
        <div className="topbar-title">
          <h1>DSH 会话统计</h1>
          <span className="subtitle">本地会话文件 · 用量观测面板</span>
        </div>
        <div className="topbar-actions">
          <div className="range-tabs" role="tablist">
            {RANGES.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                className={range === key ? 'active' : ''}
                onClick={() => changeRange(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {isEmbedded ? null : (
            <button
              id="sync-btn"
              className="btn"
              type="button"
              disabled={syncing}
              onClick={() => void doSync()}
            >
              {syncing ? '同步中…' : '同步'}
            </button>
          )}
          <button
            className="btn icon"
            type="button"
            title="切换主题"
            onClick={toggleTheme}
          >
            ◐
          </button>
        </div>
      </header>

      <div className="meta-line">
        {error ? (
          <span className="bad">加载失败: {error}</span>
        ) : (
          status || (data ? `范围 ${range}` : '加载中…')
        )}
        {data && o
          ? ` · ${o.sessions} 会话 · 生成于 ${fmtDateTime(data.generatedAt)}（${fmtAgo(data.generatedAt)}）`
          : ''}
      </div>

      <main className="content">
        {data && o ? (
          <>
            <Cards data={data} />
            <Section
              title="每日用量"
              hint="堆叠：缓存读取 / 输入 / 输出（账本补齐的历史日期带 • 标记）"
            >
              <DailyChart daily={data.daily} setTip={setTip} />
            </Section>
            <div className="grid-2">
              <Section title="模型" hint="按 API 等价总量排序">
                <DataTable
                  empty="暂无数据"
                  columns={[
                    { label: '模型' },
                    { label: '调用', num: true },
                    { label: '输入', num: true },
                    { label: '输出', num: true },
                    { label: '缓存读', num: true },
                    { label: '总量', num: true },
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
              <div>
                <Section title="Provider" hint="按 provider 汇总">
                  <ProviderTable data={data} />
                </Section>
                <Section title="小时分布" hint="LLM 调用的本地小时热度">
                  <HourlyHeat hourly={data.hourly} setTip={setTip} />
                </Section>
              </div>
            </div>
            <div className="grid-2">
              <Section title="工具调用" hint="最常用优先">
                <DataTable
                  empty="暂无数据"
                  columns={[
                    { label: '工具' },
                    { label: '调用', num: true },
                    { label: '平均耗时', num: true },
                    { label: '累计耗时', num: true },
                  ]}
                  rows={data.tools.map((t) => [
                    <span className="mono" key="k">
                      {t.name}
                    </span>,
                    fmtInt(t.calls),
                    fmtDuration(t.avgDurationMs),
                    <>
                      {fmtDuration(t.totalDurationMs)}
                      {t.errors > 0 ? (
                        <span className="bad">（{t.errors} 失败）</span>
                      ) : null}
                    </>,
                  ])}
                />
              </Section>
              <Section title="项目" hint="按工作目录汇总">
                <DataTable
                  empty="暂无数据"
                  columns={[
                    { label: '项目' },
                    { label: '会话', num: true },
                    { label: '消息', num: true },
                    { label: 'Token', num: true },
                    { label: '最后活跃', num: true },
                  ]}
                  rows={data.projects.map((p) => [
                    p.project,
                    fmtInt(p.sessions),
                    fmtInt(p.messages),
                    fmtTokens(p.usage.totalTokens),
                    <span className="dim" key="k">
                      {fmtAgo(p.lastActiveAt)}
                    </span>,
                  ])}
                />
              </Section>
            </div>
            <Section title="最近会话" hint="按最后活跃时间排序">
              <DataTable
                empty="暂无数据"
                columns={[
                  { label: '标题' },
                  { label: '项目' },
                  { label: '模型' },
                  { label: '消息', num: true },
                  { label: '工具', num: true },
                  { label: 'Token', num: true },
                  { label: '跨度', num: true },
                  { label: '活跃', num: true },
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
                    {fmtAgo(s.lastActiveAt)}
                  </span>,
                ])}
              />
            </Section>
            {data.errors.length > 0 ? (
              <Section title="LLM 重试 / 错误" hint="llm/retry 失败码分布">
                <DataTable
                  empty="无重试记录"
                  columns={[{ label: '失败码' }, { label: '次数', num: true }]}
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
      </main>

      <footer className="footer">
        dsh-session-stats · 数据来自本地 ~/.dsh 会话文件与 usage-ledger
      </footer>

      {tip ? (
        <div
          className="tooltip"
          style={{
            left: Math.max(8, Math.min(tip.x, window.innerWidth - 340)),
            top: Math.max(8, tip.y),
          }}
        >
          {tip.content}
        </div>
      ) : null}
    </>
  );
}

function ProviderTable({ data }: { data: DashboardData }) {
  const max = Math.max(...data.providers.map((p) => p.totalTokens), 1);
  return (
    <DataTable
      empty="暂无数据"
      columns={[
        { label: 'Provider' },
        { label: '调用', num: true },
        { label: 'Token 总量', num: true },
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

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
