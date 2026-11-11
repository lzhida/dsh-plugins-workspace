import { existsSync, readFileSync, rmSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { CLI_ACTIONS, isCliAction } from '../../cli.ts';
import type { VictauriClient } from '../../client.ts';
import { VictauriError, VictauriHttpError } from '../../errors.ts';
import { REST_TOOL_SPECS, STANDALONE_TOOL_COUNT } from './catalog.ts';
import {
  createRestBridgeTool,
  UPSTREAM_EXTRA_ALIASES,
  UPSTREAM_WINDOW_ALIAS_TOOLS,
} from './bridge.ts';
import { COMPOUND_TOOL_SPECS } from '../compound/catalog.ts';
import { IMAGE_DIR_NAME } from './image.ts';
import { RENDER_MAX_CHARS, renderJson } from './render.ts';

/** 最小 mock client:只实现 callTool,记录调用入参与第三参请求预算。 */
function mockClient(
  impl: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): {
  client: VictauriClient;
  calls: Array<{
    name: string;
    args: Record<string, unknown>;
    budget?: number;
  }>;
} {
  const calls: Array<{
    name: string;
    args: Record<string, unknown>;
    budget?: number;
  }> = [];
  const client = {
    callTool: async (
      name: string,
      args: Record<string, unknown>,
      budget?: number,
    ) => {
      calls.push({ name, args, budget });
      return impl(name, args);
    },
  } as unknown as VictauriClient;
  return { client, calls };
}

/** ToolDefinition.execute 返回 unknown:断言回 Record 形状。 */
type AnyRecord = Record<string, unknown>;

/** 用最小规格构桥(绕过 catalog,聚焦工厂行为)。 */
const specOf = (name: string) =>
  REST_TOOL_SPECS.find((spec) => spec.name === name)!;

describe('dsh-victauri standalone 批', () => {
  it('20 个工具注册齐全且 dsh 名带 victauri_ 前缀(口径=README=docs=契约测试)', () => {
    // 全量口径:Victauri 35(standalone 20 + compound 15)+ CLI 桥 1 + CLI 探测 1
    // + 工具发现 1 + 桥接体检 1 = 39 dsh 工具
    // (CLI_ACTIONS.length=13 是子命令数,不是工具数)
    const COMPOUND_COUNT = 15;
    expect(STANDALONE_TOOL_COUNT).toBe(20);
    expect(STANDALONE_TOOL_COUNT + COMPOUND_COUNT).toBe(35);
    expect(STANDALONE_TOOL_COUNT + COMPOUND_COUNT + 4).toBe(39);
    expect(CLI_ACTIONS.length).toBe(13);
    expect(REST_TOOL_SPECS).toHaveLength(STANDALONE_TOOL_COUNT);
    for (const spec of REST_TOOL_SPECS) {
      const tool = createRestBridgeTool(spec, { getClient: null as never });
      expect(tool.name).toBe(`victauri_${spec.name}`);
    }
  });

  it('6 个单名必填工具的 required 注解与探测一致', () => {
    const requiredMap: Record<string, string[]> = {
      assert_semantic: ['expression', 'condition'],
      invoke_command: ['command'],
      read_app_file: ['path'],
      resolve_command: ['query'],
      verify_state: ['frontend_expr'],
      wait_for: ['condition'],
    };
    for (const [name, fields] of Object.entries(requiredMap)) {
      const parameters = specOf(name).parameters as Record<
        string,
        { required?: boolean }
      >;
      for (const field of fields) {
        expect(parameters[field]?.required, `${name}.${field}`).toBe(true);
      }
    }
    // eval_js/query_db 走别名归一:required 由 execute 兜底(schema 双 optional)
    const evalParams = specOf('eval_js').parameters as Record<
      string,
      { required?: boolean }
    >;
    expect(evalParams['code']?.required).toBeUndefined();
    expect(evalParams['expression']?.required).toBeUndefined();
  });

  it('空参工具(app_info)透传 {} 且返回原样', async () => {
    const payload = { config: { product_name: 'demo' }, env: {} };
    const { client, calls } = mockClient(async () => payload);
    const tool = createRestBridgeTool(specOf('app_info'), {
      getClient: async () => client,
    });
    const result = (await tool.execute({}, {} as never)) as AnyRecord;
    expect(calls[0]?.name).toBe('app_info');
    expect(calls[0]?.args).toEqual({});
    expect(result).toEqual(payload);
  });

  it('eval_js 别名归一:expression 无 code 时归一为 code', async () => {
    const { client, calls } = mockClient(async () => ({ value: 2 }));
    const tool = createRestBridgeTool(specOf('eval_js'), {
      getClient: async () => client,
    });
    await tool.execute({ expression: '1+1' }, {} as never);
    expect(calls[0]?.args).toEqual({ code: '1+1' });
    // 两者都给时以实测名 code 为准并丢弃别名
    await tool.execute({ code: '2+2', expression: 'ignored' }, {} as never);
    expect(calls[1]?.args).toEqual({ code: '2+2' });
  });

  it('query_db 别名归一:sql 归一为 query;两者同传时以 query 为准并移除 sql', async () => {
    const { client, calls } = mockClient(async () => ({ rows: [] }));
    const tool = createRestBridgeTool(specOf('query_db'), {
      getClient: async () => client,
    });
    // 只给上游正式别名 sql → 本地归一为 query（上游同时收到两者会 duplicate field）
    await tool.execute({ sql: 'SELECT 1' }, {} as never);
    expect(calls[0]?.args).toEqual({ query: 'SELECT 1' });
    // 两者同传 → 以实测主名 query 为准，别名键被移除
    await tool.execute({ query: 'a', sql: 'b' }, {} as never);
    expect(calls[1]?.args).toEqual({ query: 'a' });
    // 两者都不给 → 结构化错误提示别名仍被接受，且请求不发出
    const missing = (await tool.execute({}, {} as never)) as AnyRecord;
    const err = missing['error'] as AnyRecord;
    expect(err['kind']).toBe('tool-error');
    expect(String(err['message'])).toContain(
      'missing required property "query"',
    );
    expect(String(err['message'])).toContain('alias "sql" accepted');
    expect(calls).toHaveLength(2);
  });

  it('alias 工具缺 primary(两个名都没给)返回结构化错误(execute 兜底)', async () => {
    const { client, calls } = mockClient(async () => ({}));
    const tool = createRestBridgeTool(specOf('eval_js'), {
      getClient: async () => client,
    });
    const result = (await tool.execute({}, {} as never)) as AnyRecord;
    const err = result['error'] as AnyRecord;
    expect(err['kind']).toBe('tool-error');
    expect(String(err['message'])).toContain(
      'missing required property "code"',
    );
    expect(calls).toHaveLength(0);
  });

  it('数组结果包装为 {items:[...]}(find_elements 实测顶层数组)', async () => {
    const { client } = mockClient(async () => [
      { tag: 'button' },
      { tag: 'input' },
    ]);
    const tool = createRestBridgeTool(specOf('find_elements'), {
      getClient: async () => client,
    });
    const result = (await tool.execute(
      { tag: 'button' },
      {} as never,
    )) as AnyRecord;
    expect(result).toEqual({ items: [{ tag: 'button' }, { tag: 'input' }] });
  });

  it('screenshot base64 落盘 %TEMP%/dsh-victauri 返回路径', async () => {
    // 1x1 红点 PNG 的 base64
    const PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const { client } = mockClient(async () => ({
      data: PNG_BASE64,
      mimeType: 'image/png',
      type: 'png',
    }));
    const tool = createRestBridgeTool(specOf('screenshot'), {
      getClient: async () => client,
    });
    const result = (await tool.execute({}, {} as never)) as AnyRecord;
    const path = result['path'] as string;
    expect(path).toContain(IMAGE_DIR_NAME);
    expect(result['mime_type']).toBe('image/png');
    expect(result['bytes']).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).byteLength).toBe(result['bytes'] as number);
    rmSync(path, { force: true });
  });

  it('VictauriError 不 throw,返回 {error:{kind,message,hint}} 含自检指引', async () => {
    const { client } = mockClient(async () => {
      throw new VictauriError('no-live-instance', 'all candidates dead');
    });
    const tool = createRestBridgeTool(specOf('get_plugin_info'), {
      getClient: async () => client,
    });
    const result = (await tool.execute({}, {} as never)) as AnyRecord;
    const err = result['error'] as AnyRecord;
    expect(err['kind']).toBe('no-live-instance');
    expect(err['message']).toContain('all candidates dead');
    expect(String(err['hint'])).toContain('victauri check');
  });

  it('非 Victauri 异常归一 kind=unknown', async () => {
    const { client } = mockClient(async () => {
      throw new Error('boom');
    });
    const tool = createRestBridgeTool(specOf('app_info'), {
      getClient: async () => client,
    });
    const result = (await tool.execute({}, {} as never)) as AnyRecord;
    expect((result['error'] as AnyRecord)['kind']).toBe('unknown');
  });

  it('renderJson pretty-print 且超 RENDER_MAX_CHARS 截断', () => {
    const blocks = renderJson({ a: 1 });
    expect(blocks[0]).toMatchObject({ type: 'text' });
    const long = 'x'.repeat(RENDER_MAX_CHARS + 500);
    const truncated = renderJson({ blob: long });
    const text = (truncated[0] as { text: string }).text;
    expect(text).toContain('截断');
    expect(text.length).toBeLessThan(RENDER_MAX_CHARS + 100);
  });

  it('with_logs 载荷超长时摘要化 backend_logs 并保留 backend_log_cursor（S-3 回归）', () => {
    // 复刻 invoke_command {with_logs:true} 的 0.10.3 五键返回体：cursor 排在
    // backend_logs 之后，旧行为（截头 6000）会把游标丢掉——三段式第②步拿不到它。
    const payload = {
      result: { ok: true },
      backend_logs: Array.from({ length: 120 }, (_, i) => ({
        seq: i,
        level: 'info',
        target: 'app::module',
        fields: { run_type: 'foreground' },
        message: 'x'.repeat(150),
      })),
      backend_logs_hint: '…',
      backend_log_cursor: 42,
      next_seq: 43,
    };
    const [block] = renderJson(payload) as Array<{ text: string }>;
    // 游标与序列必须原样保留（三段式第②步的 since_seq 来源）
    expect(block.text).toContain('"backend_log_cursor": 42');
    expect(block.text).toContain('"next_seq": 43');
    // 摘要标记可见，且不再是 120 条全文
    expect(block.text).toContain('已摘要化');
    expect(block.text).not.toContain('"seq": 119');
    // 短载荷（≤5 条）不被摘要化，保持原样
    const small = renderJson({
      result: {},
      backend_logs: [{ seq: 0 }],
      backend_log_cursor: 1,
    }) as Array<{ text: string }>;
    expect(small[0].text).toContain('"seq": 0');
    expect(small[0].text).not.toContain('已摘要化');
  });

  it('T-1 闭集枚举在客户端前置拒绝:请求不发出(负向护栏)', async () => {
    const { client, calls } = mockClient(async () => ({}));
    const tool = createRestBridgeTool(specOf('wait_for'), {
      getClient: async () => client,
    });
    // 枚举越界:condition:'bogus' 必须被 dsh-tools 参数校验拒绝
    await expect(
      tool.execute({ condition: 'bogus', value: 'x' }, {} as never),
    ).rejects.toThrow(/must be one of/);
    // 缺必填 condition:同样前置拒绝
    await expect(tool.execute({ value: 'x' }, {} as never)).rejects.toThrow(
      /missing required property "condition"/,
    );
    // 类型错:since_seq 必须是 integer
    await expect(
      tool.execute(
        { condition: 'log', value: 'ready', since_seq: '42' },
        {} as never,
      ),
    ).rejects.toThrow(/must be an integer/);
    // 三种越界的请求都未发出(校验在客户端,服务端零流量)
    expect(calls).toHaveLength(0);
  });

  it('T-3 invoke_command.timeout_ms 与本通道 REST 预算脱钩(mock 记录第三参)', async () => {
    const { client, calls } = mockClient(async () => ({ ok: true }));
    const invokeTool = createRestBridgeTool(specOf('invoke_command'), {
      getClient: async () => client,
    });
    await invokeTool.execute(
      { command: 'greet', timeout_ms: 120_000 },
      {} as never,
    );
    // timeout_ms 原样透传给服务端(服务端整次调用预算),但第三参 budget 为 undefined:
    // 本通道 REST 预算走客户端默认链(30s),invoke_command 未单独放宽——两层预算独立
    expect(calls[0]?.args).toEqual({ command: 'greet', timeout_ms: 120_000 });
    expect(calls[0]?.budget).toBeUndefined();

    // 对照:wait_for 的 timeout_ms 会动态换算为本通道预算(timeout_ms+5s 夹 120s 上限)
    const waitTool = createRestBridgeTool(specOf('wait_for'), {
      getClient: async () => client,
    });
    await waitTool.execute(
      { condition: 'url', value: '/ready', timeout_ms: 120_000 },
      {} as never,
    );
    expect(calls[1]?.budget).toBe(120_000);
  });

  it('CLI_ACTIONS 与 standalone 目录无工具名冲突(命名空间分离)', () => {
    const standalone = new Set(REST_TOOL_SPECS.map((spec) => spec.name));
    for (const action of CLI_ACTIONS.filter((a) => isCliAction(a))) {
      // victauri invoke(CLI 子命令)与 invoke_command(REST 工具)不同名,不冲突
      expect(standalone.has(action)).toBe(false);
    }
    expect(standalone.size).toBe(20);
  });

  it('0.10.3 新增参数原样透传给服务端(invoke_command/wait_for/find_elements)', async () => {
    const { client, calls } = mockClient(async () => ({ ok: true }));

    // invoke_command:timeout_ms + with_logs 透传（不被丢弃、不被字符串化）
    const invokeTool = createRestBridgeTool(specOf('invoke_command'), {
      getClient: async () => client,
    });
    await invokeTool.execute(
      {
        command: 'greet',
        args: { name: 'x' },
        timeout_ms: 120_000,
        with_logs: true,
      },
      {} as never,
    );
    expect(calls[0]?.name).toBe('invoke_command');
    expect(calls[0]?.args).toEqual({
      command: 'greet',
      args: { name: 'x' },
      timeout_ms: 120_000,
      with_logs: true,
    });

    // wait_for:condition=log + level/fields/since_seq 透传（fields 为对象不字符串化）
    const waitTool = createRestBridgeTool(specOf('wait_for'), {
      getClient: async () => client,
    });
    await waitTool.execute(
      {
        condition: 'log',
        value: 'pipeline_run',
        level: 'warn',
        fields: { run_type: 'foreground' },
        since_seq: 42,
      },
      {} as never,
    );
    expect(calls[1]?.name).toBe('wait_for');
    expect(calls[1]?.args).toEqual({
      condition: 'log',
      value: 'pipeline_run',
      level: 'warn',
      fields: { run_type: 'foreground' },
      since_seq: 42,
    });

    // find_elements:title_attr + 0.10.3 四新参透传
    const findTool = createRestBridgeTool(specOf('find_elements'), {
      getClient: async () => client,
    });
    await findTool.execute(
      {
        title_attr: '保存',
        attribute: 'data-role',
        attribute_value: 'primary',
        text_exact: true,
        include_hidden: true,
      },
      {} as never,
    );
    expect(calls[2]?.name).toBe('find_elements');
    expect(calls[2]?.args).toEqual({
      title_attr: '保存',
      attribute: 'data-role',
      attribute_value: 'primary',
      text_exact: true,
      include_hidden: true,
    });
  });

  it('backlog-A M-1:HTTP 分流错误信封带可选 status,非 HTTP 错误不带该键', async () => {
    const httpTool = createRestBridgeTool(specOf('app_info'), {
      getClient: async () => {
        throw new VictauriHttpError(401, 'unauthorized', 'info');
      },
    });
    const httpResult = (await httpTool.execute({}, {} as never)) as AnyRecord;
    const httpError = httpResult['error'] as AnyRecord;
    expect(httpError['kind']).toBe('auth');
    expect(httpError['status']).toBe(401);
    expect(String(httpError['message'])).toContain('HTTP 401');

    const plainTool = createRestBridgeTool(specOf('app_info'), {
      getClient: async () => {
        throw new VictauriError('tool-error', 'upstream');
      },
    });
    const plainResult = (await plainTool.execute({}, {} as never)) as AnyRecord;
    const plainError = plainResult['error'] as AnyRecord;
    expect(plainError['kind']).toBe('tool-error');
    expect('status' in plainError).toBe(false);
  });
});

