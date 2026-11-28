/**
 * systemone client 契约测试（决策工具系列 2/11）。
 *
 * 覆盖卡 2 清单要求的五类路径：正常响应、验证成功/失败、超时、非 2xx、
 * 畸形响应；外加「未配置即拒绝」「错误信息不含 API key」。
 *
 * 契约来源：docs/decision-tools-contract.md §2（接口定稿）、§2.3/§2.4（形状）、
 * §2.6（HTTP→错误码映射）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildSystemOneEndpoint,
  buildSystemOneHeaders,
  callSystemOne,
  IMAGES_DANGER_HEADER,
  MAX_QUESTIONS_PER_CALL,
  verifySystemOne,
  type FetchLike,
} from './client.ts';

const API_KEY = 'key-test';

const http = {
  baseUrl: 'http://127.0.0.1:3425',
  apiKey: API_KEY,
  model: 'ollama-r5/kev-4b',
  timeoutMs: 30_000,
};

interface StubCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function stubFetch(
  status: number,
  body: string,
): { fetchImpl: FetchLike; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      body: init.body,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    };
  };
  return { fetchImpl, calls };
}

/** 永不返回的 fetch：只在 signal abort 时 reject（模拟挂起连接）。 */
const hangingFetch: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')), {
      once: true,
    });
  });

const noulQuestion = { type: 'noul' as const, instructions: 'Is it ready?' };

