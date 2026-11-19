import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply, inject, name } from './entries/ask-gate.ts';
import {
  Config,
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_DECISION_TIMEOUT_MS,
  resolveConfig,
} from './core/config.ts';
import type { DecisionLlmLike } from './core/decision.ts';
import {
  buildAutoAnswers,
  buildAutoMeta,
  buildDecisionPrompt,
  buildDegradedMeta,
  DECISION_AUTO_ANSWER_PREFIX,
  DECISION_SYSTEM_PROMPT,
  toAskGateAnswerItem,
  toUserQuestionItem,
  type AskGateQuestion,
  type AskGateAnswer,
} from './services/ask-gate.ts';

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  output: unknown;
  execute: (args: unknown, exec: unknown) => Promise<unknown>;
}

interface StubContext {
  tools: { register: (definition: RegisteredTool) => void };
  userQuestions?: {
    ask: (request: unknown) => Promise<unknown>;
  };
  get?: (key: string) => unknown;
  registered: RegisteredTool[];
  disposers: (() => void)[];
  logs: string[];
}

function stubContext(
  ask?: (request: unknown) => Promise<unknown>,
  opts?: { llm?: DecisionLlmLike },
): StubContext {
  const registered: RegisteredTool[] = [];
  const disposers: (() => void)[] = [];
  const logs: string[] = [];
  const ctx: StubContext = {
    tools: {
      register: (definition) => {
        registered.push(definition);
      },
    },
    registered,
    disposers,
    logs,
  };
  if (ask) {
    ctx.userQuestions = { ask };
  }
  if (opts?.llm !== undefined) {
    ctx.get = (key: string) => (key === 'llm' ? opts.llm : undefined);
  }
  return ctx;
}

/** 门控路径的合法配置（总开关开启 + 指向 stub 决策模型的假路由）。 */
const GATED_CONFIG = {
  enabled: true,
  decisionProvider: 'stub',
  decisionModel: 'decider',
  confidenceThreshold: 0.8,
  decisionTimeoutMs: 5_000,
};

/** 构造一个最小可用的决策模型 stub：产出给定 JSON 文本后正常收尾。 */
function stubDecisionLlm(replyJson: string): DecisionLlmLike {
  return {
    prepareCall: async () => ({
      config: { provider: 'stub', model: 'decider' },
      stream: async function* generate() {
        yield { type: 'text-delta', index: 0, text: replyJson };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    }),
  };
}

/** ask stub：记录调用并回传单问题答案。 */
function recordingAsk(): {
  ask: (request: unknown) => Promise<unknown>;
  calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    ask: async (request) => {
      calls.push(request);
      return {
        answers: [{ id: 'q1', selected: ['docx'], custom: '真人选择' }],
      };
    },
  };
}

/** 把 stub 上下文伪装成 cordis Context（只实现本插件行用到的那几个面）。 */
function asContext(ctx: StubContext): never {
  return ctx as unknown as never;
}

const QUESTIONS: AskGateQuestion[] = [
  {
    id: 'q1',
    question: '请选择交付形态',
    header: '交付',
    options: [{ label: 'docx', description: '按 docx 交付' }],
    multi_select: false,
  },
];

