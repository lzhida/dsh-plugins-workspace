/**
 * 项目列表节：上游 list_projects（/projects）的只读展示。
 *
 * 条目形状取实测子集（id/name/status.value/updatedAt）；上游加字段不会
 * 崩面板，缺字段按空态处理。
 *
 * @module dsh-open-design/client/components/ProjectsSection
 */

import * as React from 'react';

import type { ProjectSummary, ProjectsPayload } from '../api.ts';
import type { TFn } from '../types.ts';

/** 时间展示：可解析则本地化，否则原文（空值 '—'）。 */
function formatTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  try {
    return parsed.toLocaleString();
  } catch {
    return value;
  }
}

/** 项目节 props。 */
export interface ProjectsSectionProps {
  t: TFn;
  projects: ProjectsPayload | null;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
}

/**
 * 项目列表节。
 *
 * @param props - 展示数据与回调（容器层集中取数后下发）。
 */
export function ProjectsSection(
  props: ProjectsSectionProps,
): React.ReactElement {
  const { t, projects, error, loading, onRetry } = props;

  if (error !== null) {
    return (
      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold">{t('projects.title')}</h3>
        <p className="rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-destructive">
          {t('panel.unavailable')}
          {': '}
          {error}
        </p>
        <div>
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent"
            onClick={onRetry}
          >
            {t('panel.retry')}
          </button>
        </div>
      </section>
    );
  }

  if (loading && projects === null) {
    return (
      <section className="flex flex-col gap-1">
        <h3 className="text-[13px] font-semibold">{t('projects.title')}</h3>
        <p className="text-[12px] text-muted-foreground">
          {t('panel.loading')}
        </p>
      </section>
    );
  }

  const items = projects?.projects ?? [];

  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-[13px] font-semibold">{t('projects.title')}</h3>
      {items.length === 0 ? (
        <p className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-muted-foreground">
          {t('projects.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.map((project: ProjectSummary) => (
            <li
              key={project.id}
              className="rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{project.name}</span>
                {project.status?.value !== undefined &&
                project.status.value !== '' ? (
                  <span className="rounded border border-border px-1 text-muted-foreground">
                    {project.status.value}
                  </span>
                ) : null}
              </div>
              <div className="truncate text-muted-foreground">
                {t('projects.updatedAt')}
                {': '}
                {formatTime(project.updatedAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
