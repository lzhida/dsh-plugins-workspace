import { describe, expect, it } from 'vitest';

import { resolveToolsConfig } from '../config/index.ts';
import { fingerprintOf } from '../runtime/guard.ts';
import { createMemoryLedger } from '../runtime/ledger.ts';
import { createPassthroughBudgetGate } from '../runtime/budget.ts';
import type { DecisionCallDeps } from '../runtime/call.ts';
import {
  createLocateTool,
  LOCATE_TOOL,
  planLocate,
  buildLocateQuestions,
  buildLocateAssets,
  buildLocateState,
  parseLocateBox,
  deriveBoxGeometry,
  stripDataUriPrefix,
} from './locate.ts';

const EXEC = { signal: new AbortController().signal } as {
  signal: AbortSignal;
};

const baseConfig = (overrides: Record<string, unknown> = {}) =>
  resolveToolsConfig({
    systemoneBaseUrl: 'http://127.0.0.1:3425',
    systemoneApiKey: 'key-test',
    systemoneModel: 'model-test',
    toolsLocateEnabled: true,
    ledgerEnabled: true,
    ...overrides,
  });

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

const stubFetch = (
  payload: unknown,
  status = 200,
): { fetchImpl: DecisionCallDeps['fetchImpl']; calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const fetchImpl = async (
    url: string,
    init: { headers: Record<string, string>; body: string },
  ) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const text =
      typeof payload === 'string' ? payload : JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    };
  };
  return { fetchImpl: fetchImpl as DecisionCallDeps['fetchImpl'], calls };
};

const harness = (
  fetchImpl: DecisionCallDeps['fetchImpl'],
  options: { config?: ReturnType<typeof baseConfig>; verified?: boolean } = {},
): DecisionCallDeps => {
  const config = options.config ?? baseConfig();
  return {
    readConfig: () => config,
    getVerifySnapshot: () =>
      options.verified === false
        ? undefined
        : {
            fingerprint: fingerprintOf(config),
            verifiedAt: new Date().toISOString(),
          },
    ledger: createMemoryLedger(100),
    budget: createPassthroughBudgetGate(),
    fetchImpl,
  };
};

const boxPayload = (
  box: unknown = { top: 0.1, bottom: 0.5, left: 0.2, right: 0.8 },
  confidence: unknown = 0.88,
) => ({
  answers: {
    target: { type: 'box', box, confidence },
  },
  usage: { input_tokens: 12, output_tokens: 6 },
});

const validArgs = () => ({
  image: { format: 'png', dataBase64: 'iVBORw0KGgoAAAANSUhEUg==' },
  target: '红色按钮',
});

