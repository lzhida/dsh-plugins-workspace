/**
 * 时间窗切换/错峰优先区块（时段计划 v2）：开关 + 规则编辑器。
 *
 * 结构复用冷却区块形态（SwitchRow 开关 + 行式控件），不建独立数据链路：
 * 规则数组作为 FallbackCard 单一草稿的两个普通字段
 * （timeWindowEnabled / timeWindowRules）流转，脏检查、revision 冲突
 * 检测与保存载荷全部走既有保存闸（buildMutations 同步扩展）。
 *
 * 规则 = provider 匹配模式 + 动作（block=高峰避让 / prefer=错峰优先）
 * + 时段窗口列表（HH:mm 半开区间，起点>终点=跨夜，相等=全天；按宿主
 * 本地时区判定）。合法性在保存时由 rulesValid 把关（非法阻止保存），
 * 本组件只做受控编辑不做强校验，保证输入过程不丢字。
 *
 * @module dsh-llm-fallback/client/components/TimeWindowSection
 */

import * as React from 'react';

import {
  DEFAULT_TIME_WINDOW_RULES,
  type TimeWindowRuleInput,
} from '../lib/settings.ts';
import type { TFn } from '../types.ts';
import { Button } from './ui/button.tsx';
import { Input } from './ui/input.tsx';
import { SwitchRow } from './fields.tsx';

/** 区块 props：状态全部来自 FallbackCard 的统一草稿流。 */
export interface TimeWindowSectionProps {
  t: TFn;
  enabled: boolean;
  rules: ReadonlyArray<TimeWindowRuleInput>;
  writable: boolean;
  busy: boolean;
  /** 保存闸判定的规则非法态（显示红字提示；编辑到合法即消失）。 */
  invalid: boolean;
  onToggle(): void;
  onRulesChange(rules: TimeWindowRuleInput[]): void;
}

/** 官方预置模板的深拷贝（落草稿用，切断只读常量引用）。 */
function presetRules(): TimeWindowRuleInput[] {
  return DEFAULT_TIME_WINDOW_RULES.map((rule) => ({
    match: rule.match,
    action: rule.action,
    windows: rule.windows.map((w) => ({ start: w.start, end: w.end })),
  }));
}

/** 不可变更新第 ri 条规则（越界 no-op；writer 返回 null = 删除该条）。 */
function patchRule(
  rules: ReadonlyArray<TimeWindowRuleInput>,
  index: number,
  writer: (rule: TimeWindowRuleInput) => TimeWindowRuleInput | null,
): TimeWindowRuleInput[] {
  return rules
    .map((rule, i) => (i === index ? writer(rule) : rule))
    .filter((rule): rule is TimeWindowRuleInput => rule !== null);
}

