/**
 * victauri_doctor 补充单测（V2 审阅缺口）：
 * 全绿 happy path、依赖三分支、TOML 段边界、工具面差异、探活并发、
 * 工具层参数管道、渲染文本、异常兜底、平台分支。
 *
 * 全部依赖可注入（fs / scan / createClient / probeCli）：不读真实磁盘、
 * 不发真实 HTTP、不 spawn 真实 CLI。
 */
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { VictauriClientLike, VictauriToolInfo } from '../client.ts';
import type { VictauriInstance } from '../discovery.ts';
import type { JsonValue } from '../json.ts';
import {
  createVictauriDoctorTool,
  DOCTOR_PROBE_TIMEOUT_MS,
  DOCTOR_TOOL_NAME,
  findDebugBinary,
  probeInstances,
  resolveWorkspace,
  runDoctorChecks,
  scanVictauriDependency,
  summarizeResult,
  type DoctorCliProbe,
  type DoctorFs,
  type DoctorResult,
} from './doctor.ts';
import { exposedServerToolNames } from './tools-list.ts';

/** 工作区绝对路径（join 拼装，与实现的 node:path 口径一致）。 */
const WS = join(process.cwd(), 'ws-app');
const TAURI_CONF = join(WS, 'src-tauri', 'tauri.conf.json');
const CARGO = join(WS, 'src-tauri', 'Cargo.toml');
const ROOT_CARGO = join(WS, 'Cargo.toml');
const DEBUG_DIR = join(WS, 'src-tauri', 'target', 'debug');
const ROOT_DEBUG_DIR = join(WS, 'target', 'debug');

/** 依赖 + 特征都齐全的 Cargo.toml。 */
const CARGO_WITH_VICTAURI = [
  '[package]',
  'name = "demo"',
  '',
  '[dependencies]',
  'victauri-plugin = { version = "0.10.3", optional = true }',
  '',
  '[features]',
  'default = ["victauri"]',
  'victauri = ["dep:victauri-plugin"]',
].join('\n');

