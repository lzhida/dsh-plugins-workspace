/**
 * 配置卡复用的小型表单行组件（纯展示，状态与逻辑在 AnytypeCard）。
 *
 * 布局对齐 shadcn Field 形态：左侧标签 + 次级说明，右侧控件；开关用
 * Switch、数值用 Input(type=number)、文本用 Input、工具组用 Checkbox 网格、
 * 密钥用密码框 + 「已配置」徽标 + 清除按钮。
 *
 * @module dsh-anytype/client/components/fields
 */

import * as React from 'react';
import { Badge } from './ui/badge.tsx';
import { Button } from './ui/button.tsx';
import { Checkbox } from './ui/checkbox.tsx';
import { Input } from './ui/input.tsx';
import { Switch } from './ui/switch.tsx';

/** 左侧「标签 + 次级说明」组合（行布局共用）。 */
function FieldLabels(props: {
  label: string;
  hint: string;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-[13px] font-semibold text-foreground">
        {props.label}
      </span>
      <span className="text-xs text-muted-foreground">{props.hint}</span>
    </div>
  );
}

/** 开关行：Switch + 加粗标签 + 次级说明（启用开关共用）。 */
export function SwitchRow(props: {
  checked: boolean;
  disabled: boolean;
  onChange(): void;
  label: string;
  hint: string;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <FieldLabels label={props.label} hint={props.hint} />
      <Switch
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={() => props.onChange()}
        aria-label={props.label}
      />
    </div>
  );
}

/** 文本行：左侧标签+说明，右侧文本输入。 */
export function TextRow(props: {
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
  placeholder?: string;
  invalid?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <FieldLabels label={props.label} hint={props.hint} />
      <Input
        type="text"
        className="w-[320px] max-w-[55%] shrink-0"
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        aria-label={props.label}
        aria-invalid={props.invalid === true}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

/** 数字行：左侧标签+说明，右侧 number 输入（非负整数解析由调用方负责）。 */
export function NumberRow(props: {
  label: string;
  hint: string;
  value: number;
  disabled: boolean;
  onChange(value: number): void;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <FieldLabels label={props.label} hint={props.hint} />
      <Input
        type="number"
        min={0}
        className="w-[110px] shrink-0 text-right"
        value={String(props.value)}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={(event) => {
          const raw = Number(event.target.value);
          props.onChange(Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0);
        }}
      />
    </div>
  );
}

/**
 * 密钥行：密码框（只写）+ 状态徽标 + 清除按钮。
 *
 * 宿主对该字段做 `role('secret')` 脱敏——旧值永不过线，故输入框永远为空，
 * 徽标只说明「是否已设置」；留空 = 不改动（保存载荷不含该字段）。
 */
export function SecretRow(props: {
  label: string;
  hint: string;
  value: string;
  disabled: boolean;
  set: boolean;
  placeholder: string;
  setLabel: string;
  unsetLabel: string;
  clearLabel: string;
  onChange(value: string): void;
  onClear(): void;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <FieldLabels label={props.label} hint={props.hint} />
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant="outline">
          {props.set ? props.setLabel : props.unsetLabel}
        </Badge>
        <Input
          type="password"
          className="w-[220px]"
          value={props.value}
          disabled={props.disabled}
          placeholder={props.placeholder}
          aria-label={props.label}
          onChange={(event) => props.onChange(event.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={props.disabled || !props.set}
          onClick={props.onClear}
          aria-label={props.clearLabel}
        >
          {props.clearLabel}
        </Button>
      </div>
    </div>
  );
}

/** 工具组行：勾选网格（勾选 = 该组工具不再注册）。 */
export function GroupRow(props: {
  label: string;
  hint: string;
  groups: readonly string[];
  selected: readonly string[];
  disabled: boolean;
  onToggle(group: string): void;
}): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <FieldLabels label={props.label} hint={props.hint} />
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {props.groups.map((group) => {
          const checked = props.selected.includes(group);
          return (
            <label
              key={group}
              className="flex cursor-pointer items-center gap-1.5 text-[13px] text-foreground"
            >
              <Checkbox
                checked={checked}
                disabled={props.disabled}
                aria-label={group}
                onCheckedChange={() => props.onToggle(group)}
              />
              <span>{group}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
