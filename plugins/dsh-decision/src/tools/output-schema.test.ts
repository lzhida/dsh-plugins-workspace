import { describe, expect, it } from 'vitest';

import { ARBITER_OUTPUT } from './arbiter.ts';
import { BATCH_OUTPUT } from './batch.ts';
import { CALIBRATE_OUTPUT } from './calibrate.ts';
import { DECIDE_OUTPUT } from './decide.ts';
import { GATE_OUTPUT } from './gate.ts';
import { HISTORY_OUTPUT_SCHEMA } from './history.ts';
import { LOCATE_OUTPUT } from './locate.ts';
import { RECHECK_OUTPUT_SCHEMA } from './recheck.ts';
import { RERANK_OUTPUT } from './rerank.ts';
import { USAGE_OUTPUT } from './usage.ts';

/**
 * 出参 schema 的「必填面」回归锚点。
 *
 * 背景（2026-11-28 会话内活体验证抓到的真实缺陷）：宿主在工具返回后会按
 * output.schema 校验返回体。若把「只在 ok=true 路径存在」的顶层字段标成
 * required，错误信封形态 { ok:false, error:{...} } 就会缺字段，宿主判为
 * `returned invalid output: missing required property "value.xxx"` 并丢弃
 * 结果——契约 §1.1 规定的错误形态反而不可用。
 *
 * 因此：顶层只允许 ok 必填；成功态字段全部可缺省；子对象内部的 required
 * 保留（对象存在时其内部字段仍需完整）。
 */
interface SchemaLike {
  type: string;
  additionalProperties?: boolean;
  properties?: Record<string, { required?: boolean } | undefined>;
}

const topLevelRequired = (schema: SchemaLike): string[] =>
  Object.entries(schema.properties ?? {})
    .filter(([, spec]) => spec?.required === true)
    .map(([name]) => name)
    .sort();

const ALL_SCHEMAS: ReadonlyArray<readonly [string, SchemaLike]> = [
  ['decision_decide', DECIDE_OUTPUT.schema as unknown as SchemaLike],
  ['decision_gate', GATE_OUTPUT.schema as unknown as SchemaLike],
  ['decision_rerank', RERANK_OUTPUT.schema as unknown as SchemaLike],
  ['decision_batch', BATCH_OUTPUT.schema as unknown as SchemaLike],
  ['decision_locate', LOCATE_OUTPUT.schema as unknown as SchemaLike],
  ['decision_usage', USAGE_OUTPUT.schema as unknown as SchemaLike],
  ['decision_history', HISTORY_OUTPUT_SCHEMA as unknown as SchemaLike],
  ['decision_recheck', RECHECK_OUTPUT_SCHEMA as unknown as SchemaLike],
  ['decision_calibrate', CALIBRATE_OUTPUT.schema as unknown as SchemaLike],
  ['decision_arbiter', ARBITER_OUTPUT.schema as unknown as SchemaLike],
];

const ERROR_ENVELOPE = {
  ok: false,
  error: {
    code: 'model-call-failed',
    message: '决策模型调用失败',
    retryable: true,
    details: {},
  },
};

describe('decision-tools 出参 schema 必填面', () => {
  it('十个工具的顶层必填字段只有 ok（错误信封形态必须可表达）', () => {
    for (const [tool, schema] of ALL_SCHEMAS) {
      expect(topLevelRequired(schema), `${tool} 顶层必填字段`).toEqual(['ok']);
    }
  });

  it('十个工具都声明了 error 信封字段', () => {
    for (const [tool, schema] of ALL_SCHEMAS) {
      expect(
        Object.keys(schema.properties ?? {}),
        `${tool} 缺少 error 字段`,
      ).toContain('error');
    }
  });

  it('错误信封形态满足每个工具的必填集合', () => {
    for (const [tool, schema] of ALL_SCHEMAS) {
      const required = topLevelRequired(schema);
      const present = Object.keys(ERROR_ENVELOPE);
      const missing = required.filter((key) => !present.includes(key));
      expect(missing, `${tool} 错误信封缺必填字段`).toEqual([]);
    }
  });

  it('成功态字段可缺省（只有 ok 的对象也是合法返回体）', () => {
    for (const [tool, schema] of ALL_SCHEMAS) {
      const required = topLevelRequired(schema);
      expect(
        required.every((key) => key === 'ok'),
        `${tool} 必填面过宽`,
      ).toBe(true);
      const properties = Object.keys(schema.properties ?? {});
      expect(properties.length, `${tool} 顶层字段过少`).toBeGreaterThan(1);
    }
  });
});