describe('批十三 2/2:M-4 ignored_args 可观测性', () => {
  it('未知键照常透传(上游行为不变)且结果顶层附加 ignored_args(排序确定)', async () => {
    const { client, calls } = mockClient(async () => ({ value: 1 }));
    const tool = createRestBridgeTool(specOf('eval_js'), {
      getClient: async () => client,
    });
    const result = (await tool.execute(
      { code: '1', foo: 'bar', alpha: 2 },
      {} as never,
    )) as AnyRecord;
    // 透传不变:未知键仍发送给服务端(上游静默忽略语义不改变)
    expect(calls[0]?.args).toEqual({ code: '1', foo: 'bar', alpha: 2 });
    // 可观测性:顶层附加键,按字母排序保证确定性
    expect(result['ignored_args']).toEqual(['alpha', 'foo']);
    expect(result['value']).toBe(1);
  });

  it('无未知键时不携带 ignored_args 键(零行为变化)', async () => {
    const { client } = mockClient(async () => ({ ok: true }));
    const tool = createRestBridgeTool(specOf('app_info'), {
      getClient: async () => client,
    });
    const result = (await tool.execute({}, {} as never)) as AnyRecord;
    expect(result).toEqual({ ok: true });
    expect('ignored_args' in result).toBe(false);
  });

  it('schema 声明键不误报(expression/sql 经本地归一后已不在请求中)', async () => {
    const { client } = mockClient(async () => ({ value: 2 }));
    const evalTool = createRestBridgeTool(specOf('eval_js'), {
      getClient: async () => client,
    });
    const evalResult = (await evalTool.execute(
      { expression: '1+1' },
      {} as never,
    )) as AnyRecord;
    expect('ignored_args' in evalResult).toBe(false);

    const queryTool = createRestBridgeTool(specOf('query_db'), {
      getClient: async () => client,
    });
    const queryResult = (await queryTool.execute(
      { sql: 'SELECT 1' },
      {} as never,
    )) as AnyRecord;
    expect('ignored_args' in queryResult).toBe(false);
  });

  it('上游正式别名(window/window_label)不误报(V2 中-1:上游 serde alias 真实消费)', async () => {
    const { client, calls } = mockClient(async () => ({ value: 3 }));
    const tool = createRestBridgeTool(specOf('eval_js'), {
      getClient: async () => client,
    });
    const result = (await tool.execute(
      { code: '1', window: 'main', window_label: 'main' },
      {} as never,
    )) as AnyRecord;
    // 两个别名键照常透传(上游 EvalJsParams.webview_label 的 serde alias)
    expect(calls[0]?.args).toEqual({
      code: '1',
      window: 'main',
      window_label: 'main',
    });
    expect('ignored_args' in result).toBe(false);
  });

  it('非别名集合成员如实上报(app_state 的 window 键上游无字段,应报 ignored)', async () => {
    const { client } = mockClient(async () => ({ result: { pid: 1 } }));
    const tool = createRestBridgeTool(specOf('app_state'), {
      getClient: async () => client,
    });
    // app_state 上游 AppStateParams 只有 probe(无 webview_label/window),
    // 传 window 不生效 → 诚实回报
    const result = (await tool.execute(
      { probe: 'x', window: 'main' },
      {} as never,
    )) as AnyRecord;
    expect(result['ignored_args']).toEqual(['window']);
  });

  it('图像通道不附加 ignored_args(落盘结果只带路径,V2 低-3)', async () => {
    // 1x1 红点 PNG(与上方落盘用例同一常量来源)
    const PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const { client } = mockClient(async () => ({
      type: 'image',
      data: PNG_BASE64,
      mimeType: 'image/png',
    }));
    const tool = createRestBridgeTool(specOf('screenshot'), {
      getClient: async () => client,
    });
    const result = (await tool.execute(
      { window_label: 'main', stray_unknown_key: 1 },
      {} as never,
    )) as AnyRecord;
    expect(typeof result['path']).toBe('string');
    expect('ignored_args' in result).toBe(false);
    rmSync(result['path'] as string, { force: true });
  });

  it('上游结果自带 ignored_args 键时不被覆盖(插件提示改用 ignored_args_plugin,V2 低-5)', async () => {
    const { client } = mockClient(async () => ({
      value: 1,
      ignored_args: ['from_upstream'],
    }));
    const tool = createRestBridgeTool(specOf('eval_js'), {
      getClient: async () => client,
    });
    const result = (await tool.execute(
      { code: '1', foo: 'bar' },
      {} as never,
    )) as AnyRecord;
    // 上游值原样保留,插件提示走备用键
    expect(result['ignored_args']).toEqual(['from_upstream']);
    expect(result['ignored_args_plugin']).toEqual(['foo']);
  });

  it('错误信封不附加 ignored_args(错误面保持精简)', async () => {
    const { client } = mockClient(async () => {
      throw new Error('boom');
    });
    const tool = createRestBridgeTool(specOf('app_info'), {
      getClient: async () => client,
    });
    const result = (await tool.execute({ stray: 1 }, {} as never)) as AnyRecord;
    const err = result['error'] as AnyRecord;
    expect(err).toBeDefined();
    expect('ignored_args' in result).toBe(false);
  });

  it('别名登记表与两份 catalog 漂移守卫(成员是真实 spec;webview 组成员必声明 webview_label;app_state/fault 留在组外;extra 键与声明键不重叠)', () => {
    const specs = [...REST_TOOL_SPECS, ...COMPOUND_TOOL_SPECS];
    const allNames = new Set(specs.map((spec) => spec.name));
    for (const name of UPSTREAM_WINDOW_ALIAS_TOOLS) {
      expect(allNames.has(name), `别名组含未知工具名:${name}`).toBe(true);
    }
    for (const name of Object.keys(UPSTREAM_EXTRA_ALIASES)) {
      expect(allNames.has(name), `额外别名表含未知工具名:${name}`).toBe(true);
    }
    const specByName = new Map(specs.map((spec) => [spec.name, spec]));
    for (const name of UPSTREAM_WINDOW_ALIAS_TOOLS) {
      const spec = specByName.get(name)!;
      expect(
        Object.keys(spec.parameters),
        `${name} 应声明 webview_label(上游 window/window_label alias 挂在该字段上)`,
      ).toContain('webview_label');
    }
    // 上游结构体没有 webview_label 字段的两个特例(0.10.3 AppStateParams/FaultParams)
    // 必须留在组外——传 window 进去上游同样静默忽略,要如实上报
    expect(UPSTREAM_WINDOW_ALIAS_TOOLS.has('app_state')).toBe(false);
    expect(UPSTREAM_WINDOW_ALIAS_TOOLS.has('fault')).toBe(false);
    // 额外表的键不得与 schema 声明键重复(重复登记无意义)
    for (const [name, extras] of Object.entries(UPSTREAM_EXTRA_ALIASES)) {
      const declared = new Set(Object.keys(specByName.get(name)!.parameters));
      for (const extra of extras) {
        expect(
          declared.has(extra),
          `${name}.${extra} 已在 schema 声明,额外登记冗余`,
        ).toBe(false);
      }
    }
    // 组规模锚点:23 个(standalone 10 + compound 13),防止静默增删
    expect(UPSTREAM_WINDOW_ALIAS_TOOLS.size).toBe(23);
  });
});
