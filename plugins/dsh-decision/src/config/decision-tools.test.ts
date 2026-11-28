/**
 * decision-tools 配置面测试（决策工具系列 2/11）。
 *
 * 覆盖：默认值、越界回落、baseUrl 归一、工具开关映射，以及设置面板
 * 硬前提（每个字段都标 volatile + 双语 description）。
 *
 * 契约来源：docs/decision-tools-contract.md §6（配置字段表）。
 */

import { describe, expect, it } from 'vitest';

import {
  Config,
  DECISION_TOOL_NAMES,
  DEFAULT_BUDGET_MAX_CALLS_PER_DAY,
  DEFAULT_BUDGET_MAX_COST_USD_PER_DAY,
  DEFAULT_BUDGET_MAX_TOKENS_PER_DAY,
  DEFAULT_FALLBACK_MAX_CALLS_PER_DAY,
  DEFAULT_FALLBACK_MIN_CONFIDENCE,
  DEFAULT_FALLBACK_MODE,
  DEFAULT_FALLBACK_TIMEOUT_MS,
  DEFAULT_GATE_ALLOW_THRESHOLD,
  DEFAULT_LEDGER_MAX_ENTRIES,
  DEFAULT_SYSTEMONE_TIMEOUT_MS,
  FALLBACK_MODES,
  LOCAL_ONLY_TOOLS,
  normalizeBaseUrl,
  resolveToolsConfig,
  toolSwitchOf,
  type DecisionToolName,
} from './decision-tools.ts';

/** Config 的 33 个字段（契约 §6 逐项落位）。 */
const CONFIG_FIELDS = [
  'systemoneBaseUrl',
  'systemoneApiKey',
  'systemoneModel',
  'systemoneTimeoutMs',
  'systemoneVerifiedAt',
  'systemoneVerifyError',
  'toolsDecideEnabled',
  'toolsGateEnabled',
  'toolsRerankEnabled',
  'toolsBatchEnabled',
  'toolsLocateEnabled',
  'toolsUsageEnabled',
  'toolsHistoryEnabled',
  'toolsRecheckEnabled',
  'toolsCalibrateEnabled',
  'toolsArbiterEnabled',
  'budgetEnabled',
  'budgetMaxCallsPerDay',
  'budgetMaxTokensPerDay',
  'budgetMaxCostUsdPerDay',
  'budgetResetHourUtc',
  'costInputPer1kTokens',
  'costOutputPer1kTokens',
  'fallbackEnabled',
  'fallbackProvider',
  'fallbackModel',
  'fallbackMinConfidence',
  'fallbackMode',
  'fallbackTimeoutMs',
  'fallbackMaxCallsPerDay',
  'ledgerEnabled',
  'ledgerMaxEntries',
  'gateAllowThreshold',
] as const;

const SWITCH_FIELDS = [
  'toolsDecideEnabled',
  'toolsGateEnabled',
  'toolsRerankEnabled',
  'toolsBatchEnabled',
  'toolsLocateEnabled',
  'toolsUsageEnabled',
  'toolsHistoryEnabled',
  'toolsRecheckEnabled',
  'toolsCalibrateEnabled',
  'toolsArbiterEnabled',
] as const;

/** schemastery 节点里测试关心的最小形状。 */
interface SchemaNode {
  meta?: {
    volatile?: unknown;
    default?: unknown;
    description?: unknown;
  };
}

function fieldOf(fieldName: string): SchemaNode | undefined {
  return (Config as unknown as { dict: Record<string, SchemaNode> }).dict?.[
    fieldName
  ];
}