describe('dsh-decision ask-gate', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      // 静默装载日志
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('导出插件三契约符号', () => {
    expect(name).toBe('ask-gate');
    expect(typeof apply).toBe('function');
    expect(inject).toContain('tools');
    expect(inject).toContain('userQuestions');
  });

  it('装载时打印 [ask-gate] plugin loaded 并注册同名提问工具', () => {
    const ctx = stubContext();
    apply(asContext(ctx), undefined);
    expect(console.log).toHaveBeenCalledWith('[ask-gate] plugin loaded');
    expect(ctx.registered).toHaveLength(1);
    expect(ctx.registered[0].name).toBe('ask_user_question');
  });

  it('工具参数与出参 schema 与出厂 legacy 模式兼容', () => {
    const ctx = stubContext();
    apply(asContext(ctx), undefined);
    const tool = ctx.registered[0];
    // defineTool 把 parameters 编译成 JSON Schema（properties 子树）
    const parameters = tool.parameters as {
      type: string;
      properties: {
        questions: {
          type: string;
          required?: boolean;
          items: {
            additionalProperties: boolean;
            properties: Record<string, { required?: boolean; type: string }>;
          };
        };
      };
      required?: string[];
    };
    expect(parameters.type).toBe('object');
    const questions = parameters.properties.questions;
    expect(questions.type).toBe('array');
    // defineTool 编译后 required 是 JSON Schema 数组形态
    expect(parameters.required ?? []).toContain('questions');
    expect(questions.items.additionalProperties).toBe(true);
    const itemRequired =
      (questions.items as { required?: string[] }).required ?? [];
    expect(itemRequired).toEqual(expect.arrayContaining(['id', 'question']));
    expect(questions.items.properties.multi_select.type).toBe('boolean');
    const output = tool.output as {
      schema: {
        additionalProperties: boolean;
        required?: string[];
        properties: {
          answers: {
            type: string;
            items: {
              additionalProperties: boolean;
              required?: string[];
            };
          };
        };
      };
    };
    expect(output.schema.additionalProperties).toBe(true);
    expect(output.schema.required ?? []).toContain('answers');
    expect(output.schema.properties.answers.type).toBe('array');
    expect(output.schema.properties.answers.items.required ?? []).toEqual(
      expect.arrayContaining(['id', 'selected']),
    );
  });

  it('execute 直通宿主提问通道并回传答案', async () => {
    const seen: unknown[] = [];
    const ctx = stubContext(async (request) => {
      seen.push(request);
      return {
        answers: [{ id: 'q1', selected: ['docx'] }],
      };
    });
    apply(asContext(ctx), undefined);
    const result = await ctx.registered[0].execute(
      { questions: QUESTIONS },
      { agent: undefined, signal: undefined },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      questions: [
        {
          id: 'q1',
          question: '请选择交付形态',
          header: '交付',
          options: [{ label: 'docx', description: '按 docx 交付' }],
          multiSelect: false,
        },
      ],
    });
    expect(result).toEqual({ answers: [{ id: 'q1', selected: ['docx'] }] });
  });

  it('宿主错误语义原样透传（DELEGATED_CALLER 不被吞）', async () => {
    const failure = new Error(
      'human interaction is unavailable while the calling agent is owned by another live agent',
    );
    const ctx = stubContext(async () => {
      throw failure;
    });
    apply(asContext(ctx), undefined);
    await expect(
      ctx.registered[0].execute(
        { questions: QUESTIONS },
        { agent: undefined, signal: undefined },
      ),
    ).rejects.toBe(failure);
  });

  it('宿主未提供 userQuestions 服务时抛出可操作错误', async () => {
    const ctx = stubContext();
    apply(asContext(ctx), undefined);
    await expect(
      ctx.registered[0].execute(
        { questions: QUESTIONS },
        { agent: undefined, signal: undefined },
      ),
    ).rejects.toThrow(/userQuestions service is unavailable/);
  });

  it('映射层只换名不裁字段', () => {
    const item = toUserQuestionItem({
      id: 'q1',
      question: '问题',
      options: [{ label: 'a' }],
      multi_select: true,
    });
    expect(item.multiSelect).toBe(true);
    expect(item.options).toEqual([{ label: 'a' }]);
    expect('multi_select' in item).toBe(false);
    const answer = toAskGateAnswerItem({
      id: 'q1',
      selected: ['a'],
      custom: '备注',
    });
    expect(answer).toEqual({ id: 'q1', selected: ['a'], custom: '备注' });
  });

  it('配置面：总开关默认关闭，非法输入降级为默认', () => {
    const resolved = resolveConfig(undefined);
    expect(resolved.enabled).toBe(false);
    expect(resolved.decisionProvider).toBe('');
    expect(resolved.decisionModel).toBe('');
    expect(resolved.confidenceThreshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(resolved.decisionTimeoutMs).toBe(DEFAULT_DECISION_TIMEOUT_MS);
    expect(() => resolveConfig('not-an-object')).not.toThrow();
    const dict = (Config as unknown as { dict: Record<string, unknown> }).dict;
    expect(Object.keys(dict)).toEqual(
      expect.arrayContaining([
        'enabled',
        'decisionProvider',
        'decisionModel',
        'confidenceThreshold',
        'decisionTimeoutMs',
      ]),
    );
    // 非法阈值/超时回落默认，而不是把坏值带进运行时。
    expect(
      resolveConfig({ confidenceThreshold: 1.5 }).confidenceThreshold,
    ).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(resolveConfig({ confidenceThreshold: -1 }).confidenceThreshold).toBe(
      DEFAULT_CONFIDENCE_THRESHOLD,
    );
    expect(resolveConfig({ decisionTimeoutMs: 0 }).decisionTimeoutMs).toBe(
      DEFAULT_DECISION_TIMEOUT_MS,
    );
    expect(
      resolveConfig({ confidenceThreshold: 0.65, decisionTimeoutMs: 9_000 }),
    ).toMatchObject({ confidenceThreshold: 0.65, decisionTimeoutMs: 9_000 });
  });

  it('门控开启但决策模型路由未配置时放行真实提问并落 route-not-configured', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const asker = recordingAsk();
    const ctx = stubContext(asker.ask);
    apply(asContext(ctx), {
      enabled: true,
      decisionProvider: '',
      decisionModel: '',
    });
    const result = (await ctx.registered[0].execute(
      { questions: QUESTIONS },
      { agent: undefined, signal: undefined },
    )) as { answers: unknown[]; presentationMeta?: Record<string, unknown> };
    expect(asker.calls).toHaveLength(1);
    expect(result.answers).toEqual([
      { id: 'q1', selected: ['docx'], custom: '真人选择' },
    ]);
    expect(result.presentationMeta).toEqual({
      confidence: 0,
      decision: 'passed-through',
      rationale: 'route-not-configured',
    });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('decision model not configured'),
    );
  });

  it('高置信建议覆盖全部问题时自动作答，不触达真实提问', async () => {
    const asker = recordingAsk();
    const ctx = stubContext(asker.ask, {
      llm: stubDecisionLlm(
        JSON.stringify({
          confidence: 0.95,
          answers: [{ id: 'q1', selected: ['docx'] }],
          reason: '用户明确偏好 docx 交付',
        }),
      ),
    });
    apply(asContext(ctx), GATED_CONFIG);
    const result = (await ctx.registered[0].execute(
      { questions: QUESTIONS },
      { agent: undefined, signal: undefined },
    )) as {
      answers: { id: string; selected: string[]; custom?: string }[];
      presentationMeta?: Record<string, unknown>;
    };
    expect(asker.calls).toHaveLength(0);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].id).toBe('q1');
    expect(result.answers[0].selected).toEqual(['docx']);
    expect(result.answers[0].custom).toContain(DECISION_AUTO_ANSWER_PREFIX);
    // 模型只给选项没给 custom 时，detail 兜底为所选选项（理由落 meta）。
    expect(result.answers[0].custom).toContain('choose docx');
    expect(result.presentationMeta).toEqual({
      confidence: 0.95,
      decision: 'auto-answered',
      rationale: '用户明确偏好 docx 交付',
    });
  });

  it('低置信放行真实提问并落 passed-through meta', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const asker = recordingAsk();
    const ctx = stubContext(asker.ask, {
      llm: stubDecisionLlm(
        JSON.stringify({
          confidence: 0.3,
          answers: [{ id: 'q1', selected: ['docx'] }],
          reason: '没有可靠默认',
        }),
      ),
    });
    apply(asContext(ctx), GATED_CONFIG);
    const result = (await ctx.registered[0].execute(
      { questions: QUESTIONS },
      { agent: undefined, signal: undefined },
    )) as { presentationMeta?: Record<string, unknown> };
    expect(asker.calls).toHaveLength(1);
    expect(result.presentationMeta).toEqual({
      confidence: 0.3,
      decision: 'passed-through',
      rationale: '没有可靠默认',
    });
    // 低置信不是降级：日志走「below threshold」出口，信号位不得出现 'ok'
    // （否则读日志的人会把「评估成功但没把握」误当成「模型调用失败」）。
    const warnText = spy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(warnText).toContain('decision below threshold');
    expect(warnText).not.toContain('decision degraded');
    expect(warnText).not.toContain('(ok,');
  });

  it('决策模型降级（llm 服务缺失）时放行并落降级 meta', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const asker = recordingAsk();
    const ctx = stubContext(asker.ask);
    apply(asContext(ctx), GATED_CONFIG);
    const result = (await ctx.registered[0].execute(
      { questions: QUESTIONS },
      { agent: undefined, signal: undefined },
    )) as { presentationMeta?: Record<string, unknown> };
    expect(asker.calls).toHaveLength(1);
    expect(result.presentationMeta).toEqual({
      confidence: 0,
      decision: 'passed-through',
      rationale: 'llm-unavailable',
    });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('decision degraded'),
    );
  });

  it('建议答案未覆盖全部问题时放行真实提问', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const asker = recordingAsk();
    const ctx = stubContext(asker.ask, {
      llm: stubDecisionLlm(
        JSON.stringify({
          confidence: 0.99,
          answers: [{ id: 'other', selected: ['x'] }],
        }),
      ),
    });
    apply(asContext(ctx), GATED_CONFIG);
    await ctx.registered[0].execute(
      { questions: QUESTIONS },
      { agent: undefined, signal: undefined },
    );
    expect(asker.calls).toHaveLength(1);
  });

  it('决策模型回了非 JSON 时按解析失败落 meta（不再把 ok 当降级理由）', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const asker = recordingAsk();
    const ctx = stubContext(asker.ask, {
      llm: stubDecisionLlm('这不是 JSON'),
    });
    apply(asContext(ctx), GATED_CONFIG);
    const result = (await ctx.registered[0].execute(
      { questions: QUESTIONS },
      { agent: undefined, signal: undefined },
    )) as { presentationMeta?: Record<string, unknown> };
    expect(asker.calls).toHaveLength(1);
    expect(result.presentationMeta).toEqual({
      confidence: 0,
      decision: 'passed-through',
      rationale: 'no-json-object',
    });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('no-json-object'));
  });

  it('空问题清单直通宿主，不发起决策调用', async () => {
    const asker = recordingAsk();
    let prepared = 0;
    const ctx = stubContext(asker.ask, {
      llm: {
        prepareCall: async () => {
          prepared += 1;
          return {
            config: { provider: 'stub', model: 'decider' },
            stream: async function* generate() {
              yield { type: 'text-delta', index: 0, text: '{}' };
              yield { type: 'finish', reason: { kind: 'stop' } };
            },
          };
        },
      },
    });
    apply(asContext(ctx), GATED_CONFIG);
    await ctx.registered[0].execute(
      { questions: [] },
      { agent: undefined, signal: undefined },
    );
    expect(asker.calls).toHaveLength(1);
    expect(prepared).toBe(0);
  });

  it('配置面：NaN 与 Infinity 回落默认值', () => {
    expect(
      resolveConfig({ confidenceThreshold: Number.NaN }).confidenceThreshold,
    ).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(
      resolveConfig({ confidenceThreshold: Number.POSITIVE_INFINITY })
        .confidenceThreshold,
    ).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(
      resolveConfig({ decisionTimeoutMs: Number.POSITIVE_INFINITY })
        .decisionTimeoutMs,
    ).toBe(DEFAULT_DECISION_TIMEOUT_MS);
  });
});

