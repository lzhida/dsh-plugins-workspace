/**
 * 目录浏览节：Open Design 技能库 / 工作流插件 / agent 三个子视图（系列 5/6）。
 *
 * 取数全部经宿主同源路由：技能 /skills（服务端过滤 + offset 分页，上游
 * 单次 200KB+/300+ 条绝不整包进浏览器）、插件 /plugins、agent /agents。
 * 每条「用于生成」按钮回调 onUse，由容器层（OpenDesignPanel）把选中条目
 * 回填进运行表单——回填契约的单一来源是本组件导出的 CatalogEntry。
 *
 * 技能条目与 DSH 自身技能体系无关（上游设计配方），文案用「OD 技能库」
 * 区分；描述在服务端已截断（240 字符），行内默认 3 行折叠、点击展开。
 *
 * @module dsh-open-design/client/components/CatalogSection
 */

import * as React from 'react';

import type {
  AgentSummary,
  PanelApi,
  PluginSummary,
  SkillSummary,
} from '../api.ts';
import { classifyPanelError } from '../api.ts';
import type { TFn } from '../types.ts';

/** 目录搜索防抖间隔（毫秒）。 */
export const CATALOG_SEARCH_DEBOUNCE_MS = 300;

/** 技能分页大小（服务端 MAX_SKILL_LIMIT=200 硬上限之内）。 */
export const CATALOG_PAGE_SIZE = 50;

/** 选中条目（回填运行表单的载荷；nonce 由容器层生成保证重复回填生效）。 */
export interface CatalogEntry {
  skill?: string;
  plugin?: string;
  agent?: string;
}

export interface CatalogSectionProps {
  t: TFn;
  api: PanelApi;
  /** 「用于生成」回调（容器层据此回填运行表单）。 */
  onUse: (entry: CatalogEntry) => void;
}

type CatalogTab = 'skills' | 'plugins' | 'agents';

/** 把取数错误转成可读文案（与运行节同一套分类）。 */
function errorText(t: TFn, err: unknown): string {
  const kind = classifyPanelError(err);
  if (kind === 'upstream-timeout') return t('run.upstreamTimeout');
  if (kind === 'upstream-unavailable') return t('run.upstreamUnavailable');
  return err instanceof Error ? err.message : String(err);
}

/**
 * 目录浏览节。
 *
 * @param props - 取数面、文案函数与回填回调。
 */