describe('dsh-decision locate 工具', () => {
  it('工具名遵循 decision_ 前缀', () => {
    expect(LOCATE_TOOL).toBe('decision_locate');
  });

  it('planLocate 接受合法入参并剥掉 data URI 前缀', () => {
    const planned = planLocate({
      image: { format: 'jpeg', dataBase64: 'data:image/jpeg;base64,AAAA' },
      target: 'logo',
    });
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.plan.format).toBe('jpeg');
      expect(planned.plan.dataBase64).toBe('AAAA');
      expect(planned.plan.questionId).toBe('target');
    }
  });

  it('planLocate 拒绝非法格式、缺 target、超长 target 与非法 base64', () => {
    expect(
      planLocate({ image: { format: 'gif', dataBase64: 'AAAA' }, target: 'x' })
        .ok,
    ).toBe(false);
    expect(
      planLocate({ image: { format: 'png', dataBase64: 'AAAA' }, target: '' })
        .ok,
    ).toBe(false);
    expect(
      planLocate({
        image: { format: 'png', dataBase64: 'AAAA' },
        target: 'x'.repeat(301),
      }).ok,
    ).toBe(false);
    expect(
      planLocate({ image: { format: 'png', dataBase64: 'AA AA' }, target: 'x' })
        .ok,
    ).toBe(false);
    expect(
      planLocate({ image: { format: 'png', dataBase64: 'A@AA' }, target: 'x' })
        .ok,
    ).toBe(false);
  });

  it('stripDataUriPrefix 只剥前缀不改正文', () => {
    expect(stripDataUriPrefix('data:image/png;base64,QUJD')).toBe('QUJD');
    expect(stripDataUriPrefix('QUJD')).toBe('QUJD');
  });

  it('请求组装把图像放进 assets 且占位符出现在 question 指令里', () => {
    const planned = planLocate(validArgs());
    if (!planned.ok) throw new Error('plan should be ok');
    const questions = buildLocateQuestions(planned.plan);
    const assets = buildLocateAssets(planned.plan);
    const state = buildLocateState();
    const keys = Object.keys(assets);
    expect(keys).toHaveLength(1);
    const placeholder = keys[0];
    expect(questions.target?.instructions).toContain(placeholder);
    expect(questions.target?.instructions).toContain('红色按钮');
    expect(questions.target?.type).toBe('box');
    expect(state).toContain('PURPOSE:');
    expect(state).toContain(placeholder);
  });

  it('parseLocateBox 拒绝题型不符、越界与倒置', () => {
    expect(parseLocateBox(undefined).ok).toBe(false);
    expect(
      parseLocateBox({
        kind: 'noul',
        pYes: 0.5,
        confidence: null,
        probabilities: null,
      }).ok,
    ).toBe(false);
    expect(
      parseLocateBox({
        kind: 'box',
        box: { top: 0.1, bottom: 1.4, left: 0, right: 1 },
        confidence: null,
      }).ok,
    ).toBe(false);
    expect(
      parseLocateBox({
        kind: 'box',
        box: { top: 0.6, bottom: 0.4, left: 0, right: 1 },
        confidence: null,
      }).ok,
    ).toBe(false);
  });

  it('deriveBoxGeometry 派生中心与宽高', () => {
    const geometry = deriveBoxGeometry({
      top: 0.1,
      bottom: 0.5,
      left: 0.2,
      right: 0.8,
    });
    expect(geometry.center).toEqual({ x: 0.5, y: 0.3 });
    expect(geometry.width).toBe(0.6);
    expect(geometry.height).toBe(0.4);
  });

  it('全链路成功：返回归一化坐标框 + 派生几何 + 账本落条', async () => {
    const { fetchImpl, calls } = stubFetch(boxPayload());
    const deps = harness(fetchImpl);
    const result = await createLocateTool(deps).execute?.(
      validArgs(),
      EXEC as never,
    );
    const output = result as Record<string, unknown>;
    expect(output.ok).toBe(true);
    expect(output.box).toEqual({
      top: 0.1,
      bottom: 0.5,
      left: 0.2,
      right: 0.8,
    });
    expect(output.center).toEqual({ x: 0.5, y: 0.3 });
    expect(output.confidence).toBe(0.88);
    expect(output.source).toBe('decision-model');
    expect(typeof output.decisionId).toBe('string');
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0].body) as {
      assets?: Record<string, unknown>;
    };
    expect(Object.keys(body.assets ?? {})).toHaveLength(1);
    expect(calls[0].headers['TypeSafe-Danger-Zone-Images']).toBe('true');
    expect(deps.ledger?.list()).toHaveLength(1);
    expect(deps.ledger?.list()[0].questionType).toBe('box');
  });

  it('上游未返回定位题 → model-unsupported-capability 且不出坐标', async () => {
    const { fetchImpl } = stubFetch({
      answers: {},
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const result = (await createLocateTool(harness(fetchImpl)).execute?.(
      validArgs(),
      EXEC as never,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    const error = result.error as { code: string; retryable: boolean };
    expect(error.code).toBe('model-unsupported-capability');
    expect(error.retryable).toBe(false);
    expect(result.box).toBeUndefined();
  });

  it('上游返回非 box 题型 → model-invalid-response 可重试', async () => {
    const { fetchImpl } = stubFetch({
      answers: { target: { type: 'noul', noul: 0.7, confidence: 0.6 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const result = (await createLocateTool(harness(fetchImpl)).execute?.(
      validArgs(),
      EXEC as never,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect((result.error as { code: string }).code).toBe(
      'model-invalid-response',
    );
  });

  it('倒置坐标框 → model-invalid-response 可重试且不夹取/交换', async () => {
    // bottom < top：契约 §3.5 判为倒置，属形状非法（不是「上游丢题」）
    const { fetchImpl } = stubFetch(
      boxPayload({ top: 0.6, bottom: 0.2, left: 0.2, right: 0.8 }),
    );
    const result = (await createLocateTool(harness(fetchImpl)).execute?.(
      validArgs(),
      EXEC as never,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    const error = result.error as {
      code: string;
      retryable: boolean;
      details?: Record<string, unknown>;
    };
    expect(error.code).toBe('model-invalid-response');
    expect(error.retryable).toBe(true);
    expect(error.details?.dropped).toBe(false);
    expect(result.box).toBeUndefined();
    expect(result.center).toBeUndefined();
  });

  it('上游返回越界坐标（>1）→ client 归非法 → model-invalid-response', async () => {
    const { fetchImpl } = stubFetch(
      boxPayload({ top: 0.1, bottom: 0.5, left: 0.2, right: 1.7 }),
    );
    const result = (await createLocateTool(harness(fetchImpl)).execute?.(
      validArgs(),
      EXEC as never,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect((result.error as { code: string }).code).toBe(
      'model-invalid-response',
    );
    expect(result.box).toBeUndefined();
  });

  it('HTTP 400 且报文提到 box → model-unsupported-capability', async () => {
    const { fetchImpl } = stubFetch(
      { error: 'model does not support box questions' },
      400,
    );
    const result = (await createLocateTool(harness(fetchImpl)).execute?.(
      validArgs(),
      EXEC as never,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect((result.error as { code: string }).code).toBe(
      'model-unsupported-capability',
    );
  });

  it('开关关闭 → tool-disabled 且不出网', async () => {
    const { fetchImpl, calls } = stubFetch(boxPayload());
    const deps = harness(fetchImpl, {
      config: baseConfig({ toolsLocateEnabled: false }),
    });
    const result = (await createLocateTool(deps).execute?.(
      validArgs(),
      EXEC as never,
    )) as Record<string, unknown>;
    expect(result.ok).toBe(false);
    expect((result.error as { code: string }).code).toBe('tool-disabled');
    expect(calls).toHaveLength(0);
  });

  it('未配置模型 / 未验证 → 契约错误码且不出网', async () => {
    const { fetchImpl, calls } = stubFetch(boxPayload());
    const unconfigured = harness(fetchImpl, {
      config: baseConfig({
        systemoneBaseUrl: '',
        systemoneApiKey: '',
        systemoneModel: '',
      }),
    });
    const r1 = (await createLocateTool(unconfigured).execute?.(
      validArgs(),
      EXEC as never,
    )) as Record<string, unknown>;
    expect((r1.error as { code: string }).code).toBe('model-not-configured');

    const unverified = harness(fetchImpl, { verified: false });
    const r2 = (await createLocateTool(unverified).execute?.(
      validArgs(),
      EXEC as never,
    )) as Record<string, unknown>;
    expect((r2.error as { code: string }).code).toBe('model-verify-failed');
    expect(calls).toHaveLength(0);
  });

  it('非法入参 → invalid-arguments 且不出网', async () => {
    // 宿主层 defineTool 会先按 schema 拒绝缺失必填项（ToolArgsError），
    // 因此这里直接验证工具自身的 planLocate 校验分支。
    const planned = planLocate({
      image: { format: 'webp', dataBase64: 'AAAA' },
      target: 'x',
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.error.code).toBe('invalid-arguments');
    const emptyTarget = planLocate({
      image: { format: 'png', dataBase64: 'AAAA' },
      target: '',
    });
    expect(emptyTarget.ok).toBe(false);
    if (!emptyTarget.ok)
      expect(emptyTarget.error.code).toBe('invalid-arguments');
  });
});
