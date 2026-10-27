/**
 * 配置卡复用的小型表单行组件（纯展示，状态与逻辑在 FallbackCard）。
 *
 * 布局对齐 shadcn Field 形态：左侧标签 + 次级说明，右侧控件；开关用
 * Switch、数值用 Input(type=number)。
 *
 * @module dsh-llm-fallback/client/components/fields
 */

import * as React from 'react';
import { parseCountInput } from '../lib/settings.ts';
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

/** 开关行：Switch + 加粗标签 + 次级说明（启用 / 冷却共用）。 */
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

/** 数字行：左侧标签+说明，右侧 number 输入（非负整数解析）。 */
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
        className="w-[90px] shrink-0 text-right"
        value={String(props.value)}
        disabled={props.disabled}
        onChange={(event) =>
          props.onChange(parseCountInput(event.target.value))
        }
      />
    </div>
  );
}