export function CatalogSection(props: CatalogSectionProps): React.ReactElement {
  const { t, api } = props;

  const [tab, setTab] = React.useState<CatalogTab>('skills');

  // —— 技能子视图（搜索 + 分页）——
  const [skillInput, setSkillInput] = React.useState('');
  const [skills, setSkills] = React.useState<SkillSummary[]>([]);
  const [skillStats, setSkillStats] = React.useState({
    total: 0,
    matched: 0,
  });
  const [skillNextOffset, setSkillNextOffset] = React.useState<number | null>(
    null,
  );
  const [skillsLoading, setSkillsLoading] = React.useState(false);
  const [skillsError, setSkillsError] = React.useState<string | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  // —— 插件 / agent 子视图 ——
  const [plugins, setPlugins] = React.useState<PluginSummary[]>([]);
  const [pluginsState, setPluginsState] = React.useState<'idle' | 'loading'>(
    'idle',
  );
  const [pluginsError, setPluginsError] = React.useState<string | null>(null);
  const [agents, setAgents] = React.useState<AgentSummary[]>([]);
  const [agentsState, setAgentsState] = React.useState<'idle' | 'loading'>(
    'idle',
  );
  const [agentsError, setAgentsError] = React.useState<string | null>(null);

  // 技能搜索（防抖；切到技能 tab 或输入变化时拉第一页）。
  React.useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      setSkillsLoading(true);
      void api
        .skills(skillInput.trim(), CATALOG_PAGE_SIZE, 0)
        .then((payload) => {
          if (!alive) return;
          setSkills(Array.isArray(payload.items) ? payload.items : []);
          setSkillStats({
            total: typeof payload.total === 'number' ? payload.total : 0,
            matched: typeof payload.matched === 'number' ? payload.matched : 0,
          });
          setSkillNextOffset(payload.nextOffset ?? null);
          setSkillsError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setSkillsError(errorText(t, err));
        })
        .finally(() => {
          if (!alive) return;
          setSkillsLoading(false);
        });
    }, CATALOG_SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, skillInput, t]);

  // 「加载更多」：按 nextOffset 追加下一页。落地前比对查询词快照——
  // 在途期间用户改了搜索词的话，这页属于旧查询，追加会污染新结果集。
  const loadMore = (): void => {
    if (skillNextOffset === null || skillsLoading) return;
    const querySnapshot = skillInput.trim();
    setSkillsLoading(true);
    void api
      .skills(querySnapshot, CATALOG_PAGE_SIZE, skillNextOffset)
      .then((payload) => {
        if (skillInput.trim() !== querySnapshot) return;
        const items = Array.isArray(payload.items) ? payload.items : [];
        setSkills((prev) => [...prev, ...items]);
        setSkillNextOffset(payload.nextOffset ?? null);
        setSkillsError(null);
      })
      .catch((err: unknown) => {
        if (skillInput.trim() !== querySnapshot) return;
        setSkillsError(errorText(t, err));
      })
      .finally(() => {
        setSkillsLoading(false);
      });
  };

  // 插件视图懒加载（首次切到该 tab 时拉一次；失败置回 idle 让切回时可重试）。
  React.useEffect(() => {
    if (tab !== 'plugins' || pluginsState !== 'idle') return;
    setPluginsState('loading');
    void api
      .plugins()
      .then((payload) => {
        setPlugins(Array.isArray(payload.items) ? payload.items : []);
        setPluginsError(null);
      })
      .catch((err: unknown) => {
        setPluginsError(errorText(t, err));
        setPluginsState('idle');
      });
  }, [api, tab, pluginsState, t]);

  // agent 视图懒加载（失败同样置回 idle 供切回重试）。
  React.useEffect(() => {
    if (tab !== 'agents' || agentsState !== 'idle') return;
    setAgentsState('loading');
    void api
      .agents()
      .then((payload) => {
        setAgents(Array.isArray(payload.agents) ? payload.agents : []);
        setAgentsError(null);
      })
      .catch((err: unknown) => {
        setAgentsError(errorText(t, err));
        setAgentsState('idle');
      });
  }, [api, tab, agentsState, t]);

  const useSkill = (item: SkillSummary): void => {
    props.onUse({ skill: item.id });
  };
  const usePlugin = (item: PluginSummary): void => {
    const id = typeof item.id === 'string' ? item.id : '';
    if (id !== '') props.onUse({ plugin: id });
  };
  const useAgent = (item: AgentSummary): void => {
    props.onUse({ agent: item.id });
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">{t('catalog.title')}</h3>

      <div className="flex gap-1">
        {(
          [
            ['skills', t('catalog.tabSkills')],
            ['plugins', t('catalog.tabPlugins')],
            ['agents', t('catalog.tabAgents')],
          ] as Array<[CatalogTab, string]>
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={
              tab === value
                ? 'rounded-md border border-border px-2 py-1 text-[12px] bg-accent'
                : 'rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent'
            }
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'skills' ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            {t('catalog.skillNote')}
          </p>
          <input
            className="rounded-md border border-border bg-background px-2 py-1 text-[12px]"
            type="search"
            value={skillInput}
            placeholder={t('catalog.search')}
            onChange={(event) => setSkillInput(event.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            {t('catalog.matched')} {skillStats.matched} {t('catalog.of')}{' '}
            {skillStats.total}
          </p>
          {skillsError !== null ? (
            <p className="break-all text-destructive">
              {t('catalog.loadFailed')}
              {': '}
              {skillsError}
            </p>
          ) : null}
          {skills.map((item) => {
            const expanded = expandedId === item.id;
            return (
              <div
                key={item.id}
                className="flex flex-col gap-1 rounded-md border border-border px-2 py-1.5 text-[12px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                    title={item.description}
                    onClick={() =>
                      setExpandedId((prev) =>
                        prev === item.id ? null : item.id,
                      )
                    }
                  >
                    {item.name === '' ? item.id : item.name}
                  </button>
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] hover:bg-accent"
                    onClick={() => useSkill(item)}
                  >
                    {t('catalog.use')}
                  </button>
                </div>
                {item.description !== '' ? (
                  <p
                    className={
                      expanded
                        ? 'whitespace-pre-wrap break-words text-muted-foreground'
                        : 'line-clamp-3 break-words text-muted-foreground'
                    }
                    onClick={() => setExpandedId(expanded ? null : item.id)}
                  >
                    {item.description}
                  </p>
                ) : null}
                {item.triggers.length > 0 ? (
                  <p className="truncate text-[11px] text-muted-foreground">
                    {item.triggers.join(' · ')}
                  </p>
                ) : null}
              </div>
            );
          })}
          {skillNextOffset !== null ? (
            <button
              type="button"
              className="self-start rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent"
              onClick={loadMore}
              disabled={skillsLoading}
            >
              {skillsLoading ? t('panel.loading') : t('catalog.loadMore')}
            </button>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {t('catalog.noMore')}
            </p>
          )}
        </div>
      ) : null}

      {tab === 'plugins' ? (
        <div className="flex flex-col gap-1.5">
          {pluginsError !== null ? (
            <p className="break-all text-destructive">
              {t('catalog.loadFailed')}
              {': '}
              {pluginsError}
            </p>
          ) : null}
          {plugins.length === 0 && pluginsError === null ? (
            <p className="text-[12px] text-muted-foreground">
              {t('catalog.empty')}
            </p>
          ) : null}
          {plugins.map((item, index) => {
            const id = typeof item.id === 'string' ? item.id : '';
            const name = typeof item.name === 'string' ? item.name : id;
            return (
              <div
                key={id !== '' ? id : `plugin-${index}`}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-[12px]"
              >
                <span className="min-w-0 flex-1 truncate">{name}</span>
                {id !== '' ? (
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] hover:bg-accent"
                    onClick={() => usePlugin(item)}
                  >
                    {t('catalog.use')}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {tab === 'agents' ? (
        <div className="flex flex-col gap-1.5">
          {agentsError !== null ? (
            <p className="break-all text-destructive">
              {t('catalog.agentUnavailable')}
            </p>
          ) : null}
          {agents.length === 0 && agentsError === null ? (
            <p className="text-[12px] text-muted-foreground">
              {agentsState === 'idle' ? t('panel.loading') : t('catalog.empty')}
            </p>
          ) : null}
          {agents.map((item) => (
            <div
              key={item.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 text-[12px]"
            >
              <span className="min-w-0 flex-1 truncate">
                {item.name ?? item.id}
                {typeof item.version === 'string' && item.version !== ''
                  ? ` (${item.version})`
                  : ''}
              </span>
              <button
                type="button"
                className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] hover:bg-accent"
                onClick={() => useAgent(item)}
              >
                {t('catalog.use')}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