describe('dsh-decision 配置面', () => {
  describe('默认值（契约 §6）', () => {
    it('未配置时回落契约默认值', () => {
      const config = resolveToolsConfig(undefined);
      expect(config.systemoneBaseUrl).toBe('');
      expect(config.systemoneApiKey).toBe('');
      expect(config.systemoneModel).toBe('');
      expect(config.systemoneTimeoutMs).toBe(DEFAULT_SYSTEMONE_TIMEOUT_MS);
      expect(config.systemoneVerifiedAt).toBe('');
      expect(config.systemoneVerifyError).toBe('');
      expect(config.budgetMaxCallsPerDay).toBe(
        DEFAULT_BUDGET_MAX_CALLS_PER_DAY,
      );
      expect(config.budgetMaxTokensPerDay).toBe(
        DEFAULT_BUDGET_MAX_TOKENS_PER_DAY,
      );
      expect(config.budgetMaxCostUsdPerDay).toBe(
        DEFAULT_BUDGET_MAX_COST_USD_PER_DAY,
      );
      expect(config.budgetResetHourUtc).toBe(0);
      expect(config.costInputPer1kTokens).toBe(0);
      expect(config.costOutputPer1kTokens).toBe(0);
      expect(config.fallbackMinConfidence).toBe(
        DEFAULT_FALLBACK_MIN_CONFIDENCE,
      );
      expect(config.fallbackMode).toBe(DEFAULT_FALLBACK_MODE);
      expect(config.fallbackTimeoutMs).toBe(DEFAULT_FALLBACK_TIMEOUT_MS);
      expect(config.fallbackMaxCallsPerDay).toBe(
        DEFAULT_FALLBACK_MAX_CALLS_PER_DAY,
      );
      expect(config.ledgerEnabled).toBe(true);
      expect(config.ledgerMaxEntries).toBe(DEFAULT_LEDGER_MAX_ENTRIES);
      expect(config.gateAllowThreshold).toBe(DEFAULT_GATE_ALLOW_THRESHOLD);
    });

    it('十个工具开关默认全关（契约 §6.3）', () => {
      const config = resolveToolsConfig({});
      for (const field of SWITCH_FIELDS) {
        expect(config[field], `${field} 应默认关闭`).toBe(false);
      }
      expect(config.budgetEnabled).toBe(false);
      expect(config.fallbackEnabled).toBe(false);
    });
  });

  describe('越界回落（沿用 core/config.ts 纪律）', () => {
    it('超时越界回落默认', () => {
      expect(
        resolveToolsConfig({ systemoneTimeoutMs: 10 }).systemoneTimeoutMs,
      ).toBe(DEFAULT_SYSTEMONE_TIMEOUT_MS);
      expect(
        resolveToolsConfig({ systemoneTimeoutMs: 999_999 }).systemoneTimeoutMs,
      ).toBe(DEFAULT_SYSTEMONE_TIMEOUT_MS);
      expect(
        resolveToolsConfig({ systemoneTimeoutMs: '30000' }).systemoneTimeoutMs,
      ).toBe(DEFAULT_SYSTEMONE_TIMEOUT_MS);
    });

    it('预算与阈值越界回落默认', () => {
      expect(
        resolveToolsConfig({ budgetResetHourUtc: 24 }).budgetResetHourUtc,
      ).toBe(0);
      expect(
        resolveToolsConfig({ budgetResetHourUtc: -1 }).budgetResetHourUtc,
      ).toBe(0);
      expect(
        resolveToolsConfig({ fallbackMinConfidence: 0 }).fallbackMinConfidence,
      ).toBe(DEFAULT_FALLBACK_MIN_CONFIDENCE);
      expect(
        resolveToolsConfig({ fallbackMinConfidence: 2 }).fallbackMinConfidence,
      ).toBe(DEFAULT_FALLBACK_MIN_CONFIDENCE);
      expect(
        resolveToolsConfig({ gateAllowThreshold: 3 }).gateAllowThreshold,
      ).toBe(DEFAULT_GATE_ALLOW_THRESHOLD);
      expect(
        resolveToolsConfig({ ledgerMaxEntries: 10 }).ledgerMaxEntries,
      ).toBe(DEFAULT_LEDGER_MAX_ENTRIES);
    });

    it('兜底模式不在枚举闭集内 → 回落默认', () => {
      expect(resolveToolsConfig({ fallbackMode: 'both' }).fallbackMode).toBe(
        'both',
      );
      expect(resolveToolsConfig({ fallbackMode: 'bogus' }).fallbackMode).toBe(
        DEFAULT_FALLBACK_MODE,
      );
      for (const mode of FALLBACK_MODES) {
        expect(resolveToolsConfig({ fallbackMode: mode }).fallbackMode).toBe(
          mode,
        );
      }
    });
  });

  describe('baseUrl 归一', () => {
    it('去尾斜杠；非 http(s) 视为未配置', () => {
      expect(normalizeBaseUrl('https://decision.example.internal/')).toBe(
        'https://decision.example.internal',
      );
      expect(normalizeBaseUrl('  https://dec.example.com//  ')).toBe(
        'https://dec.example.com',
      );
      expect(normalizeBaseUrl('ftp://dec.example.com')).toBe('');
      expect(normalizeBaseUrl('')).toBe('');
      expect(normalizeBaseUrl(123)).toBe('');
    });

    it('配置解析走同一条归一', () => {
      expect(
        resolveToolsConfig({ systemoneBaseUrl: 'http://x/' }).systemoneBaseUrl,
      ).toBe('http://x');
      expect(
        resolveToolsConfig({ systemoneBaseUrl: 'nope' }).systemoneBaseUrl,
      ).toBe('');
    });
  });

  describe('工具开关映射（契约 §6.3）', () => {
    it('十个工具名各自对应一个独立开关位', () => {
      const config = resolveToolsConfig({});
      for (const tool of DECISION_TOOL_NAMES) {
        expect(toolSwitchOf(config, tool), `${tool} 默认应关闭`).toBe(false);
      }
      const decided = resolveToolsConfig({ toolsDecideEnabled: true });
      expect(toolSwitchOf(decided, 'decision_decide')).toBe(true);
      expect(toolSwitchOf(decided, 'decision_gate')).toBe(false);
      expect(toolSwitchOf(decided, 'decision_arbiter')).toBe(false);
    });

    it('纯本地三工具与模型依赖工具分开登记', () => {
      expect([...LOCAL_ONLY_TOOLS].sort()).toEqual([
        'decision_calibrate',
        'decision_history',
        'decision_usage',
      ]);
    });
  });

  describe('设置面板 schema 硬前提', () => {
    it('字段数量与契约一致（33 项）', () => {
      const dict = (Config as unknown as { dict: Record<string, unknown> })
        .dict;
      expect(Object.keys(dict).sort()).toEqual([...CONFIG_FIELDS].sort());
    });

    it('每个字段都标了 volatile（否则设置面板整块丢弃本插件）', () => {
      for (const field of CONFIG_FIELDS) {
        expect(fieldOf(field), `missing field ${field}`).toBeDefined();
        expect(fieldOf(field)?.meta?.volatile, `${field} not volatile`).toBe(
          true,
        );
      }
    });

    it('每个字段的 description 是三键映射（空串 / en / zh）且默认文案为英文', () => {
      for (const field of CONFIG_FIELDS) {
        const raw = fieldOf(field)?.meta?.description;
        expect(raw, `${field}.description 应为对象`).toBeTypeOf('object');
        const map = raw as Record<string, unknown>;
        for (const key of ['', 'en', 'zh']) {
          expect(typeof map[key], `${field}.${key} 应为 string`).toBe('string');
          expect(
            (map[key] as string).length,
            `${field}.${key} 应非空`,
          ).toBeGreaterThan(0);
        }
        expect(map[''], `${field}.'' 应等于 en`).toBe(map.en);
      }
    });

    it('十个开关的 schema 默认值为 false，账本默认为 true', () => {
      for (const field of SWITCH_FIELDS) {
        expect(fieldOf(field)?.meta?.default, `${field} 默认应为 false`).toBe(
          false,
        );
      }
      expect(fieldOf('ledgerEnabled')?.meta?.default).toBe(true);
    });
  });

  describe('工具名闭集', () => {
    it('十工具名唯一且统一 decision_ 前缀', () => {
      expect(new Set(DECISION_TOOL_NAMES).size).toBe(10);
      for (const tool of DECISION_TOOL_NAMES) {
        expect(tool.startsWith('decision_')).toBe(true);
      }
    });

    it('工具名类型可穷举（DecisionToolName 与闭集一致）', () => {
      const names: DecisionToolName[] = [...DECISION_TOOL_NAMES];
      expect(names).toHaveLength(10);
    });

    it('十工具名与契约 §1.2 闭集逐字一致（改名即红）', () => {
      expect([...DECISION_TOOL_NAMES]).toEqual([
        'decision_decide',
        'decision_gate',
        'decision_rerank',
        'decision_batch',
        'decision_locate',
        'decision_usage',
        'decision_history',
        'decision_recheck',
        'decision_calibrate',
        'decision_arbiter',
      ]);
    });
  });

  describe('volatile 解包（设置面板写入路径）', () => {
    const write = Symbol.for('cosmokit.volatile.write');
    const wrap = (value: unknown): unknown => ({
      get: () => value,
      [write]: () => {},
    });

    it('resolveToolsConfig 接受 volatile 引用形态的配置', () => {
      const resolved = resolveToolsConfig({
        systemoneBaseUrl: wrap('https://decision.example.internal/'),
        systemoneApiKey: wrap('secret-key'),
        systemoneModel: wrap('local-decision-model'),
        toolsDecideEnabled: wrap(true),
        systemoneTimeoutMs: wrap(45_000),
      });
      expect(resolved.systemoneBaseUrl).toBe(
        'https://decision.example.internal',
      );
      expect(resolved.systemoneApiKey).toBe('secret-key');
      expect(resolved.systemoneModel).toBe('local-decision-model');
      expect(resolved.toolsDecideEnabled).toBe(true);
      expect(resolved.systemoneTimeoutMs).toBe(45_000);
    });

    it('volatile 引用与普通字面量两种形态都能读出值', () => {
      const literal = resolveToolsConfig({
        systemoneModel: 'literal-model',
        toolsDecideEnabled: true,
      });
      expect(literal.systemoneModel).toBe('literal-model');
      expect(literal.toolsDecideEnabled).toBe(true);

      const volatile = resolveToolsConfig({
        systemoneModel: wrap('volatile-model'),
        toolsDecideEnabled: wrap(true),
      });
      expect(volatile.systemoneModel).toBe('volatile-model');
      expect(volatile.toolsDecideEnabled).toBe(true);
    });

    it('volatile 形态的开关关闭值也能正确读出 false', () => {
      const resolved = resolveToolsConfig({
        toolsDecideEnabled: wrap(false),
        toolsGateEnabled: wrap(true),
      });
      expect(resolved.toolsDecideEnabled).toBe(false);
      expect(resolved.toolsGateEnabled).toBe(true);
    });
  });
});
