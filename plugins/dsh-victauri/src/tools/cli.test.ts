import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
} from '@deepseek-ai/dsh-tools';

import { CLI_DEFAULT_TIMEOUT_MS } from '../cli.ts';
import {
  CLI_MAX_TIMEOUT_MS,
  createVictauriCliTool,
  PREVIEW_MAX_CHARS,
  renderPreview,
  victauriCliTool,
} from './cli.ts';

/** 把 render 产出的 ContentBlock[] 拼成纯文本（便于断言）。 */
function renderText(blocks: unknown[]): string {
  return blocks
    .map((block) => (block as { text?: string }).text ?? '')
    .join('\n');
}

/** ToolDefinition.execute 返回 unknown(运行时接口),断言回具体形状。 */
interface CliToolValue {
  action: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  partial: boolean;
  cli_version: string | null;
  hints: {
    summary: string;
    notes: string[];
    long_running: boolean;
    interactive: boolean;
  };
  doctor: {
    summary: string | null;
    passed: number | null;
    total: number | null;
    failed: number | null;
    warnings: number | null;
    checks: { status: string; message: string; detail: string | null }[];
  } | null;
}

/** 工具工厂注入 node 本体当 cliPath:用 -e 脚本模拟 victauri 子命令行为。 */
const tool = createVictauriCliTool({ cliPath: process.execPath });

/** 0.8.8 实测 doctor 输出(仓根执行,全 FAIL)。 */
const DOCTOR_SAMPLE_088 = `Victauri Doctor — checking your setup...

  [FAIL] No Cargo.toml found in current directory
         Run this command from your Tauri project root.

Summary: 0/1 passed, 1 failed, 0 warnings
Setup needs attention. Fix the [FAIL] items above to get started.
`;

/** 造一个恒定返回指定结果的执行器(替身,避免真实 spawn)。 */
function fakeRun(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}) {
  return async () => result;
}

describe('dsh-victauri victauri_cli tool: timeout_ms 上限(M-10a)', () => {
  /** 记录 run 收到的完整选项(含 timeoutMs),替身不真正 spawn。 */
  function capturingRun() {
    const seen: { timeoutMs?: number } = {};
    const run = async (opts: { timeoutMs?: number }) => {
      Object.assign(seen, opts);
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    };
    return { seen, run };
  }

  it('timeout_ms 超过宿主预算被夹到 CLI_MAX_TIMEOUT_MS,默认/小值/非正数各有归宿', async () => {
    const { seen, run } = capturingRun();
    // version 显式注入:跳过 cli-status 探测(不真实 spawn node --version,
    // 也不污染 cli-status 的 60s 模块级缓存)。
    const probe = createVictauriCliTool({
      cliPath: process.execPath,
      version: '0.8.8',
      run,
    });
    await probe.execute({ action: 'check' }, {} as never);
    expect(seen.timeoutMs).toBe(CLI_DEFAULT_TIMEOUT_MS);
    await probe.execute(
      { action: 'check', timeout_ms: 3_600_000 },
      {} as never,
    );
    expect(seen.timeoutMs).toBe(CLI_MAX_TIMEOUT_MS);
    await probe.execute({ action: 'check', timeout_ms: 1_500 }, {} as never);
    expect(seen.timeoutMs).toBe(1_500);
    // 非正数兜底(schema 无 minimum):setTimeout(≤0) 立即触发会秒杀子进程。
    await probe.execute({ action: 'check', timeout_ms: 0 }, {} as never);
    expect(seen.timeoutMs).toBe(1);
    await probe.execute({ action: 'check', timeout_ms: -1 }, {} as never);
    expect(seen.timeoutMs).toBe(1);
  });

  it('timeout_ms 描述与上限/默认常量同源,工具声明复用宿主预算(不变量护栏)', () => {
    // 核心不变量:子进程上限 = 宿主工具预算。宿主预算下调而常量未同步时,
    // 孤儿窗口回归——这条断言就是防它的。
    expect(victauriCliTool.timeoutMs).toBe(CLI_MAX_TIMEOUT_MS);
    // defineTool 把 parameters 包装成 JSON Schema:{type:'object',properties:{...}}
    const schema = victauriCliTool.parameters as {
      properties?: {
        timeout_ms?: { description?: string };
      };
    };
    const desc = schema.properties?.timeout_ms?.description ?? '';
    expect(desc).toContain(`默认 ${CLI_DEFAULT_TIMEOUT_MS}`);
    expect(desc).toContain(`上限 ${CLI_MAX_TIMEOUT_MS}`);
  });
});

