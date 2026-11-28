/**
 * 设置页行组件（决策工具系列 6/11）。
 *
 * 照抄 llm-fallback fields.tsx 范式并按设计稿扩展：FieldLabels /
 * SwitchRow / NumberRow 之外，模型表单需要 TextRow（baseUrl/model）、
 * PasswordRow（apiKey，type=password + autoComplete 防泄漏）、
 * FloatRow（成本/阈值小数）、SelectRow（fallbackMode 原生 <select>，
 * 不引 Radix Select）。行组件纯展示，状态在 Card。
 *
 * @module dsh-decision/client/components/fields
 */

import * as React from 'react';

import { cn } from '../lib/cn.ts';
import { Input } from './ui/input.tsx';
import { Label } from './ui/label.tsx';
import { Switch } from './ui/switch.tsx';

/** 标签 + 次级说明（左文案、右控件布局共用）。 */
function FieldLabels(props: {
  label: string;
  hint?: string;
  htmlFor?: string;
}): React.ReactElement {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <Label htmlFor={props.htmlFor}>{props.label}</Label>
      {props.hint === undefined ? null : (
        <span className="text-xs leading-4 text-muted-foreground">
          {props.hint}
        </span>
      )}
    </span>
  );
}

export interface FieldRowProps {
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** 开关行（左标签右 Switch；整行包进 <label>，点击行任意处即切换——命中区远超 WCAG 2.5.8 的 24×24 最小值）。 */
export function SwitchRow(
  props: FieldRowProps & {
    checked: boolean;
    onChange: (checked: boolean) => void;
  },
): React.ReactElement {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1.5">
      <FieldLabels label={props.label} hint={props.hint} />
      <Switch
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
        aria-label={props.label}
      />
    </label>
  );
}

/** 文本行。 */
export function TextRow(
  props: FieldRowProps & {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    secret?: boolean;
    id: string;
  },
): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <FieldLabels label={props.label} hint={props.hint} htmlFor={props.id} />
      <Input
        id={props.id}
        className="w-[220px] shrink-0"
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        autoComplete={props.secret ? 'off' : undefined}
        {...(props.secret
          ? { type: 'password' as const }
          : { type: 'text' as const })}
        onChange={(event) => props.onChange(event.target.value)}
        aria-label={props.label}
      />
    </div>
  );
}

/** 整数行（type=number，右对齐窄框）。 */
export function NumberRow(
  props: FieldRowProps & {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    id: string;
  },
): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <FieldLabels label={props.label} hint={props.hint} htmlFor={props.id} />
      <Input
        id={props.id}
        className="w-[110px] shrink-0 text-right"
        type="number"
        min={props.min}
        max={props.max}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          props.onChange(Number.isFinite(parsed) ? Math.trunc(parsed) : 0);
        }}
        aria-label={props.label}
      />
    </div>
  );
}

/** 小数行（成本/阈值；type=number step=any）。 */
export function FloatRow(
  props: FieldRowProps & {
    value: number;
    onChange: (value: number) => void;
    id: string;
  },
): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <FieldLabels label={props.label} hint={props.hint} htmlFor={props.id} />
      <Input
        id={props.id}
        className="w-[110px] shrink-0 text-right"
        type="number"
        step="any"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          props.onChange(Number.isFinite(parsed) ? parsed : 0);
        }}
        aria-label={props.label}
      />
    </div>
  );
}

/** 原生 select 行（fallbackMode 枚举；避免新增 Radix Select 依赖）。 */
export function SelectRow(
  props: FieldRowProps & {
    value: string;
    options: ReadonlyArray<{ value: string; label: string }>;
    onChange: (value: string) => void;
    id: string;
  },
): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <FieldLabels label={props.label} hint={props.hint} htmlFor={props.id} />
      <select
        id={props.id}
        className={cn(
          'h-7 w-[170px] shrink-0 rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground',
          'focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/50',
          'disabled:cursor-default disabled:opacity-50',
        )}
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        aria-label={props.label}
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