describe('dsh-decision systemone client', () => {
  describe('端点与请求头', () => {
    it('baseUrl 归一后拼出 {baseUrl}/v1/systemone（尾斜杠不重复）', () => {
      expect(buildSystemOneEndpoint('http://127.0.0.1:3425')).toBe(
        'http://127.0.0.1:3425/v1/systemone',
      );
      expect(buildSystemOneEndpoint('http://127.0.0.1:3425///')).toBe(
        'http://127.0.0.1:3425/v1/systemone',
      );
      expect(buildSystemOneEndpoint('  https://dec.example.com  ')).toBe(
        'https://dec.example.com/v1/systemone',
      );
    });

    it('baseUrl 非法（空/非 http）返回 null，交由守卫层报未配置', () => {
      expect(buildSystemOneEndpoint('')).toBeNull();
      expect(buildSystemOneEndpoint('   ')).toBeNull();
      expect(buildSystemOneEndpoint('ftp://dec.example.com')).toBeNull();
    });

    it('请求头带 Bearer 鉴权与 JSON content-type', () => {
      const headers = buildSystemOneHeaders(API_KEY, false);
      expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('带图像资产时才加 images 头（契约 §2.5 的能力开关）', () => {
      expect(buildSystemOneHeaders(API_KEY, true)[IMAGES_DANGER_HEADER]).toBe(
        'true',
      );
      expect(
        buildSystemOneHeaders(API_KEY, false)[IMAGES_DANGER_HEADER],
      ).toBeUndefined();
    });
  });

  describe('正常响应解析（契约 §2.3/§2.4）', () => {
    it('解析四题型：noul / choice / score / box', async () => {
      const { fetchImpl } = stubFetch(
        200,
        JSON.stringify({
          model: 'ollama-r5/kev-4b',
          answers: {
            q1: { type: 'noul', noul: 0.82, confidence: 0.9 },
            q2: { type: 'choice', choice: '方案B', confidence: 0.7 },
            q3: { type: 'score', score: 7.5, legend: ['低', '中', '高'] },
            q4: {
              type: 'box',
              box: { top: 0.1, bottom: 0.4, left: 0.2, right: 0.8 },
              confidence: 0.55,
            },
          },
          usage: { input_tokens: 120, output_tokens: 40 },
        }),
      );
      const result = await callSystemOne({
        http,
        body: {
          state: { message: '评估' },
          questions: {
            q1: noulQuestion,
            q2: {
              type: 'choice',
              instructions: '选哪个',
              criteria: { 方案B: '更稳' },
            },
            q3: {
              type: 'score',
              instructions: '打分',
              criteria: ['低', '中', '高'],
            },
            q4: { type: 'box', instructions: '图里在哪' },
          },
        },
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.answers.q1).toMatchObject({
        kind: 'noul',
        pYes: 0.82,
        confidence: 0.9,
      });
      expect(result.answers.q2).toMatchObject({
        kind: 'choice',
        choice: '方案B',
      });
      expect(result.answers.q3).toMatchObject({
        kind: 'score',
        score: 7.5,
        legend: ['低', '中', '高'],
      });
      expect(result.answers.q4).toMatchObject({
        kind: 'box',
        box: { top: 0.1, bottom: 0.4, left: 0.2, right: 0.8 },
      });
      expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40 });
      expect(result.droppedQuestionIds).toEqual([]);
      expect(result.invalidAnswers).toEqual([]);
    });

    it('score 题的 legend/probabilities 为档位索引对象映射时归一为数组（卡 9/11 实测形状）', async () => {
      // 真实服务 ollama-r5/kev-4b 返回：legend={"0":"negligible",...}、probabilities={"0":0.35,...}
      const { fetchImpl } = stubFetch(
        200,
        JSON.stringify({
          model: 'kev-4b',
          answers: {
            q3: {
              type: 'score',
              score: 1.109,
              legend: { '0': 'negligible', '1': 'minor', '2': 'major' },
              probabilities: { '0': 0.357, '1': 0.311, '2': 0.196 },
              confidence: 0,
            },
          },
          usage: { input_tokens: 53, output_tokens: 0 },
        }),
      );
      const result = await callSystemOne({
        http,
        body: {
          state: { message: '评估' },
          questions: {
            q3: {
              type: 'score',
              instructions: '打分',
              criteria: ['negligible', 'minor', 'major'],
            },
          },
        },
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.answers.q3).toMatchObject({
        kind: 'score',
        score: 1.109,
        legend: ['negligible', 'minor', 'major'],
        probabilities: [0.357, 0.311, 0.196],
      });
      expect(result.invalidAnswers).toEqual([]);
    });

    it('缺失的 confidence / probabilities 记 null，不臆造', async () => {
      const { fetchImpl } = stubFetch(
        200,
        JSON.stringify({ answers: { q1: { type: 'noul', noul: 0.5 } } }),
      );
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.answers.q1).toMatchObject({
        confidence: null,
        probabilities: null,
      });
      // usage 缺失 → token 记 null，不填 0
      expect(result.usage).toBeNull();
    });

    it('上游漏答的题进 droppedQuestionIds（不填默认值）', async () => {
      const { fetchImpl } = stubFetch(200, JSON.stringify({ answers: {} }));
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion, q2: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.droppedQuestionIds.sort()).toEqual(['q1', 'q2']);
      expect(Object.keys(result.answers)).toEqual([]);
    });

    it('形状非法的题进 invalidAnswers，不影响其他题', async () => {
      const { fetchImpl } = stubFetch(
        200,
        JSON.stringify({
          answers: {
            q1: { type: 'noul', noul: 0.5 },
            q2: { type: 'noul', noul: '高' },
          },
        }),
      );
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion, q2: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.invalidAnswers).toHaveLength(1);
      expect(result.invalidAnswers[0]?.questionId).toBe('q2');
      expect(result.answers.q1).toBeDefined();
    });
  });

  describe('畸形响应（契约 §2.6）', () => {
    it('返回体不是合法 JSON → model-invalid-response', async () => {
      const { fetchImpl } = stubFetch(200, 'not-json');
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-invalid-response');
    });

    it('返回体缺 answers 对象 → model-invalid-response', async () => {
      const { fetchImpl } = stubFetch(200, JSON.stringify({ model: 'x' }));
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-invalid-response');
    });
  });

  describe('HTTP → 错误码映射（契约 §2.6）', () => {
    it('401 调用阶段 → model-call-failed，验证阶段 → model-verify-failed', async () => {
      const { fetchImpl } = stubFetch(
        401,
        JSON.stringify({ error: 'unauthorized' }),
      );
      const called = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl,
      });
      expect(called.ok).toBe(false);
      if (called.ok) return;
      expect(called.error.code).toBe('model-call-failed');

      const verified = await verifySystemOne({ http, fetchImpl });
      expect(verified.ok).toBe(false);
      if (verified.ok) return;
      expect(verified.error.code).toBe('model-verify-failed');
    });

    it('400 且报文提到 box/图像 → model-unsupported-capability', async () => {
      const { fetchImpl } = stubFetch(
        400,
        JSON.stringify({ error: 'box question not supported' }),
      );
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-unsupported-capability');
    });

    it('400 且报文是题型枚举拒绝（卡 9/11 实测报文）→ model-unsupported-capability 且带上游报文', async () => {
      const { fetchImpl } = stubFetch(
        400,
        JSON.stringify({
          error: {
            code: 400,
            message:
              'questions.target: "type" must be one of: choice, score, noul',
            type: 'invalid_request_error',
          },
        }),
      );
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-unsupported-capability');
      expect(String(result.error.details?.upstream)).toContain(
        'must be one of',
      );
      expect(JSON.stringify(result.error)).not.toContain(API_KEY);
    });

    it('普通 400 → model-invalid-response', async () => {
      const { fetchImpl } = stubFetch(
        400,
        JSON.stringify({ error: 'bad criteria' }),
      );
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-invalid-response');
    });

    it('404 → model-call-failed（端点路径不对）', async () => {
      const { fetchImpl } = stubFetch(404, 'not found');
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-call-failed');
    });

    it('429 / 500 → model-call-failed 且可重试', async () => {
      for (const status of [429, 500]) {
        const { fetchImpl } = stubFetch(status, 'boom');
        const result = await callSystemOne({
          http,
          body: { state: {}, questions: { q1: noulQuestion } },
          fetchImpl,
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('model-call-failed');
        expect(result.error.retryable).toBe(true);
      }
    });

    it('连接失败 → model-call-failed', async () => {
      const failing: FetchLike = async () => {
        throw new Error('ECONNREFUSED');
      };
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl: failing,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-call-failed');
    });
  });

  describe('超时与取消', () => {
    it('超过 timeoutMs → model-timeout', async () => {
      vi.useFakeTimers();
      try {
        const pending = callSystemOne({
          http: { ...http, timeoutMs: 50_000 },
          body: { state: {}, questions: { q1: noulQuestion } },
          fetchImpl: hangingFetch,
        });
        await vi.advanceTimersByTimeAsync(50_001);
        const result = await pending;
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('model-timeout');
        expect(result.error.retryable).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('调用方已取消 → model-call-failed（不静默重试）', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        signal: controller.signal,
        fetchImpl: hangingFetch,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-call-failed');
      // details.aborted 让调用层识别「调用方主动取消」，不触发兜底裁判。
      expect(result.error.details.aborted).toBe(true);
    });
  });

  describe('请求前守卫', () => {
    it('三元组缺一即 model-not-configured 且不出网', async () => {
      const { fetchImpl, calls } = stubFetch(
        200,
        JSON.stringify({ answers: {} }),
      );
      const result = await callSystemOne({
        http: { ...http, apiKey: '' },
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-not-configured');
      expect(calls).toHaveLength(0);
    });

    it('题数为 0 或超过 16 → invalid-arguments 且不出网', async () => {
      const { fetchImpl, calls } = stubFetch(
        200,
        JSON.stringify({ answers: {} }),
      );
      const empty = await callSystemOne({
        http,
        body: { state: {}, questions: {} },
        fetchImpl,
      });
      expect(empty.ok).toBe(false);
      if (!empty.ok) expect(empty.error.code).toBe('invalid-arguments');

      const tooMany: Record<string, typeof noulQuestion> = {};
      for (let i = 0; i <= MAX_QUESTIONS_PER_CALL; i += 1)
        tooMany[`q${i}`] = noulQuestion;
      const overflow = await callSystemOne({
        http,
        body: { state: {}, questions: tooMany },
        fetchImpl,
      });
      expect(overflow.ok).toBe(false);
      if (!overflow.ok) expect(overflow.error.code).toBe('invalid-arguments');
      expect(calls).toHaveLength(0);
    });

    it('错误信息与 details 都不含 API key', async () => {
      const { fetchImpl } = stubFetch(401, 'unauthorized');
      const result = await callSystemOne({
        http,
        body: { state: {}, questions: { q1: noulQuestion } },
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const serialized = `${result.error.message}${JSON.stringify(result.error.details)}`;
      expect(serialized).not.toContain(API_KEY);
    });
  });

  describe('验证探测', () => {
    it('探测成功 → ok 且带回 model 与耗时', async () => {
      const { fetchImpl, calls } = stubFetch(
        200,
        JSON.stringify({
          model: 'ollama-r5/kev-4b',
          answers: { probe: { type: 'noul', noul: 1 } },
        }),
      );
      const result = await verifySystemOne({ http, fetchImpl });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.model).toBe('ollama-r5/kev-4b');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      // 探测只发一题 noul
      expect(calls).toHaveLength(1);
      const body = JSON.parse(calls[0]!.body) as {
        questions: Record<string, { type: string }>;
      };
      expect(Object.keys(body.questions)).toEqual(['probe']);
      expect(body.questions.probe?.type).toBe('noul');
    });

    it('探测失败 → 归一错误码（不抛异常）', async () => {
      const { fetchImpl } = stubFetch(403, 'forbidden');
      const result = await verifySystemOne({ http, fetchImpl });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-verify-failed');
    });

    it('未配置时探测直接报 model-not-configured，不发请求', async () => {
      const { fetchImpl, calls } = stubFetch(
        200,
        JSON.stringify({ answers: {} }),
      );
      const result = await verifySystemOne({
        http: { ...http, model: '' },
        fetchImpl,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-not-configured');
      expect(calls).toHaveLength(0);
    });

    it('探测题被上游丢弃 → model-verify-failed（空壳不算验证通过）', async () => {
      const { fetchImpl } = stubFetch(
        200,
        JSON.stringify({ model: 'ollama-r5/kev-4b', answers: {} }),
      );
      const result = await verifySystemOne({ http, fetchImpl });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('model-verify-failed');
    });
  });
});
