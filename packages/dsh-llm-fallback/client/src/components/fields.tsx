/**
 * 配置卡复用的小型表单组件（纯展示，状态与逻辑在 FallbackCard）。
 *
 * @module dsh-llm-fallback/client/components/fields
 */

import * as React from 'react';
import { parseCountInput } from '../lib/settings.ts';
import { S } from '../styles.ts';

/** 开关行：勾选框 + 加粗标签 + 次级说明（启用 / 冷却共用）。 */
export function CheckRow(props: {
  checked: boolean;
  disabled: boolean;
  onChange(): void;
  label: string;
  hint: string;
}): React.ReactElement {
  return (
    <label style={S.check}>
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
      />
      <span style={S.label}>{props.label}</span>
      <span style={S.hint}>{props.hint}</span>
    </label>
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
    <div style={S.row}>
      <div>
        <div style={S.label}>{props.label}</div>
        <div style={S.hint}>{props.hint}</div>
      </div>
      <input
        type="number"
        min={0}
        style={S.input}
        value={String(props.value)}
        disabled={props.disabled}
        onChange={(event) =>
          props.onChange(parseCountInput(event.target.value))
        }
      />
    </div>
  );
}
