/**
 * guided-goal client 源码(TS/JSX)。
 *
 * 构建产物 client/index.js 由 `pnpm build:client`(esbuild,见
 * scripts/build-client.ts)生成并提交入库:宿主 dsh client-modules 只按
 * exports["./client"] 直读磁盘文件(缺失即 404),不做任何转译,产物必须就位。
 *
 * 产物为 CJS-in-factory:构建时 banner 注入 __ModuleLoader__.load 注册壳,
 * footer 注入 return module.exports —— 注册 id 必须与包名一致,否则 boot
 * graph arrive() 抛 "loaded without registering"。
 * react 与 @deepseek-ai/* client 服务由宿主模块表解析(external,见
 * package.json 的 dsh.client.inject)。
 */
import * as React from 'react';

const { createElement, useEffect, useState } = React;

/** 宿主 client 运行时注入的最小服务面(结构兼容,不 import 官方内部类型)。 */
interface GuidedGoalClientContext {
  /** cordis effect:传工厂函数,返回清理函数时在卸载时被调用。 */
  effect(factory: () => void | (() => void), label: string): () => void;
  locale: {
    register(
      namespace: string,
      tables: Record<string, Record<string, string>>,
    ): () => void;
    bind(namespace: string): (key: string) => string;
  };
  slots: {
    inject(name: string, register: () => () => void): () => void;
    register(
      spec: {
        name: string;
        id: string;
        order: number;
        label(): string;
        locale: string;
        inject(): { t(key: string): string };
      },
      render: () => React.ReactNode,
    ): () => void;
  };
}

interface SessionInfo {
  id: string;
  title?: string;
}

interface FieldDef {
  key: string;
  label: string;
  placeholder: string;
  multiline?: boolean;
}

export const name = 'guided-goal';
export const inject = ['slots', 'locale'];

const FIELD = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 12,
} satisfies React.CSSProperties;
const LABEL = { fontSize: 12, fontWeight: 600, opacity: 0.8 } satisfies React.CSSProperties;
const CONTROL = {
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsh-border, #ccc)',
  font: 'inherit',
} satisfies React.CSSProperties;
const HINT = { fontSize: 11, opacity: 0.6 } satisfies React.CSSProperties;
const STATUS = {
  marginTop: 8,
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  minHeight: 16,
} satisfies React.CSSProperties;
const BUTTON = {
  alignSelf: 'flex-start',
  padding: '6px 14px',
  borderRadius: 6,
  border: 'none',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
} satisfies React.CSSProperties;

const FIELDS: FieldDef[] = [
  {
    key: 'objective',
    label: '目标 Objective',
    placeholder: '要完成什么,一句话',
    multiline: true,
  },
  {
    key: 'successCriteria',
    label: '成功标准 Success criteria',
    placeholder: '可判定的完成信号(测试通过 / 命令退出码 0 / 文件存在…)',
    multiline: true,
  },
  {
    key: 'verification',
    label: '验证方式 Verification',
    placeholder: '验证所用的确切命令或动作',
  },
  {
    key: 'boundaries',
    label: '范围边界 Boundaries',
    placeholder: '允许触碰 / 明确禁止触碰的路径',
  },
  {
    key: 'stopConditions',
    label: '停止条件 Stop conditions',
    placeholder: '何时停下并交还人工',
  },
  {
    key: 'maxGoalRounds',
    label: '轮次上限 maxGoalRounds(可选)',
    placeholder: '留空使用默认 256',
  },
];

function fetchSessions(
  setSessions: (sessions: SessionInfo[]) => void,
  setStatus: (status: string) => void,
): void {
  fetch('/api/guided-goal/sessions')
    .then((r) => r.json())
    .then((data: { sessions?: SessionInfo[] }) => {
      setSessions(data?.sessions ?? []);
    })
    .catch((e: Error) => {
      setStatus('载入会话失败: ' + e.message);
    });
}

function Form(): JSX.Element {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [status, setStatus] = useState('正在载入会话…');

  useEffect(function onLoad() {
    fetchSessions(setSessions, setStatus);
  }, []);

  function submit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const fields: Record<string, string> = {};
    let missing: string | null = null;
    FIELDS.forEach((f) => {
      const value = String(data.get(f.key) ?? '').trim();
      if ((f.key === 'objective' || f.key === 'successCriteria') && !value) {
        missing = f.label;
      }
      fields[f.key] = value;
    });
    const sessionId = String(data.get('sessionId') ?? '');
    if (missing) {
      setStatus('必填未填: ' + missing);
      return;
    }
    if (!sessionId) {
      setStatus('无可选会话,先在会话页打开一个会话');
      return;
    }

    fetch('/api/guided-goal/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-dsh-guided-goal': '1',
      },
      body: JSON.stringify({ sessionId, fields }),
    })
      .then((r) => r.json().then((body: { message?: string; error?: string }) => ({ ok: r.ok, body })))
      .then((res) => {
        setStatus(
          res.ok
            ? res.body.message ?? '已提交创建请求'
            : '失败: ' + (res.body.error ?? JSON.stringify(res.body)),
        );
      })
      .catch((e: Error) => {
        setStatus('请求失败: ' + e.message);
      });
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column' }}>
      {FIELDS.map((f) => (
        <label key={f.key} style={FIELD}>
          <span style={LABEL}>{f.label}</span>
          {f.multiline ? (
            <textarea
              name={f.key}
              style={{ ...CONTROL, minHeight: 64, resize: 'vertical' }}
              placeholder={f.placeholder}
            />
          ) : (
            <input name={f.key} style={CONTROL} placeholder={f.placeholder} />
          )}
        </label>
      ))}
      <label style={FIELD}>
        <span style={LABEL}>目标会话</span>
        <select name="sessionId" style={CONTROL}>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || s.id}
            </option>
          ))}
        </select>
        <span style={HINT}>列出当前活跃会话;提交后向该会话注入创建指令</span>
      </label>
      <button type="submit" style={BUTTON}>
        创建 Goal
      </button>
      <div style={STATUS}>{status}</div>
      <button
        type="button"
        onClick={() => {
          fetchSessions(setSessions, setStatus);
        }}
        style={{ ...BUTTON, background: 'transparent', fontWeight: 400, fontSize: 11 }}
      >
        刷新会话列表
      </button>
    </form>
  );
}

export function apply(ctx: GuidedGoalClientContext): void {
  ctx.effect(function registerDictionaries() {
    return ctx.locale.register('guided-goal', {
      zh: { nav: '目标引导 Goal' },
      en: { nav: 'Guided Goal' },
    });
  }, 'guided-goal: dictionaries');
  const t = ctx.locale.bind('guided-goal');

  ctx.effect(function injectSettingsSection() {
    return ctx.slots.inject('settings.section', function registerSection() {
      return ctx.slots.register(
        {
          name: 'settings.section',
          id: 'guided-goal',
          order: 42,
          label: () => t('nav'),
          locale: 'guided-goal',
          inject: () => ({ t }),
        },
        () => createElement(Form),
      );
    });
  }, 'guided-goal: settings section');
}
