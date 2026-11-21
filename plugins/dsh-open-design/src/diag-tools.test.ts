/**
 * 诊断工具契约测试：工具名固定两个、输出为无 undefined 的 JSON 记录。
 */
import { describe, expect, it, vi } from 'vitest';

import {
  createDiagnosticTools,
  DIAGNOSTIC_TOOL_COUNT,
  REDETECT_TOOL_NAME,
  STATUS_TOOL_NAME,
  type DiagnosticReport,
  type DiagnosticRuntime,
} from './diag-tools.ts';

const REPORT: DiagnosticReport = {
  autoDetect: true,
  serverName: 'open-design',
  source: 'custom',
  command: 'E:\\Programs\\Open Design\\Open Design.exe',
  args: ['daemon-cli.mjs', 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  cwd: '',
  startupTimeoutMs: 120000,
  toolCallTimeoutMs: 60000,
  detectionMethod: 'pipe',
  installed: true,
  stamp: {
    channel: 'stable',
    namespace: 'release-stable-win',
    source: 'packaged',
    mode: 'runtime',
    app: 'daemon',
  },
  endpoint: '\\\\.\\pipe\\open-design-sidecar-6eec4ea0e7395b977771b1af7124c1b9',
  installDir: 'E:\\Programs\\Open Design',
  dataDir: 'C:\\data',
  daemonCliPath: 'E:\\daemon-cli.mjs',
  connectionState: 'connected',
  failedAttempts: 0,
  maxAttempts: 10,
  lastError: null,
  upstreamToolCount: 22,
  upstreamSkippedTools: [],
  diagnosticToolCount: 2,
  configFile: 'C:\\config.json',
};

function stubRuntime(): DiagnosticRuntime & { redetectCalls: number } {
  const runtime = {
    redetectCalls: 0,
    status: vi.fn(() => REPORT),
    redetect: vi.fn(async () => {
      runtime.redetectCalls += 1;
      return REPORT;
    }),
  };
  return runtime;
}

type Executable = {
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>;
};

describe('dsh-open-design 诊断工具', () => {
  it('固定提供两个工具，名称与文档一致', () => {
    const tools = createDiagnosticTools(stubRuntime());
    expect(tools).toHaveLength(DIAGNOSTIC_TOOL_COUNT);
    expect(tools.map((tool) => tool.name)).toEqual([
      STATUS_TOOL_NAME,
      REDETECT_TOOL_NAME,
    ]);
    expect(STATUS_TOOL_NAME).toBe('open_design_status');
    expect(REDETECT_TOOL_NAME).toBe('open_design_redetect');
  });

  it('status 工具返回运行时快照，且不含 undefined', async () => {
    const runtime = stubRuntime();
    const tools = createDiagnosticTools(runtime);
    const result = await (tools[0] as unknown as Executable).execute({}, {});

    expect(runtime.status).toHaveBeenCalledTimes(1);
    expect(result.command).toBe(REPORT.command);
    expect(result.upstreamToolCount).toBe(22);
    for (const value of Object.values(result)) {
      expect(value).not.toBeUndefined();
    }
  });

  it('redetect 工具触发重新探测并返回新快照', async () => {
    const runtime = stubRuntime();
    const tools = createDiagnosticTools(runtime);
    const result = await (tools[1] as unknown as Executable).execute({}, {});

    expect(runtime.redetectCalls).toBe(1);
    expect(result.detectionMethod).toBe('pipe');
  });

  it('两个工具都有说明文本与输出 schema', () => {
    const tools = createDiagnosticTools(stubRuntime());
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.output.schema).toBeDefined();
      expect(typeof tool.output.render).toBe('function');
    }
  });
});
