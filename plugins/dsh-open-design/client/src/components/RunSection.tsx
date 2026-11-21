/**
 * 生成运行节：发起表单 + 运行状态卡列表（系列 4/6）。
 *
 * 取数全部经宿主同源路由（client/src/api.ts）：项目列表由容器层传入，
 * agent 列表取 /agents，技能检索取 /skills?q=（服务端已过滤截断），
 * 发起取 POST /runs，状态轮询由 RunStatusCard 负责。
 *
 * 运行历史不落盘（插件 config.json 不记录 runId）；仅在 sessionStorage
 * 留「最近一次 runId」，便于离开面板后重进续查。
 *
 * @module dsh-open-design/client/components/RunSection
 */

import * as React from 'react';

import type {
  AgentSummary,
  PanelApi,
  ProjectSummary,
  SkillSummary,
} from '../api.ts';
import { classifyPanelError } from '../api.ts';
import type { TFn } from '../types.ts';

import { RunStatusCard } from './RunStatusCard.tsx';

/** 技能检索防抖间隔（毫秒）。 */
export const SKILL_SEARCH_DEBOUNCE_MS = 300;

/** 技能检索返回条数。 */
export const SKILL_SEARCH_LIMIT = 20;

/** sessionStorage 中保存最近 runId 的键。 */
export const LAST_RUN_ID_KEY = 'dsh-open-design:last-run-id';

/**
 * 目录浏览节（系列 5/6）回填运行表单的载荷；nonce 变化触发消费
 * （同一值重复回填也要生效）。
 */
export interface RunBackfill {
  skill?: string;
  plugin?: string;
  agent?: string;
  nonce: number;
}

export interface RunSectionProps {
  t: TFn;
  api: PanelApi;
  /** 项目候选（容器层的 /projects 数据）。 */
  projects: ProjectSummary[];
  /** 轮询间隔（测试注入小值）。 */
  pollIntervalMs?: number;
  /** 目录浏览「用于生成」回填（容器层持有，见 CatalogEntry）。 */
  backfill?: RunBackfill | null;
}

interface RunEntry {
  runId: string;
}

/**
 * 生成运行节。
 *
 * @param props - 取数面、项目候选与文案函数。
 */
