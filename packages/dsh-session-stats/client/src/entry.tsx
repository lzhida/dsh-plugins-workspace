import styles from './dashboard.css';
import { StatsDashboard } from './dashboard.tsx';
import type { ReactNode } from 'react';

/**
 * dsh-session-stats 客户端插件:在 dsh Web UI 右侧栏注册「会话统计」页类型与
 * guide 页入口,点击即进入统计页面(数据经宿主挂载的 /api/session-stats 同源
 * 获取,不新开端口)。
 *
 * 该文件经 esbuild 打包为提交产物 client/index.js(ModuleLoader CJS-in-factory
 * 包装,见 scripts/build-client.ts);react 与 react/jsx-runtime 使用宿主运行时
 * 提供的实例(external require)。
 */

/** 客户端 cordis 上下文最小面(运行时由 dsh web 注入)。 */
interface ClientCtx {
  effect(fn: () => void | (() => void), label?: string): void;
  locale: {
    register(
      namespace: string,
      dict: Record<string, Record<string, string>>,
    ): void;
    bind(namespace: string): (key: string) => string;
  };
  slots: {
    inject(slotName: string, factory: () => unknown): void;
    register(options: Record<string, unknown>, component: unknown): unknown;
  };
  sidebarRightTabs: {
    register(definition: {
      id: string;
      kind: string;
      priority?: 'extension' | 'builtin' | 'fallback';
      title: (address: string) => string;
      guide?: readonly {
        id: string;
        order: number;
        title: () => string;
        description?: () => string;
      }[];
    }): () => void;
  };
}

export const name = 'session-stats';

export const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];

const TAB_ID = 'dsh-session-stats';
const TAB_KIND = 'session-stats';
const LOCALE_NS = 'session-stats';

function StatsTabView(): ReactNode {
  return (
    <StatsDashboard
      dataBase="/api/session-stats"
      syncBase="/api/session-stats/sync"
    />
  );
}

/** guide 页的提供方卡片:整卡可点,点击经 tabInfo.actions 打开统计页。 */
interface GuideCardProps {
  title: string;
  description?: string;
  kind: string;
  useTabInfo: () => {
    tab: {
      actions: {
        openTab(kind: string, options?: { replaceTab?: boolean }): void;
      };
    };
  };
}

function StatsGuideCard({
  title,
  description,
  kind,
  useTabInfo,
}: GuideCardProps): ReactNode {
  const { tab } = useTabInfo();
  const label = description ? `${title} — ${description}` : title;
  return (
    <div
      data-sidebar-right-guide-entry={kind}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        width: '100%',
        minHeight: 56,
        padding: '14px 20px',
        boxSizing: 'border-box',
        border: '0.5px solid var(--dsw-alias-border-l3, #2a3140)',
        borderRadius: 'var(--dsl-guide-entry-radius, 12px)',
        background: 'var(--dsw-alias-bg-layer-1, #161b22)',
        cursor: 'pointer',
      }}
    >
      <button
        type="button"
        aria-label={label}
        onClick={() => tab.actions.openTab(kind, { replaceTab: true })}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          borderRadius: 0,
          border: 0,
          background: 'transparent',
          cursor: 'pointer',
        }}
      />
      <span
        aria-hidden="true"
        style={{
          fontSize: 22,
          color: 'var(--dsw-alias-label-secondary, #8b95a5)',
          pointerEvents: 'none',
        }}
      >
        ◈
      </span>
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
          flex: 1,
          minWidth: 0,
          pointerEvents: 'none',
        }}
      >
        <span
          style={{
            fontSize: 14,
            lineHeight: 1.4,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: 'var(--dsw-alias-label-primary, #e6e9ef)',
          }}
        >
          {title}
        </span>
        {description ? (
          <span
            style={{
              fontSize: 11,
              lineHeight: 1.4,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: 'var(--dsw-alias-label-tertiary, #8b95a5)',
            }}
          >
            {description}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function apply(ctx: Context): void {
  const client = ctx as unknown as ClientCtx;

  // 样式注入:作用域限定在 .dss-scope 子树(dashboard.css 全量文本)。
  client.effect(() => {
    if (document.querySelector('style[data-dsh-session-stats="true"]')) return;
    const el = document.createElement('style');
    el.dataset['dshSessionStats'] = 'true';
    el.textContent = styles;
    document.head.appendChild(el);
    return () => el.remove();
  }, 'session-stats: styles');

  // 页类型文案跟随 dsh 全局语言设置(tab chip 与 guide 入口)。
  client.effect(() => {
    client.locale.register(LOCALE_NS, {
      zh: {
        tabTitle: '会话统计',
        guideTitle: '会话统计',
        guideDesc: '本地全部会话的用量观测:Token、模型、工具、项目与错误',
      },
      en: {
        tabTitle: 'Session Stats',
        guideTitle: 'Session Stats',
        guideDesc:
          'Usage insights across all local sessions: tokens, models, tools, projects, errors',
      },
    });
  }, 'session-stats: locale');
  const t = client.locale.bind(LOCALE_NS);

  // 第一段:注册页类型(extension 带 guide 入口,即右侧栏的「菜单」)。
  client.effect(
    () =>
      client.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: () => t('tabTitle'),
        guide: [
          {
            id: 'open',
            order: 30,
            title: () => t('guideTitle'),
            description: () => t('guideDesc'),
          },
        ],
      }),
    'session-stats: tab type',
  );

  // 第二段:在 keyed slot 上按 definition id 提供页主体。
  client.effect(() => {
    client.slots.inject('sidebar.right.pane.tab', () =>
      client.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: LOCALE_NS,
          inject: () => ({}),
        },
        StatsTabView,
      ),
    );
  }, 'session-stats: tab body');

  // 第三段:提供方 guide 卡片(keyed by providerId)——自带 onPick 行为,
  // 官方兜底卡片只是视觉占位,没有打开动作。
  client.effect(() => {
    client.slots.inject('sidebar.right.tab.guide.entry', () =>
      client.slots.register(
        {
          name: 'sidebar.right.tab.guide.entry',
          key: TAB_ID,
          locale: LOCALE_NS,
          inject: () => ({}),
        },
        StatsGuideCard,
      ),
    );
  }, 'session-stats: guide entry');
}

// 宿主 Context 类型占位:客户端上下文由 dsh web 运行时提供,类型面以本地
// ClientCtx 为准,避免为打包产物引入额外依赖。
type Context = unknown;
