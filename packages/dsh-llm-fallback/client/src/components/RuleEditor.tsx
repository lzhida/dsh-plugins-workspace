/**
 * 时段计划单条规则编辑器：头部（目标摘要 + 编辑/删除）+ 可展开的目标
 * 目录 picker + 窗口列表（HH:mm 起止 + 星期 chips + 跨夜徽标）。
 *
 * @module dsh-llm-fallback/client/components/RuleEditor
 */

import * as React from 'react';
import type { ScheduleRule } from '../lib/schedule.ts';
import type { TFn } from '../types.ts';
import { S } from '../styles.ts';
import { CatalogPicker, type CatalogData } from './CatalogPicker.tsx';

/** 星期 chips 的取值（1=周一 … 7=周日，与宿主 schedule.ts 语义一致）。 */
const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 7];

/** 单条规则编辑器 props。 */
export interface RuleEditorProps {
  t: TFn;
  rule: ScheduleRule;
  index: number;
  /** 规则是否可保存（占位规则视为有效，保存时剥离）。 */
  valid: boolean;
  writable: boolean;
  busy: boolean;
  expanded: boolean;
  onToggleExpand(): void;
  onRemove(): void;
  catalog: CatalogData;
  ruleSearch: string;
  onRuleSearch(text: string): void;
  onToggleTarget(provider: string, model: string): void;
  onAddWindow(): void;
  onRemoveWindow(windowIndex: number): void;
  onWindowTime(windowIndex: number, field: 'start' | 'end', text: string): void;
  onToggleDay(windowIndex: number, day: number): void;
}

/** 时段计划单条规则盒。 */
export function RuleEditor(props: RuleEditorProps): React.ReactElement {
  const { t, rule } = props;
  const selected: Record<string, boolean> = {};
  for (const key of rule.targets) selected[key] = true;

  return (
    <div style={S.ruleBox}>
      <div style={S.row}>
        <span style={S.badge}>
          {t('scheduleRuleN') + ' ' + (props.index + 1)}
        </span>
        <span style={S.grow}>
          {rule.targets.length > 0
            ? rule.targets.join(', ')
            : t('scheduleTargetsEmpty')}
        </span>
        <button
          type="button"
          style={S.btn}
          disabled={!props.writable || props.busy}
          onClick={props.onToggleExpand}
        >
          {props.expanded ? t('scheduleDoneTargets') : t('scheduleEditTargets')}
        </button>
        <button
          type="button"
          style={S.btn}
          disabled={!props.writable || props.busy}
          title={t('scheduleRemoveRule')}
          onClick={props.onRemove}
        >
          ✕
        </button>
      </div>

      {!props.valid ? (
        <div style={S.hint}>{'⚠ ' + t('scheduleInvalid')}</div>
      ) : null}

      {props.expanded ? (
        <div style={S.section}>
          <CatalogPicker
            t={t}
            hintKey="scheduleTargetsHint"
            catalog={props.catalog}
            selected={selected}
            onToggle={props.onToggleTarget}
            writable={props.writable}
            busy={props.busy}
            search={props.ruleSearch}
            onSearch={props.onRuleSearch}
          />
        </div>
      ) : null}

      <div style={S.section}>
        <div style={S.label}>{t('scheduleWindows')}</div>
        {rule.windows.map((w, windowIndex) => {
          const overnight =
            w.start.length > 0 && w.end.length > 0 && w.start > w.end;
          return (
            <div key={'w' + windowIndex} style={S.windowRow}>
              <span style={S.hint}>{t('scheduleStart')}</span>
              <input
                type="time"
                style={S.input}
                value={w.start}
                disabled={!props.writable || props.busy}
                onChange={(event) =>
                  props.onWindowTime(windowIndex, 'start', event.target.value)
                }
              />
              <span style={S.hint}>{t('scheduleEnd')}</span>
              <input
                type="time"
                style={S.input}
                value={w.end}
                disabled={!props.writable || props.busy}
                onChange={(event) =>
                  props.onWindowTime(windowIndex, 'end', event.target.value)
                }
              />
              {overnight ? (
                <span style={S.badge}>{t('scheduleOvernight')}</span>
              ) : null}
              {WEEK_DAYS.map((day) => {
                const on = (w.days ?? []).indexOf(day) >= 0;
                return (
                  <button
                    key={'d' + day}
                    type="button"
                    style={on ? S.chipOn : S.chip}
                    disabled={!props.writable || props.busy}
                    title={t('d' + day)}
                    onClick={() => props.onToggleDay(windowIndex, day)}
                  >
                    {t('d' + day)}
                  </button>
                );
              })}
              <button
                type="button"
                style={S.btn}
                disabled={!props.writable || props.busy}
                title={t('remove')}
                onClick={() => props.onRemoveWindow(windowIndex)}
              >
                ✕
              </button>
            </div>
          );
        })}
        <button
          type="button"
          style={S.btn}
          disabled={!props.writable || props.busy}
          onClick={props.onAddWindow}
        >
          {t('scheduleAddWindow')}
        </button>
      </div>
    </div>
  );
}