export function RunSection(props: RunSectionProps): React.ReactElement {
  const { t, api } = props;

  const [project, setProject] = React.useState('');
  const [agent, setAgent] = React.useState('');
  const [skill, setSkill] = React.useState('');
  const [plugin, setPlugin] = React.useState('');
  const [skillQuery, setSkillQuery] = React.useState('');
  const [skills, setSkills] = React.useState<SkillSummary[]>([]);
  const [skillsError, setSkillsError] = React.useState<string | null>(null);
  const [agents, setAgents] = React.useState<AgentSummary[]>([]);
  const [agentsError, setAgentsError] = React.useState<string | null>(null);
  const [prompt, setPrompt] = React.useState('');
  const [starting, setStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const [runs, setRuns] = React.useState<RunEntry[]>([]);

  // 恢复最近一次运行（离开面板后重进可续查）。
  React.useEffect(() => {
    try {
      const last = window.sessionStorage.getItem(LAST_RUN_ID_KEY);
      if (last !== null && last !== '') {
        setRuns([{ runId: last }]);
      }
    } catch {
      // sessionStorage 不可用（隐私模式等）时静默跳过恢复。
    }
  }, []);

  // 目录浏览「用于生成」回填（nonce 变化即消费，不比较值）。
  React.useEffect(() => {
    const backfill = props.backfill;
    if (backfill === null || backfill === undefined) return;
    if (typeof backfill.skill === 'string' && backfill.skill !== '') {
      setSkill(backfill.skill);
      setSkillQuery(backfill.skill);
    }
    if (typeof backfill.plugin === 'string' && backfill.plugin !== '') {
      setPlugin(backfill.plugin);
    }
    if (typeof backfill.agent === 'string' && backfill.agent !== '') {
      setAgent(backfill.agent);
    }
  }, [props.backfill]);

  // agent 列表（失败不阻塞表单：上游 agent 不可用时用默认运行时）。
  React.useEffect(() => {
    let alive = true;
    void api
      .agents()
      .then((payload) => {
        if (!alive) return;
        setAgents(Array.isArray(payload.agents) ? payload.agents : []);
        setAgentsError(null);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setAgentsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
    };
  }, [api]);

  // 技能检索（防抖；服务端已过滤 + 截断）。
  React.useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void api
        .skills(skillQuery, SKILL_SEARCH_LIMIT)
        .then((payload) => {
          if (!alive) return;
          setSkills(Array.isArray(payload.items) ? payload.items : []);
          setSkillsError(null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setSkillsError(err instanceof Error ? err.message : String(err));
        });
    }, SKILL_SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [api, skillQuery]);

  const start = async (): Promise<void> => {
    if (prompt.trim() === '') return;
    setStarting(true);
    setStartError(null);
    try {
      const payload = await api.startRun({
        prompt: prompt.trim(),
        ...(project.trim() === '' ? {} : { project: project.trim() }),
        ...(skill.trim() === '' ? {} : { skill: skill.trim() }),
        ...(agent.trim() === '' ? {} : { agent: agent.trim() }),
        ...(plugin.trim() === '' ? {} : { plugin: plugin.trim() }),
      });
      const runId = typeof payload.runId === 'string' ? payload.runId : '';
      if (runId === '') {
        setStartError(t('run.startFailed'));
        return;
      }
      setRuns((prev) => [...prev, { runId }]);
      try {
        window.sessionStorage.setItem(LAST_RUN_ID_KEY, runId);
      } catch {
        // 忽略存储失败（不影响本次运行）。
      }
      setPrompt('');
    } catch (err) {
      const kind = classifyPanelError(err);
      if (kind === 'upstream-timeout') {
        setStartError(t('run.upstreamTimeout'));
      } else if (kind === 'upstream-unavailable') {
        setStartError(t('run.upstreamUnavailable'));
      } else {
        setStartError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">{t('run.title')}</h3>

      <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px]">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t('run.project')}</span>
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-[12px]"
            value={project}
            onChange={(event) => setProject(event.target.value)}
          >
            <option value="">{t('run.projectHint')}</option>
            {props.projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t('run.agent')}</span>
          <select
            className="rounded-md border border-border bg-background px-2 py-1 text-[12px]"
            value={agent}
            onChange={(event) => setAgent(event.target.value)}
            disabled={agentsError !== null}
          >
            <option value="">{t('run.agentDefault')}</option>
            {agents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name ?? item.id}
              </option>
            ))}
          </select>
          {agentsError !== null ? (
            <span className="text-muted-foreground">
              {t('run.agentUnavailable')}
            </span>
          ) : null}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t('run.skill')}</span>
          <input
            className="rounded-md border border-border bg-background px-2 py-1 text-[12px]"
            type="text"
            value={skill}
            placeholder={t('run.skillSearch')}
            onChange={(event) => {
              setSkill(event.target.value);
              setSkillQuery(event.target.value);
            }}
          />
          {skillsError !== null ? (
            <span className="break-all text-destructive">
              {t('run.skillSearchFailed')}
              {': '}
              {skillsError}
            </span>
          ) : null}
          {skills.length > 0 ? (
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-[12px]"
              value={skill}
              onChange={(event) => setSkill(event.target.value)}
            >
              <option value="">{t('run.skillNone')}</option>
              {skills.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name === '' ? item.id : item.name}
                </option>
              ))}
            </select>
          ) : null}
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t('run.plugin')}</span>
          <input
            className="rounded-md border border-border bg-background px-2 py-1 text-[12px]"
            type="text"
            value={plugin}
            placeholder={t('run.pluginPlaceholder')}
            onChange={(event) => setPlugin(event.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">{t('run.prompt')}</span>
          <textarea
            className="min-h-[64px] w-full rounded-md border border-border bg-background px-2 py-1 text-[12px]"
            value={prompt}
            placeholder={t('run.promptPlaceholder')}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </label>

        {startError !== null ? (
          <p className="break-all text-destructive">
            {t('run.startFailed')}
            {': '}
            {startError}
          </p>
        ) : null}

        <button
          type="button"
          className="self-start rounded-md border border-border px-2 py-1 text-[12px] hover:bg-accent"
          onClick={() => {
            void start();
          }}
          disabled={starting || prompt.trim() === ''}
        >
          {starting ? t('run.starting') : t('run.start')}
        </button>
      </div>

      {runs.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{t('run.empty')}</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {runs.map((entry) => (
            <RunStatusCard
              key={entry.runId}
              t={t}
              api={api}
              runId={entry.runId}
              pollIntervalMs={props.pollIntervalMs}
            />
          ))}
        </div>
      )}
    </section>
  );
}