describe('dsh-victauri victauri_cli tool', () => {
  it('execute 拼装 [action, ...args] 并返回结构化四元组', async () => {
    const result = (await tool.execute(
      {
        action: 'doctor',
        args: ['probe-arg'],
      },
      {} as never,
    )) as CliToolValue;
    // node -e 脚本不认识 doctor 子命令,exit 非零但结构化字段齐全
    expect(result).toMatchObject({
      action: 'doctor',
      exit_code: expect.anything(),
      stdout: expect.any(String),
      stderr: expect.any(String),
      timed_out: false,
      partial: expect.any(Boolean),
      cli_version: expect.anything(),
    });
  });

  it('入参透传到子进程参数列表(argv 验证)', async () => {
    // 让 node 打印 argv:args 透传含 JSON 可解析内容
    const probe = createVictauriCliTool({ cliPath: process.execPath });
    const result = (await probe.execute(
      {
        action: 'coverage',
        args: ['--format', 'json'],
      },
      {} as never,
    )) as CliToolValue;
    expect(result.timed_out).toBe(false);
    // node 无 coverage 参数会报 unknown option,stderr 应包含子命令名
    expect(result.stderr + result.stdout).toContain('coverage');
  });

  it('timeout_ms 透传:1ms 超时强杀正常命令 → timed_out', async () => {
    // node 启动需数十 ms,1ms 预算必超时——验证 timeout_ms 确实透传生效
    // (超时全链路已在 cli.test.ts 用长驻脚本独立覆盖;此处 action 挡首位
    // 无法注入 -e 长驻脚本,故用极短预算等价验证)
    const result = (await tool.execute(
      {
        action: 'doctor',
        args: ['-e', 'console.log("ok")'],
        timeout_ms: 1,
      },
      {} as never,
    )) as CliToolValue;
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
  }, 10_000);

  it('默认工具常量可导入且 name 正确', () => {
    expect(victauriCliTool.name).toBe('victauri_cli');
  });

  it('enum 外 action 在 defineTool 参数校验层被拦截', async () => {
    await expect(
      tool.execute(
        // 绕过类型标注模拟非法调用:校验在 execute 内部先行
        { action: 'rm -rf /' as never, args: [] },
        {} as never,
      ),
    ).rejects.toThrow(/must be one of/);
  });

  it('doctor 输出结构化明细(PASS/FAIL/WARN)+ 保留原始 stdout', async () => {
    const doctorTool = createVictauriCliTool({
      version: '0.8.8',
      run: fakeRun({
        exitCode: 0,
        stdout: DOCTOR_SAMPLE_088,
        stderr: '',
        timedOut: false,
      }),
    });
    const result = (await doctorTool.execute(
      { action: 'doctor', args: [] },
      {} as never,
    )) as CliToolValue;
    expect(result.doctor).not.toBeNull();
    expect(result.doctor?.checks).toEqual([
      {
        status: 'FAIL',
        message: 'No Cargo.toml found in current directory',
        detail: 'Run this command from your Tauri project root.',
      },
    ]);
    expect(result.doctor?.passed).toBe(0);
    expect(result.doctor?.total).toBe(1);
    expect(result.doctor?.failed).toBe(1);
    expect(result.doctor?.warnings).toBe(0);
    // 原始 stdout 保留
    expect(result.stdout).toContain('No Cargo.toml found in current directory');
    expect(result.stdout).toContain('Summary: 0/1 passed');
  });

  it('0.8.8 实测:doctor 报告落在 stderr(stdout 为空)时仍解析出结构化明细', async () => {
    const stderrTool = createVictauriCliTool({
      version: '0.8.8',
      run: fakeRun({
        exitCode: 0,
        stdout: '',
        stderr: DOCTOR_SAMPLE_088,
        timedOut: false,
      }),
    });
    const result = (await stderrTool.execute(
      { action: 'doctor', args: [] },
      {} as never,
    )) as CliToolValue;
    expect(result.doctor).not.toBeNull();
    expect(result.doctor?.checks[0]?.status).toBe('FAIL');
    expect(result.doctor?.failed).toBe(1);
    // 原文仍在 stderr 里原样保留
    expect(result.stderr).toContain('Summary: 0/1 passed');
  });

  it('doctor 文本无法解析时回退原文(doctor=null,stdout 原样)', async () => {
    const badTool = createVictauriCliTool({
      version: '0.8.8',
      run: fakeRun({
        exitCode: 1,
        stdout:
          "error: unexpected argument '--json' found\n\nUsage: victauri doctor\n",
        stderr: '',
        timedOut: false,
      }),
    });
    const result = (await badTool.execute(
      { action: 'doctor', args: ['--json'] },
      {} as never,
    )) as CliToolValue;
    expect(result.doctor).toBeNull();
    expect(result.stdout).toContain("unexpected argument '--json' found");
    expect(result.exit_code).toBe(1);
  });

  it('0.8.8 实测:doctor --json 报错在 stderr(stdout 空)→ doctor=null 回退原文', async () => {
    const realTool = createVictauriCliTool({
      version: '0.8.8',
      run: fakeRun({
        exitCode: 2,
        stdout: '',
        stderr:
          "error: unexpected argument '--json' found\n\nUsage: victauri.exe doctor\n\nFor more information, try '--help'.\n",
        timedOut: false,
      }),
    });
    const result = (await realTool.execute(
      { action: 'doctor', args: ['--json'] },
      {} as never,
    )) as CliToolValue;
    expect(result.doctor).toBeNull();
    expect(result.exit_code).toBe(2);
    expect(result.stderr).toContain("unexpected argument '--json' found");
  });

  it('非 doctor 子命令 doctor 字段恒为 null', async () => {
    const initTool = createVictauriCliTool({
      version: '0.8.8',
      run: fakeRun({
        exitCode: 0,
        stdout: DOCTOR_SAMPLE_088,
        stderr: '',
        timedOut: false,
      }),
    });
    const result = (await initTool.execute(
      { action: 'init', args: [] },
      {} as never,
    )) as CliToolValue;
    expect(result.doctor).toBeNull();
  });

  it('长输出预览:头尾双保留 + 省略标记(>6000 字符)', async () => {
    const headMark = 'HEAD_MARKER_';
    const tailMark = '_TAIL_MARKER';
    const longStdout = headMark + 'x'.repeat(8000) + tailMark;
    const longTool = createVictauriCliTool({
      version: '0.8.8',
      run: fakeRun({
        exitCode: 0,
        stdout: longStdout,
        stderr: '',
        timedOut: false,
      }),
    });
    const value = (await longTool.execute(
      { action: 'doctor', args: [] },
      {} as never,
    )) as CliToolValue;
    const rendered = renderText(longTool.output.render({}, value as never));
    // 头尾都出现（尾部的真实报错不再被丢掉）
    expect(rendered).toContain(headMark);
    expect(rendered).toContain(tailMark);
    // 中间省略标记 + 省略字符数
    expect(rendered).toMatch(/截断,省略中间 \d+ 字符,共 \d+ 字符/);
    // 渲染总长可控（预览上限 6000 + 首行摘要 + 标记）
    expect(rendered.length).toBeLessThan(7000);
  });

  it('短输出预览原样保留、不加省略标记', () => {
    const short = 'a'.repeat(100);
    expect(renderPreview(short)).toBe(short);
    expect(renderPreview('a'.repeat(PREVIEW_MAX_CHARS))).not.toContain('截断');
  });

  it('预览按码点切片:多字节字符不被切碎', () => {
    // 头切点落在 emoji 中间（码点 2999/3000 附近）
    const text = 'x'.repeat(2998) + '😀😀😀' + 'y'.repeat(4000);
    const preview = renderPreview(text);
    expect(preview).not.toContain('\uFFFD');
    expect(
      Array.from(preview).every((ch) => ch.codePointAt(0) !== 0xd83d),
    ).toBe(true);
  });

  it('watch 超时:timed_out=true + partial=true + 保留已捕获的部分输出', async () => {
    const watchTool = createVictauriCliTool({
      version: '0.8.8',
      run: fakeRun({
        exitCode: null,
        stdout: 'watching tests...\n',
        stderr: '',
        timedOut: true,
      }),
    });
    const result = (await watchTool.execute(
      { action: 'watch', args: [], timeout_ms: 1000 },
      {} as never,
    )) as CliToolValue;
    expect(result.timed_out).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.exit_code).toBeNull();
    expect(result.stdout).toContain('watching tests...');
    expect(result.hints.long_running).toBe(true);
    expect(result.hints.interactive).toBe(false);
    expect(result.hints.notes.join(' ')).toContain('timeout_ms');
  });

  it('watch/bridge 真实长驻进程超时:timed_out + partial + 部分输出(e2e)', async () => {
    // action 会被拼在 argv 首位,故用「同名脚本文件 + cwd」让 node 跑起长驻进程:
    // node watch → 执行 cwd 下的 watch 文件(node 对无扩展名文件按 CommonJS 处理)
    const dir = mkdtempSync(join(tmpdir(), 'dsh-victauri-cli-'));
    try {
      for (const name of ['watch', 'bridge']) {
        writeFileSync(
          join(dir, name),
          'console.log("partial-output-ok");\nsetInterval(() => {}, 1000);\n',
          'utf8',
        );
      }
      const longTool = createVictauriCliTool({
        cliPath: process.execPath,
        version: '0.8.8',
      });
      for (const action of ['watch', 'bridge'] as const) {
        const result = (await longTool.execute(
          { action, args: [], cwd: dir, timeout_ms: 1500 },
          {} as never,
        )) as CliToolValue;
        expect(result.timed_out, `${action} 应超时`).toBe(true);
        expect(result.partial, `${action} 应标记 partial`).toBe(true);
        expect(result.exit_code).toBeNull();
        expect(result.stdout).toContain('partial-output-ok');
        expect(result.hints.long_running).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('hints 按探测到的版本生成:doctor 恒定提示不提供 --json(D-5 口径)', async () => {
    const oldTool = createVictauriCliTool({
      version: '0.8.8',
      run: fakeRun({
        exitCode: 0,
        stdout: DOCTOR_SAMPLE_088,
        stderr: '',
        timedOut: false,
      }),
    });
    const oldResult = (await oldTool.execute(
      { action: 'doctor', args: [] },
      {} as never,
    )) as CliToolValue;
    expect(oldResult.cli_version).toBe('0.8.8');
    // doctor 的 --json 是不存在的选项(0.8.8 实测报 unexpected argument,
    // 0.10.3 源码亦无),该提示无版本门控、任何版本下恒定出现。
    expect(oldResult.hints.notes.join(' ')).toContain('不提供 --json');

    const newTool = createVictauriCliTool({
      version: '0.10.0',
      run: fakeRun({
        exitCode: 0,
        stdout: DOCTOR_SAMPLE_088,
        stderr: '',
        timedOut: false,
      }),
    });
    const newResult = (await newTool.execute(
      { action: 'doctor', args: [] },
      {} as never,
    )) as CliToolValue;
    expect(newResult.cli_version).toBe('0.10.0');
    expect(newResult.hints.notes.join(' ')).toContain('不提供 --json');
    // 旧的不实口径不得残留
    expect(JSON.stringify(newResult.hints)).not.toContain(
      '0.10.0 起的文档才提供',
    );
  });

  it('版本探测走注入的 probeVersion(生产默认走 victauri_cli_status)', async () => {
    const probeTool = createVictauriCliTool({
      probeVersion: async () => '0.8.8',
      run: fakeRun({
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
      }),
    });
    const result = (await probeTool.execute(
      { action: 'init', args: [] },
      {} as never,
    )) as CliToolValue;
    expect(result.cli_version).toBe('0.8.8');
  });

  it('输出 schema 通过 dsh-tools 校验,且真实返回值符合 schema', async () => {
    const schemaTool = createVictauriCliTool({
      version: '0.8.8',
      run: fakeRun({
        exitCode: 0,
        stdout: DOCTOR_SAMPLE_088,
        stderr: '',
        timedOut: false,
      }),
    });
    const compiled = schemaTool.output.schema;
    expect(() => assertSupportedJsonSchema(compiled)).not.toThrow();
    const value = (await schemaTool.execute(
      { action: 'doctor', args: [] },
      {} as never,
    )) as CliToolValue;
    expect(() => validateJsonSchemaValue(compiled, value)).not.toThrow();
  });
});
