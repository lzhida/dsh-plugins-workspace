/**
 * 时段计划区块：启用开关 + 规则列表（展开/收起、目标勾选、窗口编辑）
 * + 添加规则。规则目标 picker 与回退队列共享同一模型目录数据。
 *
 * 规则编辑的操作状态（当前展开的规则下标、规则 picker 的独立搜索词）
 * 属于本区块内部——旧版挂在 Card 平铺 useState，重构后内聚到这里。
 *
 * @module dsh-llm-fallback/client/components/ScheduleSection
 */

import * as React from 'react';
import { scheduleRuleValid } from '../lib/settings.ts';
import type { ScheduleRule } from '../lib/schedule.ts';
import type { TFn } from '../types.ts';
import { S } from '../styles.ts';
import { CheckRow } from './fields.tsx';
import { RuleEditor } from './RuleEditor.tsx';
import type { CatalogData } from './CatalogPicker.tsx';

/** 新建规则的默认窗口（09:00-18:00、不限星期，与旧版一致）。 */
function defaultWindow(): { start: string; end: string; days: number[] } {
  return { start: '09:00', end: '18:00', days: [] };
}

/** 时段计划区块 props（openRule/ruleSearch 受控——discard 需从卡片层收起）。 */
export interface ScheduleSectionProps {
  t: TFn;
  enabled: boolean;
  rules: ScheduleRule[];
  writable: boolean;
  busy: boolean;
  catalog: CatalogData;
  onToggleEnabled(): void;
  /** 不可变更新规则数组（fn 收到深拷贝后的数组）。 */
  editRules(fn: (rules: ScheduleRule[]) => ScheduleRule[]): void;
  /** 当前展开目录 picker 的规则下标（-1 = 全部收起）。 */
  openRule: number;
  onOpenRuleChange(index: number): void;
  /** 规则 picker 的独立搜索词（不与回退队列互扰）。 */
  ruleSearch: string;
  onRuleSearchChange(text: string): void;
}

/** 配置卡：时段计划（开关 + 规则编辑）。 */
export function ScheduleSection(
  props: ScheduleSectionProps,
): React.ReactElement {
  const { t, rules } = props;
  const openRule = props.openRule;

  function addRule(): void {
    props.editRules((base) =>
      base.concat([{ targets: [], windows: [defaultWindow()] }]),
    );
    props.onOpenRuleChange(rules.length); // 展开新规则的目标编辑
  }

  function removeRule(index: number): void {
    props.editRules((base) => base.filter((_, i) => i !== index));
    if (openRule === index) props.onOpenRuleChange(-1);
  }

  return (
    <div style={S.section}>
      <CheckRow
        checked={props.enabled}
        disabled={!props.writable || props.busy}
        onChange={props.onToggleEnabled}
        label={t('scheduleEnabled')}
        hint={t('scheduleEnabledHint')}
      />

      <div style={S.section}>
        {rules.length > 0 ? (
          <div style={S.section}>
            {rules.map((rule, ruleIndex) => (
              <RuleEditor
                key={'rule' + ruleIndex}
                t={t}
                rule={rule}
                index={ruleIndex}
                valid={
                  rule.targets.length === 0 && rule.windows.length === 0
                    ? true
                    : scheduleRuleValid(rule)
                }
                writable={props.writable}
                busy={props.busy}
                expanded={openRule === ruleIndex}
                onToggleExpand={() =>
                  props.onOpenRuleChange(
                    openRule === ruleIndex ? -1 : ruleIndex,
                  )
                }
                onRemove={() => removeRule(ruleIndex)}
                catalog={props.catalog}
                ruleSearch={props.ruleSearch}
                onRuleSearch={props.onRuleSearchChange}
                onToggleTarget={(provider, model) => {
                  props.editRules((base) => {
                    const key = provider + '/' + model;
                    const rule = base[ruleIndex];
                    if (!rule) return base;
                    const at = rule.targets.indexOf(key);
                    if (at >= 0) rule.targets.splice(at, 1);
                    else rule.targets.push(key);
                    return base;
                  });
                }}
                onAddWindow={() => {
                  props.editRules((base) => {
                    const rule = base[ruleIndex];
                    if (rule) rule.windows.push(defaultWindow());
                    return base;
                  });
                }}
                onRemoveWindow={(windowIndex) => {
                  props.editRules((base) => {
                    const rule = base[ruleIndex];
                    if (rule) rule.windows.splice(windowIndex, 1);
                    return base;
                  });
                }}
                onWindowTime={(windowIndex, field, text) => {
                  props.editRules((base) => {
                    const w =
                      base[ruleIndex] && base[ruleIndex].windows[windowIndex];
                    if (w) w[field] = text;
                    return base;
                  });
                }}
                onToggleDay={(windowIndex, day) => {
                  props.editRules((base) => {
                    const w =
                      base[ruleIndex] && base[ruleIndex].windows[windowIndex];
                    if (!w) return base;
                    const at = w.days.indexOf(day);
                    if (at >= 0) w.days.splice(at, 1);
                    else w.days.push(day);
                    return base;
                  });
                }}
              />
            ))}
          </div>
        ) : null}
        <button
          type="button"
          style={S.btn}
          disabled={!props.writable || props.busy}
          onClick={addRule}
        >
          {t('scheduleAddRule')}
        </button>
      </div>
    </div>
  );
}