describe('dsh-decision 门控纯函数', () => {
  it('buildDecisionPrompt：确定性拼接问题清单与输出格式要求', () => {
    const prompt = buildDecisionPrompt([
      {
        id: 'q1',
        question: '交付形态?',
        options: [{ label: 'docx' }, { label: 'pdf' }],
        multi_select: false,
      },
      { id: 'q2', question: '补充说明?' },
      {
        id: 'q3',
        question: '可选附加?',
        options: [{ label: 'yes' }],
        multi_select: true,
      },
    ]);
    expect(prompt).toContain('"q1"');
    expect(prompt).toContain('"docx", "pdf"');
    expect(prompt).toContain('multi-select');
    expect(prompt).toContain('"q2"');
    expect(prompt).toContain('"q3"');
    expect(prompt).toContain('JSON');
    // system 纪律要求输出单个 JSON 对象
    expect(DECISION_SYSTEM_PROMPT).toContain('"confidence"');
    expect(DECISION_SYSTEM_PROMPT).toContain('"answers"');
  });

  it('buildAutoAnswers：覆盖不全返回 undefined；选项 label 白名单过滤', () => {
    const questions: AskGateQuestion[] = [
      { id: 'q1', question: '形态?', options: [{ label: 'docx' }] },
      { id: 'q2', question: '备注?' },
    ];
    // 缺 q2 → 放行
    expect(
      buildAutoAnswers(questions, {
        ok: true,
        confidence: 0.9,
        answers: [{ id: 'q1', selected: ['docx'] }],
      }),
    ).toBeUndefined();
    // 全覆盖：幻觉 label 被剔除，custom 兜底带前缀
    const answer = buildAutoAnswers(questions, {
      ok: true,
      confidence: 0.9,
      reason: '默认即可',
      answers: [
        { id: 'q1', selected: ['docx', 'hallucinated'] },
        { id: 'q2', selected: [], custom: '无需备注' },
      ],
    }) as AskGateAnswer;
    expect(answer.answers).toHaveLength(2);
    expect(answer.answers[0].selected).toEqual(['docx']);
    expect(answer.answers[0].custom).toContain(DECISION_AUTO_ANSWER_PREFIX);
    expect(answer.answers[1].custom).toContain('无需备注');
    // 无 answers 字段 → undefined
    expect(
      buildAutoAnswers(questions, { ok: true, confidence: 0.9 }),
    ).toBeUndefined();
  });

  it('buildAutoMeta/buildDegradedMeta：落账 meta 形态稳定', () => {
    expect(
      buildAutoMeta(
        { ok: true, confidence: 0.88, reason: '低风险默认' },
        'auto-answered',
      ),
    ).toEqual({
      confidence: 0.88,
      decision: 'auto-answered',
      rationale: '低风险默认',
    });
    expect(buildDegradedMeta('timeout')).toEqual({
      confidence: 0,
      decision: 'passed-through',
      rationale: 'timeout',
    });
  });

  it('buildAutoAnswers：多问题全覆盖与重复 id 的处理', () => {
    const questions: AskGateQuestion[] = [
      { id: 'q1', question: '形态?', options: [{ label: 'docx' }] },
      { id: 'q2', question: '是否加急?', options: [{ label: '是' }] },
    ];
    const answer = buildAutoAnswers(questions, {
      ok: true,
      confidence: 0.9,
      reason: '默认即可',
      answers: [
        { id: 'q1', selected: ['docx'] },
        { id: 'q2', selected: ['是'] },
      ],
    }) as AskGateAnswer;
    expect(answer.answers.map((item) => item.id)).toEqual(['q1', 'q2']);
    expect(answer.answers[1].selected).toEqual(['是']);
    // 重复 id：后写的建议覆盖前一条，仍视为覆盖（id 唯一时天然不重复）
    const duplicated = buildAutoAnswers(
      [
        {
          id: 'q1',
          question: '形态?',
          options: [{ label: 'docx' }, { label: 'pdf' }],
        },
      ],
      {
        ok: true,
        confidence: 0.9,
        answers: [
          { id: 'q1', selected: ['docx'] },
          { id: 'q1', selected: ['pdf'] },
        ],
      },
    ) as AskGateAnswer;
    expect(duplicated.answers[0].selected).toEqual(['pdf']);
  });

  it('buildAutoAnswers：选项 label 全是幻觉且无 custom 时视为没被回答', () => {
    const questions: AskGateQuestion[] = [
      { id: 'q1', question: '形态?', options: [{ label: 'docx' }] },
    ];
    expect(
      buildAutoAnswers(questions, {
        ok: true,
        confidence: 0.9,
        reason: '随手一说',
        answers: [{ id: 'q1', selected: ['完全不存在'] }],
      }),
    ).toBeUndefined();
    // 给了 custom 文字则仍算回答（selected 允许为空）
    const answered = buildAutoAnswers(questions, {
      ok: true,
      confidence: 0.9,
      answers: [{ id: 'q1', selected: [], custom: '让工程判断' }],
    }) as AskGateAnswer;
    expect(answered.answers[0].selected).toEqual([]);
    expect(answered.answers[0].custom).toContain('让工程判断');
  });
});