/** 假文件系统：files = 路径 → 内容；dirs = 目录 → 条目列表。 */
function makeFs(
  files: Record<string, string>,
  dirs: Record<string, string[]> = {},
): DoctorFs {
  return {
    existsSync: (path) =>
      Object.prototype.hasOwnProperty.call(files, path) ||
      Object.prototype.hasOwnProperty.call(dirs, path),
    readFileSync: (path) => {
      const content = files[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return content;
    },
    readdirSync: (path) => {
      const entries = dirs[path];
      if (entries === undefined) throw new Error(`no such dir: ${path}`);
      return entries;
    },
  };
}

/** 「全绿」工作区：Tauri 配置 + 完整依赖 + debug 产物。 */
function happyFs(): DoctorFs {
  return makeFs(
    {
      [TAURI_CONF]: JSON.stringify({ product: 'demo' }),
      [CARGO]: CARGO_WITH_VICTAURI,
    },
    // 同时给出 win32(.exe) 与 POSIX(无扩展名) 两种产物名：
    // 缺任一种，未钉 platform 的用例的 debug-build 状态就会随宿主平台漂移
    // （win32 命中 .exe、POSIX 命中无扩展名条目），形成隐藏的宿主耦合。
    { [DEBUG_DIR]: ['demo-app.exe', 'demo-app', 'notes.txt'] },
  );
}

/** 假实例。 */
function fakeInstance(
  overrides: Partial<VictauriInstance> = {},
): VictauriInstance {
  return {
    pid: 4242,
    port: 51234,
    token: 'super-secret-token',
    identifier: 'com.example.demo',
    productName: 'demo-app',
    startedAt: '2026-11-10T00:00:00.000Z',
    version: '0.10.3',
    dir: join(process.cwd(), 'victauri', '4242'),
    ...overrides,
  };
}

/** CLI 探测替身：available / not_found / error。 */
function fakeCli(status: 'available' | 'not_found' | 'error'): DoctorCliProbe {
  return async () => ({
    status,
    version: status === 'available' ? '0.10.3' : null,
    cli_path: status === 'available' ? '/usr/local/bin/victauri' : null,
    error:
      status === 'available'
        ? null
        : { kind: 'not_found', message: 'CLI 未找到', hint: '安装指引' },
  });
}

type FakeClient = Pick<VictauriClientLike, 'info' | 'listTools'>;

/**
 * 假客户端工厂：livePids 里的 pid 探活成功，其余视为死实例；
 * tools 是服务端工具清单。
 */
function fakeClientFactory(options: {
  livePids?: number[];
  tools?: string[];
}): (instance: VictauriInstance, timeoutMs: number) => FakeClient {
  const live = new Set(options.livePids ?? []);
  const tools = options.tools ?? [];
  return (instance) => ({
    info: async (): Promise<Record<string, JsonValue>> => {
      if (!live.has(instance.pid)) {
        throw new Error(`connect refused http://127.0.0.1:${instance.port}/`);
      }
      return { product_name: 'demo-app', version: '0.10.3' };
    },
    listTools: async (): Promise<VictauriToolInfo[]> =>
      tools.map((name) => ({ name, description: `工具 ${name}` })),
  });
}

/** 把 render 产出的 ContentBlock[] 拼成纯文本（便于断言）。 */
function renderText(blocks: unknown[]): string {
  return blocks
    .map((block) => (block as { text?: string }).text ?? '')
    .join('\n');
}

/** 取某项检查。 */
function checkOf(result: DoctorResult, id: string) {
  return result.checks.find((check) => check.id === id);
}

describe('doctor 全链路与结论文案（M1/M2）', () => {
  it('M1 happy path：六项全 pass → verdict ready、summary 含「桥接就绪」', async () => {
    const result = await runDoctorChecks(WS, {
      fs: happyFs(),
      scan: () => [fakeInstance({ pid: 4242 })],
      createClient: fakeClientFactory({
        livePids: [4242],
        tools: exposedServerToolNames(),
      }),
      probeCli: fakeCli('available'),
      platform: 'win32',
      cwd: WS,
    });
    expect(result.is_tauri_project).toBe(true);
    expect(result.verdict).toBe('ready');
    expect(result.checks.map((check) => check.id)).toEqual([
      'workspace',
      'dependency',
      'live-instance',
      'tool-face',
      'debug-build',
      'cli',
    ]);
    expect(result.checks.map((check) => check.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
      'pass',
    ]);
    expect(result.summary).toContain('桥接就绪，可以直接开发调试。');
    expect(result.summary).toContain('6 通过');
    expect(result.summary).toContain('0 阻断');
    expect(result.summary).toContain('0 提示');
    expect(result.summary).toContain('0 跳过');
  });

  it('M2 summarizeResult：ready 说「桥接就绪」，blocked 按是否 Tauri 分两种措辞', () => {
    const ready = summarizeResult({
      verdict: 'ready',
      is_tauri_project: true,
      checks: [{ id: 'a', status: 'pass', message: 'm' }],
    });
    expect(ready).toContain('体检 1 项');
    expect(ready).toContain('1 通过');
    expect(ready).toContain('0 阻断');
    expect(ready).toContain('桥接就绪，可以直接开发调试。');

    const blockedTauri = summarizeResult({
      verdict: 'blocked',
      is_tauri_project: true,
      checks: [{ id: 'a', status: 'fail', message: 'm' }],
    });
    expect(blockedTauri).toContain('1 阻断');
    expect(blockedTauri).toContain('存在阻断项');

    // 非 Tauri 工作区的 blocked 措辞与 Tauri 不同（不承诺「修复 fail 项」）。
    const blockedNonTauri = summarizeResult({
      verdict: 'blocked',
      is_tauri_project: false,
      checks: [{ id: 'a', status: 'fail', message: 'm' }],
    });
    expect(blockedNonTauri).toContain('当前工作区不是 Tauri 项目');
    expect(blockedNonTauri).not.toContain('存在阻断项');

    const partial = summarizeResult({
      verdict: 'partial',
      is_tauri_project: true,
      checks: [{ id: 'a', status: 'warn', message: 'm' }],
    });
    expect(partial).toContain('1 提示');
    expect(partial).toContain('桥接可用，但建议处理 warn 项');
  });
});

describe('doctor 依赖检查（M3/M4/M5/N2/N6）', () => {
  it('M3① 有 tauri.conf.json 但没有 Cargo.toml → dependency fail', async () => {
    const result = await runDoctorChecks(WS, {
      fs: makeFs({ [TAURI_CONF]: JSON.stringify({ product: 'demo' }) }),
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const dep = checkOf(result, 'dependency');
    expect(dep?.status).toBe('fail');
    expect(dep?.message).toContain('没找到 Cargo.toml');
    expect(result.verdict).toBe('blocked');
  });

  it('M3② 有依赖但没有 [features] 段 → dependency warn', async () => {
    const result = await runDoctorChecks(WS, {
      fs: makeFs({
        [TAURI_CONF]: JSON.stringify({ product: 'demo' }),
        [CARGO]: '[dependencies]\nvictauri-plugin = "0.10"\n',
      }),
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const dep = checkOf(result, 'dependency');
    expect(dep?.status).toBe('warn');
    expect(dep?.message).toContain('[features] 未定义 victauri 特征');
    expect(result.verdict).toBe('partial');
  });

  it('M3③ [features] 定义了 victauri 但 default 不含 → dependency warn', async () => {
    const result = await runDoctorChecks(WS, {
      fs: makeFs({
        [TAURI_CONF]: JSON.stringify({ product: 'demo' }),
        [CARGO]: [
          '[dependencies]',
          'victauri-plugin = "0.10"',
          '',
          '[features]',
          'victauri = ["dep:victauri-plugin"]',
          'default = ["tauri"]',
        ].join('\n'),
      }),
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const dep = checkOf(result, 'dependency');
    expect(dep?.status).toBe('warn');
    expect(dep?.message).toContain('default 未包含');
    expect(dep?.message).not.toContain('没找到 Cargo.toml');
  });

  it('M4 Cargo.toml 读不出来 → 路径仍在、三个 flag 全 false（不抛错）', () => {
    const scan = scanVictauriDependency(WS, {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error('EACCES');
      },
      readdirSync: () => [],
    });
    expect(scan.cargoPath).toBe(CARGO);
    expect(scan.hasVictauriPluginDep).toBe(false);
    expect(scan.featureDefined).toBe(false);
    expect(scan.featureEnabledByDefault).toBe(false);
  });

  it('M5 [features] 段边界：后续段的 default/victauri 不得串味', () => {
    const scan = scanVictauriDependency(
      WS,
      makeFs({
        [CARGO]: [
          '[dependencies]',
          'victauri-plugin = "0.10"',
          '',
          '[features]',
          'other = []',
          '',
          '[package.metadata]',
          'default = ["victauri"]',
          'victauri = "x"',
        ].join('\n'),
      }),
    );
    expect(scan.hasVictauriPluginDep).toBe(true);
    expect(scan.featureDefined).toBe(false);
    expect(scan.featureEnabledByDefault).toBe(false);
  });

  it('M5 [features] 的 default 含 victauri → featureEnabledByDefault 为 true', () => {
    const scan = scanVictauriDependency(
      WS,
      makeFs({
        [CARGO]: '[features]\ndefault = ["tauri","victauri"]\n',
      }),
    );
    expect(scan.featureEnabledByDefault).toBe(true);
  });

  it('M5 表语法依赖 [dependencies.victauri-plugin] 也算已声明依赖', () => {
    const scan = scanVictauriDependency(
      WS,
      makeFs({
        [CARGO]: '[dependencies.victauri-plugin]\nversion = "0.10"\n',
      }),
    );
    expect(scan.hasVictauriPluginDep).toBe(true);
  });

  it('N2 根布局 Cargo.toml（<ws>/Cargo.toml）也能命中', () => {
    const scan = scanVictauriDependency(
      WS,
      makeFs({ [ROOT_CARGO]: CARGO_WITH_VICTAURI }),
    );
    expect(scan.cargoPath).toBe(ROOT_CARGO);
    expect(scan.hasVictauriPluginDep).toBe(true);
    expect(scan.featureEnabledByDefault).toBe(true);
  });

  it('N6 dependency 文案带 Cargo.toml 绝对路径（便于直接定位文件）', async () => {
    const result = await runDoctorChecks(WS, {
      fs: makeFs({
        [TAURI_CONF]: JSON.stringify({ product: 'demo' }),
        [CARGO]: '[dependencies]\ntauri = "2"\n',
      }),
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const dep = checkOf(result, 'dependency');
    expect(dep?.status).toBe('fail');
    expect(dep?.message).toContain(CARGO);
    expect(dep?.message).toContain('未声明 victauri-plugin 依赖');
  });
});

describe('doctor 工具面与活体实例（M6/M7/N4）', () => {
  it('M6 服务端清单 == 插件暴露面 → tool-face pass（含「一致」）', async () => {
    const result = await runDoctorChecks(WS, {
      fs: happyFs(),
      scan: () => [fakeInstance({ pid: 4242 })],
      createClient: fakeClientFactory({
        livePids: [4242],
        tools: exposedServerToolNames(),
      }),
      probeCli: fakeCli('available'),
      platform: 'win32',
      cwd: WS,
    });
    const face = checkOf(result, 'tool-face');
    expect(face?.status).toBe('pass');
    expect(face?.message).toContain('一致');
    expect(face?.message).toContain('比对实例 pid 4242');
    expect(face?.message).toContain(
      `插件暴露面（${exposedServerToolNames().length} 个）`,
    );
  });

  it('M6 listTools 抛错 → tool-face skip（查询服务端工具清单失败）', async () => {
    const result = await runDoctorChecks(WS, {
      fs: happyFs(),
      scan: () => [fakeInstance({ pid: 4242 })],
      createClient: () => ({
        info: async (): Promise<Record<string, JsonValue>> => ({
          product_name: 'demo-app',
        }),
        listTools: async (): Promise<VictauriToolInfo[]> => {
          throw new Error('http://127.0.0.1:51234/api/tools');
        },
      }),
      probeCli: fakeCli('available'),
      platform: 'win32',
      cwd: WS,
    });
    const face = checkOf(result, 'tool-face');
    expect(face?.status).toBe('skip');
    expect(face?.message).toContain('跳过：查询服务端工具清单失败');
    // 失败原因不带端口 URL
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
  });

  it('M6 服务端多出插件没暴露的工具 → tool-face warn（数量 + 名字）', async () => {
    const result = await runDoctorChecks(WS, {
      fs: happyFs(),
      scan: () => [fakeInstance({ pid: 4242 })],
      createClient: fakeClientFactory({
        livePids: [4242],
        tools: [...exposedServerToolNames(), 'brand_new_server_tool'],
      }),
      probeCli: fakeCli('available'),
      platform: 'win32',
      cwd: WS,
    });
    const face = checkOf(result, 'tool-face');
    expect(face?.status).toBe('warn');
    expect(face?.message).toContain(
      '服务端有而插件未暴露 1 个（brand_new_server_tool）',
    );
    expect(face?.message).toContain('插件暴露而服务端没有 0 个');
  });

  it('M6 插件暴露但服务端没有的工具 → tool-face warn（数量 + 名字）', async () => {
    const result = await runDoctorChecks(WS, {
      fs: happyFs(),
      scan: () => [fakeInstance({ pid: 4242 })],
      createClient: fakeClientFactory({
        livePids: [4242],
        tools: exposedServerToolNames().filter((name) => name !== 'screenshot'),
      }),
      probeCli: fakeCli('available'),
      platform: 'win32',
      cwd: WS,
    });
    const face = checkOf(result, 'tool-face');
    expect(face?.status).toBe('warn');
    expect(face?.message).toContain('插件暴露而服务端没有 1 个（screenshot）');
    expect(face?.message).toContain('服务端有而插件未暴露 0 个');
  });

  it('M7 live-instance pass：活体数 + 陈旧 discovery 目录后缀', async () => {
    const result = await runDoctorChecks(WS, {
      fs: happyFs(),
      scan: () => [fakeInstance({ pid: 4242 }), fakeInstance({ pid: 888 })],
      createClient: fakeClientFactory({ livePids: [4242] }),
      probeCli: fakeCli('available'),
      platform: 'win32',
      cwd: WS,
    });
    const live = checkOf(result, 'live-instance');
    expect(live?.status).toBe('pass');
    expect(live?.message).toContain('发现 1 个活体实例');
    expect(live?.message).toContain('另有 1 个陈旧 discovery 目录（pid 888）');
  });

  it('N4 无活体实例时 tool-face skip 文案是「没有活体实例」', async () => {
    const result = await runDoctorChecks(WS, {
      fs: happyFs(),
      scan: () => [],
      probeCli: fakeCli('available'),
      platform: 'win32',
      cwd: WS,
    });
    const face = checkOf(result, 'tool-face');
    expect(face?.status).toBe('skip');
    expect(face?.message).toContain('跳过：没有活体实例');
    expect(face?.message).not.toContain('查询服务端工具清单失败');
  });
});

describe('doctor 探活并发（M8）', () => {
  it('M8 probeInstances：三实例并发探活（屏障互等），live/dead 按 pid 升序', async () => {
    let arrived = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const timeouts: number[] = [];
    const instances = [
      fakeInstance({ pid: 30 }),
      fakeInstance({ pid: 10 }),
      fakeInstance({ pid: 20 }),
    ];
    const probe = probeInstances(
      instances,
      (instance, timeoutMs) => {
        timeouts.push(timeoutMs);
        return {
          info: async (): Promise<Record<string, JsonValue>> => {
            arrived += 1;
            // 三方互等：串行实现下第一个 info() 永远等不到另外两个。
            if (arrived >= instances.length) release();
            await gate;
            if (instance.pid === 20) throw new Error('dead instance');
            return { product_name: 'demo-app', version: '0.10.3' };
          },
          listTools: async (): Promise<VictauriToolInfo[]> => [],
        };
      },
      1500,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `探活是串行的：只等到了 ${arrived} 个并发 info()（期望 3 个同时到达）`,
          ),
        );
      }, 1000);
    });
    let result: Awaited<typeof probe>;
    try {
      result = await Promise.race([probe, guard]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    expect(result.live.map((entry) => entry.pid)).toEqual([10, 30]);
    expect(result.dead).toEqual([20]);
    expect(timeouts).toEqual([1500, 1500, 1500]);
  });
});

describe('doctor 工具层参数管道与渲染（M9/M10/M12/N9/N11）', () => {
  it('M9 execute：probe_timeout_ms 透传给 createClient', async () => {
    const timeouts: number[] = [];
    const tool = createVictauriDoctorTool({
      fs: happyFs(),
      scan: () => [fakeInstance({ pid: 4242 })],
      createClient: (_instance, timeoutMs) => {
        timeouts.push(timeoutMs);
        return {
          info: async (): Promise<Record<string, JsonValue>> => ({
            product_name: 'demo-app',
          }),
          listTools: async (): Promise<VictauriToolInfo[]> => [],
        };
      },
      probeCli: fakeCli('available'),
      platform: 'win32',
      cwd: WS,
    });
    await tool.execute({ workspace: WS, probe_timeout_ms: 1500 }, {} as never);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((value) => value === 1500)).toBe(true);
  });

  it('M9 execute：probe_timeout_ms 非法（0 / -1）时回落默认 2000', async () => {
    const timeouts: number[] = [];
    const tool = createVictauriDoctorTool({
      fs: happyFs(),
      scan: () => [fakeInstance({ pid: 4242 })],
      createClient: (_instance, timeoutMs) => {
        timeouts.push(timeoutMs);
        return {
          info: async (): Promise<Record<string, JsonValue>> => ({
            product_name: 'demo-app',
          }),
          listTools: async (): Promise<VictauriToolInfo[]> => [],
        };
      },
      probeCli: fakeCli('available'),
      platform: 'win32',
      cwd: WS,
    });
    await tool.execute({ workspace: WS, probe_timeout_ms: 0 }, {} as never);
    await tool.execute({ workspace: WS, probe_timeout_ms: -1 }, {} as never);
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.every((value) => value === DOCTOR_PROBE_TIMEOUT_MS)).toBe(
      true,
    );
    expect(DOCTOR_PROBE_TIMEOUT_MS).toBe(2000);
  });

  it('M9 execute：相对 workspace 按 deps.cwd 解析成绝对路径', async () => {
    const tool = createVictauriDoctorTool({
      fs: happyFs(),
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const value = (await tool.execute(
      { workspace: 'app' },
      {} as never,
    )) as unknown as DoctorResult;
    expect(value.workspace).toBe(resolve(WS, 'app'));
  });

  it('M10 output.render：标题、逐项图标与结论行都渲染出来', () => {
    const tool = createVictauriDoctorTool({
      fs: happyFs(),
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const value: DoctorResult = {
      workspace: WS,
      is_tauri_project: true,
      verdict: 'partial',
      checks: [
        { id: 'workspace', status: 'pass', message: '是 Tauri 项目' },
        { id: 'dependency', status: 'fail', message: '依赖有问题' },
        { id: 'tool-face', status: 'skip', message: '跳过：没有活体实例' },
      ],
      summary:
        '体检 3 项：1 通过 / 1 阻断 / 0 提示 / 1 跳过。桥接可用，但建议处理 warn 项（见 checks）。',
    };
    const text = renderText(tool.output.render({}, value as never));
    expect(text).toContain(`victauri 桥接体检（${WS}）`);
    expect(text).toContain('\u2713 [workspace]');
    expect(text).toContain('\u2717 [dependency]');
    expect(text).toContain('\uFF0D [tool-face]');
    expect(text).toContain('结论：partial —— ');
  });

  it('M12 execute 异常兜底：结构化 fail 检查且不泄漏异常原文', async () => {
    const tool = createVictauriDoctorTool({
      fs: {
        existsSync: (path) => {
          if (path.endsWith('Cargo.toml')) {
            throw new Error('GET http://127.0.0.1:7373/api/info failed');
          }
          return true;
        },
        readFileSync: () => '',
        readdirSync: () => [],
      },
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const value = (await tool.execute(
      { workspace: WS },
      {} as never,
    )) as unknown as DoctorResult;
    expect(value.verdict).toBe('blocked');
    expect(value.is_tauri_project).toBe(true);
    expect(value.checks.length).toBe(1);
    expect(value.checks[0]?.id).toBe('doctor');
    expect(value.checks[0]?.status).toBe('fail');
    expect(value.summary).toBe('体检执行异常，未能完成检查。');
    expect(value.checks[0]?.message).toContain('体检执行异常');
    expect(value.checks[0]?.message).not.toContain('127.0.0.1');
    expect(JSON.stringify(value)).not.toContain('127.0.0.1');
  });

  it('M12 execute 异常兜底：连 Tauri 探测都失败时按「无法确认」处理', async () => {
    let calls = 0;
    const tool = createVictauriDoctorTool({
      fs: {
        existsSync: () => {
          calls += 1;
          if (calls === 1) throw new Error('fs 炸了');
          return false;
        },
        readFileSync: () => '',
        readdirSync: () => [],
      },
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const value = (await tool.execute(
      { workspace: WS },
      {} as never,
    )) as unknown as DoctorResult;
    expect(value.is_tauri_project).toBe(false);
    expect(value.verdict).toBe('blocked');
    expect(value.checks.length).toBe(1);
    expect(value.checks[0]?.id).toBe('doctor');
    expect(value.summary).toBe('体检执行异常，未能完成检查。');
  });

  it('N9 工具名与工具级超时预算固定', () => {
    const tool = createVictauriDoctorTool();
    expect(tool.name).toBe(DOCTOR_TOOL_NAME);
    expect(DOCTOR_TOOL_NAME).toBe('victauri_doctor');
    expect(tool.timeoutMs).toBe(30_000);
  });

  it('N11 resolveWorkspace：非字符串 / 空串都回落 cwd', () => {
    expect(resolveWorkspace(undefined, WS)).toBe(WS);
    expect(resolveWorkspace('   ', WS)).toBe(WS);
    expect(resolveWorkspace(123 as unknown as string, WS)).toBe(WS);
  });
});

describe('doctor debug 产物平台分支与 CLI 文案（N1/N5/N7）', () => {
  it('N1 findDebugBinary：win32 取 *.exe、linux 取无扩展名普通文件', () => {
    const winFs = makeFs({}, { [DEBUG_DIR]: ['demo-app.exe', 'notes.txt'] });
    expect(findDebugBinary(WS, winFs, 'win32')).toBe(
      join(DEBUG_DIR, 'demo-app.exe'),
    );

    const linuxFs = makeFs({}, { [DEBUG_DIR]: ['demo-app', 'notes.txt'] });
    expect(findDebugBinary(WS, linuxFs, 'linux')).toBe(
      join(DEBUG_DIR, 'demo-app'),
    );
    // win32 下无扩展名文件不算产物
    expect(findDebugBinary(WS, linuxFs, 'win32')).toBeNull();
  });

  it('N1 findDebugBinary：isDirectory 存在时排除子目录（build 无扩展名）', () => {
    const fs: DoctorFs = {
      ...makeFs({}, { [DEBUG_DIR]: ['build', 'demo-app'] }),
      isDirectory: (path) => path.endsWith('build'),
    };
    expect(findDebugBinary(WS, fs, 'linux')).toBe(join(DEBUG_DIR, 'demo-app'));
  });

  it('N1 findDebugBinary：根布局 <ws>/target/debug 也认', () => {
    const fs = makeFs({}, { [ROOT_DEBUG_DIR]: ['demo-app.exe'] });
    expect(findDebugBinary(WS, fs, 'win32')).toBe(
      join(ROOT_DEBUG_DIR, 'demo-app.exe'),
    );
  });

  it('N5 cli pass 文案带可执行路径与版本号', async () => {
    const result = await runDoctorChecks(WS, {
      fs: happyFs(),
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const cli = checkOf(result, 'cli');
    expect(cli?.status).toBe('pass');
    expect(cli?.message).toContain('victauri CLI 可用');
    expect(cli?.message).toContain('/usr/local/bin/victauri');
    expect(cli?.message).toContain('v0.10.3');
  });

  it('N7 CLI 两种失败措辞不同：不可用 vs 探测失败', async () => {
    const notFound = await runDoctorChecks(WS, {
      fs: happyFs(),
      scan: () => [],
      probeCli: fakeCli('not_found'),
      cwd: WS,
    });
    const notFoundCli = checkOf(notFound, 'cli');
    expect(notFoundCli?.status).toBe('warn');
    expect(notFoundCli?.message).toContain('victauri CLI 不可用');
    expect(notFoundCli?.message).not.toContain('探测失败');

    const failed = await runDoctorChecks(WS, {
      fs: happyFs(),
      scan: () => [],
      probeCli: async () => {
        throw new Error('spawn failed');
      },
      cwd: WS,
    });
    const failedCli = checkOf(failed, 'cli');
    expect(failedCli?.status).toBe('warn');
    expect(failedCli?.message).toContain('victauri CLI 探测失败');
    expect(failedCli?.message).not.toContain('CLI 不可用');
  });
});
