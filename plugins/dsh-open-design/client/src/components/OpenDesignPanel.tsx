/**
 * Open Design 左侧栏面板（系列 3/6 只读视图）。
 *
 * 渲染位：`main` 插槽（key = 面板 id，见 constants.ts PANEL_ID），配套
 * 侧栏图标注册在 `sidebar.panellist`（plugin.tsx）。数据通道是宿主
 * webServer 只读路由（系列 2/6）：/status、/projects、/focus，客户端
 * 同源 fetch + 手动刷新；重新检测走 POST /redetect。
 *
 * 三节（只读）：连接状态（StatusSection）、当前焦点（FocusSection）、
 * 项目列表（ProjectsSection）。各节独立降级——任一端点失败只影响它
 * 那一节，不拖垮整版；上游未安装时面板仍渲染并显示安装指引横幅。
 *
 * 第四节（系列 4/6）：生成运行（RunSection）——发起生成 + 轮询状态卡。
 *
 * 第五节（系列 5/6）：目录浏览（CatalogSection）——技能/插件/agent
 * 三个子视图；「用于生成」把选中条目经容器层 backfill 状态回填进
 * RunSection（回填契约单一来源：RunBackfill）。
 *
 * @module dsh-open-design/client/components/OpenDesignPanel
 */

import * as React from 'react';

import {
  panelApi,
  type DiagnosticReport,
  type FocusPayload,
  type PanelApi,
  type ProjectsPayload,
} from '../api.ts';
import type { TFn } from '../types.ts';
import { CatalogSection, type CatalogEntry } from './CatalogSection.tsx';
import { FocusSection } from './FocusSection.tsx';
import { ProjectsSection } from './ProjectsSection.tsx';
import { RunSection, type RunBackfill } from './RunSection.tsx';
import { StatusSection } from './StatusSection.tsx';

/** 面板内部状态（各节独立 error，互不拖垮）。 */
interface PanelState {
  status: DiagnosticReport | null;
  projects: ProjectsPayload | null;
  focus: FocusPayload | null;
  statusError: string | null;
  projectsError: string | null;
  focusError: string | null;
  loading: boolean;
}

const IDLE_STATE: PanelState = {
  status: null,
  projects: null,
  focus: null,
  statusError: null,
  projectsError: null,
  focusError: null,
  loading: true,
};

/** 面板 props（t/onClose 由 plugin 层注入，api 可注入替身）。 */
export interface OpenDesignPanelProps {
  t: TFn;
  /** 关闭面板回调（宿主 layout.selectPanel 软取结果；缺失不渲染按钮）。 */
  onClose?: () => void;
  /** 取数面（默认同源 fetch；测试注入替身）。 */
  api?: PanelApi;
}

/**
 * Open Design 面板（三节只读视图 + 刷新 + 重新检测）。
 *
 * @param props - 面板 props。
 */
export function OpenDesignPanel(
  props: OpenDesignPanelProps,
): React.ReactElement {
  const { t, onClose } = props;
  const api = props.api ?? panelApi;
  const [state, setState] = React.useState<PanelState>(IDLE_STATE);
  const [redetecting, setRedetecting] = React.useState(false);
  const [backfill, setBackfill] = React.useState<RunBackfill | null>(null);

  const handleCatalogUse = React.useCallback((entry: CatalogEntry): void => {
    setBackfill({ ...entry, nonce: Date.now() });
  }, []);

  const toMessage = (reason: unknown): string =>
    reason instanceof Error ? reason.message : String(reason);

  const load = React.useCallback(async (): Promise<void> => {
    setState((prev) => ({ ...prev, loading: true }));
    const [status, projects, focus] = await Promise.allSettled([
      api.status(),
      api.projects(),
      api.focus(),
    ]);
    setState({
      status: status.status === 'fulfilled' ? status.value : null,
      projects: projects.status === 'fulfilled' ? projects.value : null,
      focus: focus.status === 'fulfilled' ? focus.value : null,
      statusError:
        status.status === 'rejected' ? toMessage(status.reason) : null,
      projectsError:
        projects.status === 'rejected' ? toMessage(projects.reason) : null,
      focusError: focus.status === 'rejected' ? toMessage(focus.reason) : null,
      loading: false,
    });
    // eslint 依赖补齐：toMessage 为模块内纯函数，稳定引用。
  }, [api]);

  // 首屏加载（组件卸载后不再写状态）。
  React.useEffect(() => {
    let alive = true;
    void load().then(() => {
      if (!alive) return;
    });
    return () => {
      alive = false;
    };
  }, [load]);

  const handleRedetect = React.useCallback((): void => {
    void (async () => {
      setRedetecting(true);
      try {
        await api.redetect();
        await load();
      } catch {
        // 重新检测失败：load 已尽力刷新，错误在下一轮 /status 里可见。
        await load().catch(() => {});
      } finally {
        setRedetecting(false);
      }
    })();
  }, [api, load]);

  const notInstalled =
    state.status !== null && state.status.installed === false;

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

      {/* 未安装引导横幅：面板不消失，给指引 */}
      {notInstalled ? (
        <div className="flex flex-col gap-1 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]">
          <span className="font-semibold text-destructive">
            {t('panel.notInstalled')}
          </span>
          <span className="text-muted-foreground">
            {t('panel.notInstalledHint')}
          </span>
        </div>
      ) : null}

      <StatusSection
        t={t}
        report={state.status}
        error={state.statusError}
        loading={state.loading}
        busy={redetecting}
        onRetry={() => {
          void load();
        }}
        onRedetect={handleRedetect}
      />
      <FocusSection
        t={t}
        focus={state.focus}
        error={state.focusError}
        loading={state.loading}
        onRetry={() => {
          void load();
        }}
      />
      <ProjectsSection
        t={t}
        projects={state.projects}
        error={state.projectsError}
        loading={state.loading}
        onRetry={() => {
          void load();
        }}
      />
      <RunSection
        t={t}
        api={api}
        projects={state.projects?.projects ?? []}
        backfill={backfill}
      />
      <CatalogSection t={t} api={api} onUse={handleCatalogUse} />
    </div>
  );
}