/** 时间窗区块：开关 + 规则列表 + 添加/模板按钮。 */
export function TimeWindowSection(
  props: TimeWindowSectionProps,
): React.ReactElement {
  const {
    t,
    enabled,
    rules,
    writable,
    busy,
    invalid,
    onToggle,
    onRulesChange,
  } = props;
  const locked = !writable || busy;

  function edit(next: TimeWindowRuleInput[]): void {
    onRulesChange(next);
  }

  return (
    <div className="flex flex-col gap-2">
      <SwitchRow
        checked={enabled}
        disabled={locked}
        onChange={onToggle}
        label={t('timeWindowEnabled')}
        hint={t('timeWindowEnabledHint')}
      />
      {enabled ? (
        <div className="flex flex-col gap-2 rounded-md border border-border-l2 p-2">
          <div className="text-xs text-muted-foreground">
            {t('timeWindowRulesHint')}
          </div>
          {rules.length === 0 ? (
            <div className="text-xs text-muted-foreground">{t('twEmpty')}</div>
          ) : (
            rules.map((rule, ri) => (
              <div
                key={ri}
                className="flex flex-col gap-1.5 rounded-md border border-border-l2 p-2"
              >
                <div className="flex items-center gap-1.5">
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t('twMatchLabel')}
                  </span>
                  <Input
                    value={rule.match}
                    placeholder={t('twMatchPlaceholder')}
                    disabled={locked}
                    aria-label={`${t('twMatchLabel')} ${ri + 1}`}
                    className="h-6 flex-1 text-xs"
                    onChange={(event) =>
                      edit(
                        patchRule(rules, ri, (r) => ({
                          ...r,
                          match: event.target.value,
                        })),
                      )
                    }
                  />
                  <Button
                    size="sm"
                    variant={rule.action === 'block' ? 'default' : 'outline'}
                    disabled={locked}
                    onClick={() =>
                      edit(
                        patchRule(rules, ri, (r) => ({
                          ...r,
                          action: 'block',
                        })),
                      )
                    }
                  >
                    {t('twActionBlock')}
                  </Button>
                  <Button
                    size="sm"
                    variant={rule.action === 'prefer' ? 'default' : 'outline'}
                    disabled={locked}
                    onClick={() =>
                      edit(
                        patchRule(rules, ri, (r) => ({
                          ...r,
                          action: 'prefer',
                        })),
                      )
                    }
                  >
                    {t('twActionPrefer')}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    disabled={locked}
                    aria-label={t('twRemoveRule')}
                    title={t('twRemoveRule')}
                    onClick={() => edit(rules.filter((_, i) => i !== ri))}
                  >
                    ✕
                  </Button>
                </div>
                {rule.windows.map((w, wi) => (
                  <div key={wi} className="flex items-center gap-1.5 pl-4">
                    <Input
                      type="time"
                      value={w.start}
                      disabled={locked}
                      aria-label={`${t('twWindowStart')} ${ri + 1}-${wi + 1}`}
                      className="h-6 w-[104px] text-xs"
                      onChange={(event) =>
                        edit(
                          patchRule(rules, ri, (r) => ({
                            ...r,
                            windows: r.windows.map((win, i) =>
                              i === wi
                                ? { ...win, start: event.target.value }
                                : win,
                            ),
                          })),
                        )
                      }
                    />
                    <span className="text-xs text-muted-foreground">–</span>
                    <Input
                      type="time"
                      value={w.end}
                      disabled={locked}
                      aria-label={`${t('twWindowEnd')} ${ri + 1}-${wi + 1}`}
                      className="h-6 w-[104px] text-xs"
                      onChange={(event) =>
                        edit(
                          patchRule(rules, ri, (r) => ({
                            ...r,
                            windows: r.windows.map((win, i) =>
                              i === wi
                                ? { ...win, end: event.target.value }
                                : win,
                            ),
                          })),
                        )
                      }
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      disabled={locked}
                      aria-label={t('twRemoveWindow')}
                      title={t('twRemoveWindow')}
                      onClick={() =>
                        edit(
                          patchRule(rules, ri, (r) => ({
                            ...r,
                            windows: r.windows.filter((_, i) => i !== wi),
                          })),
                        )
                      }
                    >
                      ✕
                    </Button>
                  </div>
                ))}
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={locked}
                    onClick={() =>
                      edit(
                        patchRule(rules, ri, (r) => ({
                          ...r,
                          windows: [
                            ...r.windows,
                            { start: '08:30', end: '00:30' },
                          ],
                        })),
                      )
                    }
                  >
                    {t('twAddWindow')}
                  </Button>
                </div>
              </div>
            ))
          )}
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() =>
                edit([
                  ...rules,
                  {
                    match: 'deepseek-*',
                    action: 'block' as const,
                    windows: [{ start: '08:30', end: '00:30' }],
                  },
                ])
              }
            >
              {t('twAddRule')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              title={t('twPresetHint')}
              onClick={() => edit(presetRules())}
            >
              {t('twPreset')}
            </Button>
          </div>
        </div>
      ) : null}
      {invalid ? (
        <div className="text-xs text-destructive">{t('twInvalid')}</div>
      ) : null}
    </div>
  );
}
