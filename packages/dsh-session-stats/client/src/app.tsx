import { createRoot } from 'react-dom/client';
import { detectLang, StatsDashboard } from './dashboard.tsx';
import type { StatsRangeKey } from './dashboard.tsx';
import type { DashboardData } from '../../src/types.ts';

/** 独立页模式（serve/export）：创建根节点并复用共享仪表盘组件。 */
declare global {
  interface Window {
    __STATS_DATA__?: DashboardData | null;
  }
}

function langFromUrl(): ReturnType<typeof detectLang> | undefined {
  const fromUrl = new URLSearchParams(window.location.search).get('lang');
  return fromUrl === 'en' || fromUrl === 'zh' ? fromUrl : undefined;
}

const rootEl = document.getElementById('root') as HTMLElement;
const embedded =
  typeof window !== 'undefined' && window.__STATS_DATA__
    ? window.__STATS_DATA__
    : null;

createRoot(rootEl).render(
  <StatsDashboard
    dataBase="/api/stats"
    syncBase="/api/sync"
    standalone
    initialData={embedded}
    initialRange={embedded ? (embedded.range as StatsRangeKey) : undefined}
    initialLang={langFromUrl()}
  />,
);
