import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply, inject, name } from './entries/ask-gate.ts';
import { Config, resolveConfig } from './core/config.ts';
import {
  toAskGateAnswerItem,
  toUserQuestionItem,
  type AskGateQuestion,
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
  registered: RegisteredTool[];
  disposers: (() => void)[];
  logs: string[];
}

function stubContext(
  ask?: (request: unknown) => Promise<unknown>,
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
  return ctx;
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
    expect(output.schema.additionalProperties).toBe(false);
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
    expect(() => resolveConfig('not-an-object')).not.toThrow();
    const dict = (Config as unknown as { dict: Record<string, unknown> }).dict;
    expect(Object.keys(dict)).toEqual(
      expect.arrayContaining(['enabled', 'decisionProvider', 'decisionModel']),
    );
  });
});
