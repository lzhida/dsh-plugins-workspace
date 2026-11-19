/**
 * dsh-decision 决策底座纯函数与调用封装单测（决策门控系列 2/4）。
 *
 * 测试模式照抄 packages/dsh-llm-fallback（describe 用包名、it 中文动宾、
 * vi.spyOn(console) 静默、afterEach 还原）；调用封装用 duck-typing stub
 * 模拟宿主 ctx.llm，覆盖 ok / 模型报错 / 超时 / 中止 / 未配置全部路径。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildDecisionStreamOptions,
  decide,
  decideByThreshold,
  parseDecisionResponse,
  runDecisionCall,
  type DecisionLlmLike,
} from './decision.ts';

describe('dsh-decision core', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  /** 构造一个最小可用的 ctx.llm stub：prepareCall 返回给定块序列。 */
  function stubLlm(
    chunks: unknown[],
    overrides?: {
      prepareCall?: DecisionLlmLike['prepareCall'];
      stream?: (options: Record<string, unknown>) => AsyncIterable<unknown>;
    },
  ): DecisionLlmLike {
    // 每次 stream(options) 调用都产出新 generator 实例（对齐宿主一次性分发语义）。
    const stream = (
      options: Record<string, unknown>,
    ): AsyncIterable<unknown> =>
      overrides?.stream
        ? overrides.stream(options)
        : (async function* generate() {
            for (const chunk of chunks) {
              yield chunk;
            }
          })();
    return {
      prepareCall:
        overrides?.prepareCall ??
        (async () => ({
          config: { provider: 'openai', model: 'gpt-4o', maxTokens: 512 },
          stream,
        })),
    };
  }

  const ROUTE = { provider: 'openai', model: 'gpt-4o', timeoutMs: 5_000 };

  describe('runDecisionCall（调用封装）', () => {
    it('正常流：拼接 text-delta 并回填 call.config 到 stream options', async () => {
      const seenOptions: Record<string, unknown>[] = [];
      const llm = stubLlm([], {
        async *stream(options) {
          seenOptions.push(options);
          yield { type: 'text-delta', index: 0, text: '{"confidence":' };
          yield { type: 'text-delta', index: 0, text: '0.9}' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      const outcome = await runDecisionCall(llm, { prompt: '判定' }, ROUTE);
      expect(outcome).toEqual({
        kind: 'ok',
        text: '{"confidence":0.9}',
      });
      expect(seenOptions).toHaveLength(1);
      expect(seenOptions[0]?.provider).toBe('openai');
      expect(seenOptions[0]?.model).toBe('gpt-4o');
      expect(seenOptions[0]?.maxTokens).toBe(512);
      const messages = seenOptions[0]?.messages as Array<
        Record<string, unknown>
      >;
      expect(messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: '判定' }] },
      ]);
    });

    it('system 提示非空时进入 stream options；空串与缺省不携带', async () => {
      const seenOptions: Record<string, unknown>[] = [];
      const llm = stubLlm([], {
        async *stream(options) {
          seenOptions.push(options);
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      await runDecisionCall(llm, { prompt: 'p', system: '纪律' }, ROUTE);
      await runDecisionCall(llm, { prompt: 'p', system: '' }, ROUTE);
      await runDecisionCall(llm, { prompt: 'p' }, ROUTE);
      expect(seenOptions[0]?.system).toBe('纪律');
      expect('system' in (seenOptions[1] ?? {})).toBe(false);
      expect('system' in (seenOptions[2] ?? {})).toBe(false);
    });

    it('provider 或 model 为空串 → route-invalid，不触碰 llm', async () => {
      const probe = vi.fn();
      const broken = { prepareCall: probe } as unknown as DecisionLlmLike;
      expect(
        await runDecisionCall(
          broken,
          { prompt: 'p' },
          { ...ROUTE, provider: '' },
        ),
      ).toEqual({
        kind: 'route-invalid',
      });
      expect(
        await runDecisionCall(broken, { prompt: 'p' }, { ...ROUTE, model: '' }),
      ).toEqual({
        kind: 'route-invalid',
      });
      expect(probe).not.toHaveBeenCalled();
    });

    it('llm 缺失或形态不齐 → llm-unavailable', async () => {
      expect(await runDecisionCall(undefined, { prompt: 'p' }, ROUTE)).toEqual({
        kind: 'llm-unavailable',
      });
      expect(
        await runDecisionCall({} as DecisionLlmLike, { prompt: 'p' }, ROUTE),
      ).toEqual({
        kind: 'llm-unavailable',
      });
    });

    it('prepareCall 抛错 → model-error 且不抛穿', async () => {
      const llm = stubLlm([], {
        prepareCall: async () => {
          throw new Error('adapter exploded');
        },
      });
      const outcome = await runDecisionCall(llm, { prompt: 'p' }, ROUTE);
      expect(outcome).toEqual({
        kind: 'model-error',
        message: 'adapter exploded',
      });
    });

    it('流中途抛错 → model-error 且不抛穿', async () => {
      const llm = stubLlm([], {
        async *stream() {
          yield { type: 'text-delta', index: 0, text: 'partial' };
          throw new Error('stream broke');
        },
      });
      const outcome = await runDecisionCall(llm, { prompt: 'p' }, ROUTE);
      expect(outcome).toEqual({ kind: 'model-error', message: 'stream broke' });
    });

    it('自有超时：流挂起超过 timeoutMs → timeout（不抛穿）', async () => {
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const llm = stubLlm([], {
        async *stream() {
          await sleep(120);
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      const outcome = await runDecisionCall(
        llm,
        { prompt: 'p' },
        { ...ROUTE, timeoutMs: 30 },
      );
      expect(outcome).toEqual({ kind: 'timeout' });
    });

    it('调用前上游已中止 → aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const llm = stubLlm([], {
        async *stream() {
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      const outcome = await runDecisionCall(
        llm,
        { prompt: 'p', signal: controller.signal },
        ROUTE,
      );
      expect(outcome).toEqual({ kind: 'aborted' });
    });

    it('调用中上游中止 → aborted（流被切断）', async () => {
      const controller = new AbortController();
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const llm = stubLlm([], {
        async *stream() {
          yield { type: 'text-delta', index: 0, text: 'half' };
          await sleep(60);
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      const pending = runDecisionCall(
        llm,
        { prompt: 'p', signal: controller.signal },
        { ...ROUTE, timeoutMs: 10_000 },
      );
      await sleep(20);
      controller.abort();
      const outcome = await pending;
      expect(outcome).toEqual({ kind: 'aborted' });
    });

    it('收尾竞态：流收尾期间触发自有超时 → timeout，不向调用方抛穿', async () => {
      // 复审回归：abort 落在「chunk 已全部消费、迭代器正常收尾」的间隙时，
      // 旧实现在循环外的裸 throwIfAborted 会把异常抛穿。
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const llm = stubLlm([], {
        async *stream() {
          yield { type: 'text-delta', index: 0, text: '{"confidence":0.9}' };
          await sleep(80); // 收尾挂起期间 timeoutMs 到点
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      const outcome = await runDecisionCall(
        llm,
        { prompt: 'p' },
        { ...ROUTE, timeoutMs: 30 },
      );
      expect(outcome).toEqual({ kind: 'timeout' });
    });

    it('error 终态 finish（操作性失败以终态 chunk 表达）→ model-error', async () => {
      const llm = stubLlm([], {
        async *stream() {
          yield {
            type: 'text-delta',
            index: 0,
            text: '{"confidence":0.95}',
          };
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { message: 'upstream 500', code: 'E_UP' },
            },
          };
        },
      });
      const outcome = await runDecisionCall(llm, { prompt: 'p' }, ROUTE);
      expect(outcome).toEqual({
        kind: 'model-error',
        message: 'upstream 500',
        code: 'E_UP',
      });
    });

    it('aborted 终态 finish → aborted（本地信号未触发时也归一）', async () => {
      const llm = stubLlm([], {
        async *stream() {
          yield { type: 'finish', reason: { kind: 'aborted', failure: {} } };
        },
      });
      expect(await runDecisionCall(llm, { prompt: 'p' }, ROUTE)).toEqual({
        kind: 'aborted',
      });
    });

    it('max-tokens 终态 finish 视为正常完成（截断文本交解析层低置信兜底）', async () => {
      const llm = stubLlm([], {
        async *stream() {
          yield { type: 'text-delta', index: 0, text: '{"confidence":0.9' };
          yield { type: 'finish', reason: { kind: 'max-tokens' } };
        },
      });
      expect(await runDecisionCall(llm, { prompt: 'p' }, ROUTE)).toEqual({
        kind: 'ok',
        text: '{"confidence":0.9',
      });
    });
  });

  describe('parseDecisionResponse（置信度解析）', () => {
    it('解析 ```json 围栏内的结构化结果', () => {
      const result = parseDecisionResponse(
        '判定完成。\n```json\n{"confidence":0.87,"suggestedAnswer":"B","reason":"答案明确"}\n```',
      );
      expect(result.ok).toBe(true);
      expect(result.confidence).toBeCloseTo(0.87);
      expect(result.suggestedAnswer).toBe('B');
      expect(result.reason).toBe('答案明确');
      expect(result.clamped).toBeUndefined();
    });

    it('解析裸 JSON（含前后散文与字符串内花括号）', () => {
      const result = parseDecisionResponse(
        '结论如下 {"confidence":0.5, "reason":"说明 {含} 花括号"} 谢谢',
      );
      expect(result.ok).toBe(true);
      expect(result.confidence).toBeCloseTo(0.5);
      expect(result.reason).toBe('说明 {含} 花括号');
    });

    it('置信度越界 → 钳制到 [0,1] 并标记 clamped', () => {
      const high = parseDecisionResponse('{"confidence":1.4}');
      expect(high.ok).toBe(true);
      expect(high.confidence).toBe(1);
      expect(high.clamped).toBe(true);
      const low = parseDecisionResponse('{"confidence":-0.2}');
      expect(low.ok).toBe(true);
      expect(low.confidence).toBe(0);
      expect(low.clamped).toBe(true);
    });

    it('confidence 非数字 → 低置信 fail（锚定 parseError）', () => {
      const result = parseDecisionResponse('{"confidence":"high"}');
      expect(result.ok).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.parseError).toBe('confidence-not-a-number');
    });

    it('缺 confidence 字段 → 低置信 fail', () => {
      const result = parseDecisionResponse('{"answer":"B"}');
      expect(result.ok).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.parseError).toBe('confidence-not-a-number');
    });

    it('文本里没有 JSON 对象 → fail', () => {
      expect(parseDecisionResponse('我觉得大概率可以吧').parseError).toBe(
        'no-json-object',
      );
      expect(parseDecisionResponse('').parseError).toBe('empty-output');
    });

    it('括号平衡但语法非法的 JSON → json-parse-failed；括号不闭合 → no-json-object', () => {
      expect(parseDecisionResponse('{"confidence":0.9,}').parseError).toBe(
        'json-parse-failed',
      );
      expect(parseDecisionResponse('{"confidence":0.9').parseError).toBe(
        'no-json-object',
      );
    });

    it('支持别名键（confidenceScore / answer / rationale）', () => {
      const result = parseDecisionResponse(
        '{"confidenceScore":0.3,"answer":"直接选 A","rationale":"低置信"}',
      );
      expect(result.ok).toBe(true);
      expect(result.confidence).toBeCloseTo(0.3);
      expect(result.suggestedAnswer).toBe('直接选 A');
      expect(result.reason).toBe('低置信');
    });
  });

  describe('decideByThreshold（阈值判定）', () => {
    it('confidence 等于阈值 → 自动作答（边界归入自动）', () => {
      expect(decideByThreshold(0.8, 0.8)).toEqual({ verdict: 'auto-answered' });
    });

    it('confidence 高于阈值 → 自动作答；低于阈值 → 放行真实提问', () => {
      expect(decideByThreshold(0.95, 0.8).verdict).toBe('auto-answered');
      expect(decideByThreshold(0.2, 0.8).verdict).toBe('passed-through');
    });

    it('阈值非法（0/负数/>1/NaN/±Infinity）→ 一律放行并标记原因', () => {
      expect(decideByThreshold(1, 0)).toEqual({
        verdict: 'passed-through',
        reason: 'invalid-threshold',
      });
      expect(decideByThreshold(1, -0.5).reason).toBe('invalid-threshold');
      expect(decideByThreshold(1, 1.2).reason).toBe('invalid-threshold');
      expect(decideByThreshold(1, Number.NaN).reason).toBe('invalid-threshold');
      expect(decideByThreshold(1, Number.POSITIVE_INFINITY).reason).toBe(
        'invalid-threshold',
      );
      expect(decideByThreshold(1, Number.NEGATIVE_INFINITY).reason).toBe(
        'invalid-threshold',
      );
    });
  });

  describe('decide（组合：调用 → 解析 → 判定）', () => {
    it('模型失败 → fail-open 放行真实提问，不产生自动作答', async () => {
      const llm = stubLlm([], {
        prepareCall: async () => {
          throw new Error('quota');
        },
      });
      const report = await decide(llm, { prompt: 'p' }, ROUTE, 0.8);
      expect(report.call).toEqual({ kind: 'model-error', message: 'quota' });
      expect(report.parse).toEqual({ ok: false, confidence: 0 });
      expect(report.threshold).toEqual({ verdict: 'passed-through' });
    });

    it('高置信回复 → 自动作答并携带建议答案', async () => {
      const llm = stubLlm([], {
        async *stream() {
          yield {
            type: 'text-delta',
            index: 0,
            text: '{"confidence":0.97,"suggestedAnswer":"确认继续"}',
          };
        },
      });
      const report = await decide(llm, { prompt: 'p' }, ROUTE, 0.8);
      expect(report.parse.ok).toBe(true);
      expect(report.parse.suggestedAnswer).toBe('确认继续');
      expect(report.threshold.verdict).toBe('auto-answered');
    });

    it('低置信回复 → 放行真实提问', async () => {
      const llm = stubLlm([], {
        async *stream() {
          yield { type: 'text-delta', index: 0, text: '{"confidence":0.1}' };
        },
      });
      const report = await decide(llm, { prompt: 'p' }, ROUTE, 0.8);
      expect(report.threshold.verdict).toBe('passed-through');
    });

    it('ok 但文本为空 → 解析层按低置信兜底，放行真实提问', async () => {
      const llm = stubLlm([], {
        async *stream() {
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
      });
      const report = await decide(llm, { prompt: 'p' }, ROUTE, 0.5);
      expect(report.call).toEqual({ kind: 'ok', text: '' });
      expect(report.parse).toEqual({
        ok: false,
        confidence: 0,
        parseError: 'empty-output',
      });
      expect(report.threshold.verdict).toBe('passed-through');
    });

    it('error 终态 finish 全链路 → model-error + 放行（不自动作答）', async () => {
      const llm = stubLlm([], {
        async *stream() {
          yield {
            type: 'text-delta',
            index: 0,
            text: '{"confidence":0.95}',
          };
          yield {
            type: 'finish',
            reason: { kind: 'error', failure: { message: 'boom' } },
          };
        },
      });
      const report = await decide(llm, { prompt: 'p' }, ROUTE, 0.8);
      expect(report.call).toEqual({ kind: 'model-error', message: 'boom' });
      expect(report.threshold.verdict).toBe('passed-through');
    });
  });

  describe('buildDecisionStreamOptions（stream options 组装）', () => {
    it('回填 call.config 全量字段并携带 messages 与 signal', () => {
      const signal = new AbortController().signal;
      const options = buildDecisionStreamOptions(
        {
          config: {
            provider: 'p',
            model: 'm',
            maxTokens: 64,
            reasoningEffort: 'low',
          },
        },
        { prompt: '问题' },
        signal,
      );
      expect(options).toEqual({
        provider: 'p',
        model: 'm',
        maxTokens: 64,
        reasoningEffort: 'low',
        messages: [{ role: 'user', content: [{ type: 'text', text: '问题' }] }],
        signal,
      });
    });
  });
});
