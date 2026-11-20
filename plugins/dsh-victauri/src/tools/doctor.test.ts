/**
 * victauri_doctor 单测：六项检查的行为、verdict 聚合、敏感信息不外泄。
 *
 * 全部依赖可注入（fs / scan / createClient / probeCli），测试不碰本机真实
 * discovery 目录、不发真实 HTTP、不 spawn 真实 CLI。
 */
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { VictauriInstance } from '../discovery.ts';
import {
  createVictauriDoctorTool,
  DOCTOR_PROBE_TIMEOUT_MS,
  DOCTOR_TOOL_NAME,
  findDebugBinary,
  findTauriConf,
  probeInstances,
  resolveWorkspace,
  runDoctorChecks,
  scanVictauriDependency,
  summarizeResult,
  verdictFrom,
  type DoctorCheck,
  type DoctorCliProbe,
  type DoctorFs,
  type DoctorResult,
} from './doctor.ts';

/** 工作区绝对路径（用 join 拼，Windows/POSIX 都能命中实现里的路径口径）。 */
const WS = join(process.cwd(), 'ws-app');
const TAURI_CONF = join(WS, 'src-tauri', 'tauri.conf.json');
const CARGO = join(WS, 'src-tauri', 'Cargo.toml');
const DEBUG_DIR = join(WS, 'src-tauri', 'target', 'debug');

/**
 * 假文件系统：files = 路径 → 内容；
 * entries = 目录 → 条目清单（readdirSync 的返回值，键即「该目录存在」）。
 *
 * 目录条目必须逐个用例显式声明：findDebugBinary 按平台取产物
 * （win32 取 *.exe，其他平台取无扩展名条目），同一份条目清单在两个平台下
 * 选中的产物不同，固定清单会让断言的期望值隐含依赖宿主平台，
 * 在 CI（ubuntu-latest）与本机（Windows）上表现不同（见 CI run 42777669458）。
 *
 * 目录存在性只由 entries 的键决定（不另设 dirs 形参）：否则「声明了目录
 * 却忘了给条目清单」会被实现侧 catch 成 null，让 toBeNull 断言假绿。
 */
function fakeFs(
  files: Record<string, string>,
  entries: Record<string, string[]> = {},
): DoctorFs {
  return {
    existsSync: (path) =>
      Object.prototype.hasOwnProperty.call(files, path) ||
      Object.prototype.hasOwnProperty.call(entries, path),
    readFileSync: (path) => {
      if (!Object.prototype.hasOwnProperty.call(files, path))
        throw new Error(`no such file: ${path}`);
      return files[path];
    },
    readdirSync: (path) => {
      const list = entries[path];
      if (list === undefined) throw new Error(`no such dir: ${path}`);
      return list;
    },
  };
}

/** 一个完整 Tauri + victauri 工作区的假文件系统。 */
function tauriFs(
  extra: Record<string, string> = {},
  entries: Record<string, string[]> = {},
): DoctorFs {
  return fakeFs(
    {
      [TAURI_CONF]: JSON.stringify({ product: 'demo' }),
      [CARGO]: CARGO_WITH_VICTAURI,
      ...extra,
    },
    entries,
  );
}

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

/** CLI 探测替身：available / not_found。 */
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

describe('doctor 纯函数', () => {
  it('resolveWorkspace：入参优先、相对路径按 cwd 解析、空值回落 cwd', () => {
    const abs = join(process.cwd(), 'abs', 'path');
    expect(resolveWorkspace(abs, WS)).toBe(abs);
    expect(resolveWorkspace('rel/path', WS)).toBe(resolve(WS, 'rel/path'));
    expect(resolveWorkspace('   ', WS)).toBe(WS);
    expect(resolveWorkspace(undefined, WS)).toBe(WS);
  });

  it('findTauriConf：src-tauri 布局优先于根布局', () => {
    const fs = fakeFs({
      [join(WS, 'src-tauri', 'tauri.conf.json')]: TAURI_CONF,
      [join(WS, 'tauri.conf.json')]: TAURI_CONF,
    });
    expect(findTauriConf(WS, fs)).toBe(
      join(WS, 'src-tauri', 'tauri.conf.json'),
    );

    const rootOnly = fakeFs({ [join(WS, 'tauri.conf.json')]: TAURI_CONF });
    expect(findTauriConf(WS, rootOnly)).toBe(join(WS, 'tauri.conf.json'));

    expect(findTauriConf(WS, fakeFs({}))).toBeNull();
  });

  it('scanVictauriDependency：识别依赖、特征定义与 default 启用', () => {
    const scan = scanVictauriDependency(WS, tauriFs());
    expect(scan.cargoPath).toBe(CARGO);
    expect(scan.hasVictauriPluginDep).toBe(true);
    expect(scan.featureDefined).toBe(true);
    expect(scan.featureEnabledByDefault).toBe(true);
  });

  it('scanVictauriDependency：缺依赖 / 缺特征 / default 未启用各自可辨', () => {
    const noDep = scanVictauriDependency(
      WS,
      fakeFs({ [CARGO]: '[dependencies]\ntauri = "2"\n' }),
    );
    expect(noDep.hasVictauriPluginDep).toBe(false);

    const noFeature = scanVictauriDependency(
      WS,
      fakeFs({
        [CARGO]: '[dependencies]\nvictauri-plugin = "0.10"\n',
      }),
    );
    expect(noFeature.hasVictauriPluginDep).toBe(true);
    expect(noFeature.featureDefined).toBe(false);

    const notDefault = scanVictauriDependency(
      WS,
      fakeFs({
        [CARGO]:
          '[dependencies]\nvictauri-plugin = "0.10"\n\n[features]\nvictauri = []\ndefault = []\n',
      }),
    );
    expect(notDefault.featureDefined).toBe(true);
    expect(notDefault.featureEnabledByDefault).toBe(false);

    const missing = scanVictauriDependency(WS, fakeFs({}));
    expect(missing.cargoPath).toBeNull();
  });

  it('verdictFrom：fail→blocked、warn→partial、全 pass/skip→ready', () => {
    const check = (status: DoctorCheck['status']): DoctorCheck => ({
      id: 'x',
      status,
      message: 'm',
    });
    expect(verdictFrom([check('pass'), check('fail')])).toBe('blocked');
    expect(verdictFrom([check('pass'), check('warn')])).toBe('partial');
    expect(verdictFrom([check('pass'), check('skip')])).toBe('ready');
    expect(verdictFrom([])).toBe('ready');
  });

  it('summarizeResult：给出各项计数与结论措辞', () => {
    const checks: DoctorCheck[] = [
      { id: 'a', status: 'pass', message: 'm' },
      { id: 'b', status: 'warn', message: 'm' },
      { id: 'c', status: 'skip', message: 'm' },
    ];
    const text = summarizeResult({
      verdict: 'partial',
      is_tauri_project: true,
      checks,
    });
    expect(text).toContain('体检 3 项');
    expect(text).toContain('1 通过');
    expect(text).toContain('1 提示');
    expect(text).toContain('1 跳过');
    expect(text).toContain('warn');

    const blocked = summarizeResult({
      verdict: 'blocked',
      is_tauri_project: false,
      checks: [{ id: 'a', status: 'fail', message: 'm' }],
    });
    expect(blocked).toContain('不是 Tauri 项目');
  });

  it('findDebugBinary：按平台取 debug 产物（win32 取 *.exe，POSIX 取无扩展名条目）', () => {
    // 显式平台分支：win32 认 .exe
    const winFs = fakeFs(
      {},
      {
        [DEBUG_DIR]: ['dummy.exe', 'notes.txt'],
      },
    );
    expect(findDebugBinary(WS, winFs, 'win32')).toBe(
      join(DEBUG_DIR, 'dummy.exe'),
    );

    // 显式平台分支：POSIX 认无扩展名条目
    // （「排除 build/deps 子目录」的普通文件口径由 doctor.extra.test.ts:694-722 覆盖，
    //  本文件夹具不提供 isDirectory，isFile 恒为 true）
    const posixFs = fakeFs(
      {},
      {
        [DEBUG_DIR]: ['dummy', 'notes.txt'],
      },
    );
    expect(findDebugBinary(WS, posixFs, 'linux')).toBe(
      join(DEBUG_DIR, 'dummy'),
    );

    // 平台与产物形态不匹配时取不到产物（跨平台误用应为空，而不是错判）
    expect(findDebugBinary(WS, winFs, 'linux')).toBeNull();
    expect(findDebugBinary(WS, posixFs, 'win32')).toBeNull();
  });

  it('findDebugBinary：win32 分支大小写不敏感；目录不存在按无产物处理', () => {
    // win32 取 *.exe 是大小写不敏感的（实现走 toLowerCase().endsWith('.exe')）
    const upperFs = fakeFs(
      {},
      {
        [DEBUG_DIR]: ['DUMMY.EXE', 'notes.txt'],
      },
    );
    expect(findDebugBinary(WS, upperFs, 'win32')).toBe(
      join(DEBUG_DIR, 'DUMMY.EXE'),
    );

    // 目录不存在 → 两个平台都返回 null
    const noDirFs = fakeFs({}, {});
    expect(findDebugBinary(WS, noDirFs, 'win32')).toBeNull();
    expect(findDebugBinary(WS, noDirFs, 'linux')).toBeNull();
  });

  it('findDebugBinary：src-tauri 布局无产物时回退到根布局 <ws>/target/debug', () => {
    // 第一候选目录存在但没有匹配产物 → 继续尝试第二候选目录（doctor.ts:630-653）
    const rootDebug = join(WS, 'target', 'debug');
    const fallbackFs = fakeFs(
      {},
      {
        [DEBUG_DIR]: ['notes.txt'],
        [rootDebug]: ['dummy.exe'],
      },
    );
    expect(findDebugBinary(WS, fallbackFs, 'win32')).toBe(
      join(rootDebug, 'dummy.exe'),
    );
  });

  it('findDebugBinary：isDirectory 抛错时按普通文件处理', () => {
    // 实现侧 isDirectory 探测失败时保守地按「普通文件」看待（doctor.ts:638-640）
    const throwingFs: DoctorFs = {
      ...fakeFs({}, { [DEBUG_DIR]: ['dummy'] }),
      isDirectory: () => {
        throw new Error('EACCES');
      },
    };
    expect(findDebugBinary(WS, throwingFs, 'linux')).toBe(
      join(DEBUG_DIR, 'dummy'),
    );
  });

  it('findDebugBinary：POSIX 分支排除任何含点条目（实现口径 name.includes(".")）', () => {
    // 实现口径是「名字里不含点」而非严格的「无扩展名」：
    // 'demo.app' 这种含点名字也会被排除（doctor.ts:646）。
    // 这里把既有口径钉死，避免后续无声漂移。
    const dottedFs = fakeFs(
      {},
      {
        [DEBUG_DIR]: ['demo.app', 'demo-app'],
      },
    );
    expect(findDebugBinary(WS, dottedFs, 'linux')).toBe(
      join(DEBUG_DIR, 'demo-app'),
    );
  });

  it('findDebugBinary：同目录多个产物时取 readdir 返回的第一个', () => {
    // 实现取 binaries[0]（doctor.ts:648-649），即 readdir 返回顺序里的首个匹配项；
    // 假 fs 的数组顺序确定 → 断言稳定，不依赖真实文件系统顺序。
    const multiFs = fakeFs(
      {},
      {
        [DEBUG_DIR]: ['a.exe', 'b.exe'],
      },
    );
    expect(findDebugBinary(WS, multiFs, 'win32')).toBe(
      join(DEBUG_DIR, 'a.exe'),
    );
  });

  it('findDebugBinary：未显式传平台时走宿主平台分支', () => {
    // 平台伪装：把「不传 platform 就按宿主平台分支」这条默认路径
    // 在任意宿主上确定性地验证（本机 Windows / CI ubuntu 各跑一遍）。
    // 修复前 CI（ubuntu-latest）失败形态：默认分支取无扩展名文件，
    // 夹具只有 dummy.exe → 返回 null（见 CI run 42777669458）。
    //
    // 前提：本用例改的是进程级全局 process.platform。当前 vitest.config.ts 只有
    // test.environment='node'（默认 pool=forks、isolate=true、
    // sequence.concurrent=false），每个测试文件独立 worker 进程、同文件内顺序执行，
    // 因此伪装窗口不会污染其它用例。若改成 pool=threads + isolate=false、
    // 开启并发，或把依赖宿主平台的用例并进同一 worker，需先把本用例拆到独立文件。
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    expect(original).toBeDefined();
    try {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const winFs = fakeFs({}, { [DEBUG_DIR]: ['dummy.exe'] });
      expect(findDebugBinary(WS, winFs)).toBe(join(DEBUG_DIR, 'dummy.exe'));

      Object.defineProperty(process, 'platform', { value: 'linux' });
      const posixFs = fakeFs({}, { [DEBUG_DIR]: ['dummy'] });
      expect(findDebugBinary(WS, posixFs)).toBe(join(DEBUG_DIR, 'dummy'));

      // 修复前 CI 的确切失败形态：宿主 linux + 目录里只有 .exe → 取不到产物
      const linuxWithExeOnly = fakeFs(
        {},
        {
          [DEBUG_DIR]: ['dummy.exe', 'notes.txt'],
        },
      );
      expect(findDebugBinary(WS, linuxWithExeOnly)).toBeNull();
    } finally {
      Object.defineProperty(
        process,
        'platform',
        original as PropertyDescriptor,
      );
    }
  });

  it('findDebugBinary：读取失败按无产物处理', () => {
    const unreadable: DoctorFs = {
      existsSync: () => true,
      readFileSync: () => '',
      readdirSync: () => {
        throw new Error('EACCES');
      },
    };
    expect(findDebugBinary(WS, unreadable, 'win32')).toBeNull();
    expect(findDebugBinary(WS, unreadable, 'linux')).toBeNull();
  });
});

describe('doctor 探活', () => {
  it('probeInstances：活体与死实例分流，死实例不带原因细节', async () => {
    const live = fakeInstance({ pid: 100 });
    const dead = fakeInstance({ pid: 200 });
    const result = await probeInstances(
      [live, dead],
      (instance) => ({
        info: async () => {
          if (instance.pid === 200) throw new Error('http://127.0.0.1:51234/x');
          return { product_name: 'demo-app', version: '0.10.3' };
        },
        listTools: async () => [],
      }),
      2000,
    );
    expect(result.live.map((item) => item.pid)).toEqual([100]);
    expect(result.dead).toEqual([200]);
    // 输出里绝不能出现端口 URL / token
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    expect(JSON.stringify(result)).not.toContain('super-secret-token');
  });

  it('probeInstances：info 缺字段时回落 discovery 元数据', async () => {
    const result = await probeInstances(
      [fakeInstance({ productName: 'fallback-name', version: '9.9.9' })],
      () => ({
        info: async () => ({}),
        listTools: async () => [],
      }),
      2000,
    );
    expect(result.live[0]?.product_name).toBe('fallback-name');
    expect(result.live[0]?.version).toBe('9.9.9');
  });
});

describe('doctor 编排', () => {
  it('非 Tauri 工作区：workspace fail、其余实例类检查 skip、cli 仍执行', async () => {
    const result = await runDoctorChecks(join(process.cwd(), 'not-tauri'), {
      fs: fakeFs({}),
      scan: () => [fakeInstance()],
      probeCli: fakeCli('available'),
      cwd: process.cwd(),
    });
    const byId = new Map(result.checks.map((c) => [c.id, c]));
    expect(byId.get('workspace')?.status).toBe('fail');
    expect(byId.get('dependency')?.status).toBe('skip');
    expect(byId.get('live-instance')?.status).toBe('skip');
    expect(byId.get('tool-face')?.status).toBe('skip');
    expect(byId.get('debug-build')?.status).toBe('skip');
    // CLI 与工作区无关，始终执行
    expect(byId.get('cli')?.status).toBe('pass');
    expect(result.verdict).toBe('blocked');
    expect(result.is_tauri_project).toBe(false);
  });

  it('Tauri 项目但未接 victauri：dependency fail', async () => {
    const result = await runDoctorChecks(WS, {
      fs: fakeFs({
        [TAURI_CONF]: JSON.stringify({ product: 'demo' }),
        [CARGO]: '[dependencies]\ntauri = "2"\n',
      }),
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const dep = result.checks.find((c) => c.id === 'dependency');
    expect(dep?.status).toBe('fail');
    expect(dep?.message).toContain('victauri-plugin');
    expect(result.verdict).toBe('blocked');
  });

  it('discovery 无任何目录：live-instance warn（区分「无目录」与「全死」）', async () => {
    const result = await runDoctorChecks(WS, {
      fs: tauriFs(),
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const live = result.checks.find((c) => c.id === 'live-instance');
    expect(live?.status).toBe('warn');
    expect(live?.message).toContain('没有任何 victauri 实例记录');
  });

  it('discovery 有目录但全死：live-instance warn 且列出 pid', async () => {
    const result = await runDoctorChecks(WS, {
      fs: tauriFs(),
      scan: () => [fakeInstance({ pid: 111 }), fakeInstance({ pid: 222 })],
      createClient: () => ({
        info: async () => {
          throw new Error('connect refused http://127.0.0.1:1/');
        },
        listTools: async () => [],
      }),
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const live = result.checks.find((c) => c.id === 'live-instance');
    expect(live?.status).toBe('warn');
    expect(live?.message).toContain('111');
    expect(live?.message).toContain('222');
    // 不外泄端口 URL
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
  });

  it('有活体实例：live-instance pass + tool-face 参与比对', async () => {
    const result = await runDoctorChecks(WS, {
      fs: tauriFs(),
      scan: () => [fakeInstance({ pid: 777 })],
      createClient: () => ({
        info: async () => ({ product_name: 'demo-app', version: '0.10.3' }),
        listTools: async () => [
          { name: 'screenshot', description: '窗口截图' },
        ],
      }),
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const live = result.checks.find((c) => c.id === 'live-instance');
    expect(live?.status).toBe('pass');
    expect(live?.message).toContain('pid 777');
    // 服务端只给 1 个工具 → 与插件暴露面不一致 → tool-face warn
    const face = result.checks.find((c) => c.id === 'tool-face');
    expect(face?.status).toBe('warn');
    expect(face?.message).toContain('工具面存在差异');
    // 无 debug 产物 → warn
    const debug = result.checks.find((c) => c.id === 'debug-build');
    expect(debug?.status).toBe('warn');
  });

  it('CLI 不可用：cli warn 且带安装指引', async () => {
    const result = await runDoctorChecks(WS, {
      fs: tauriFs(),
      scan: () => [],
      probeCli: fakeCli('not_found'),
      cwd: WS,
    });
    const cli = result.checks.find((c) => c.id === 'cli');
    expect(cli?.status).toBe('warn');
    expect(cli?.message).toContain('victauri CLI 不可用');
  });

  it('CLI 探测抛错：折进 warn 而不是掀翻体检', async () => {
    const result = await runDoctorChecks(WS, {
      fs: tauriFs(),
      scan: () => [],
      probeCli: async () => {
        throw new Error('spawn failed');
      },
      cwd: WS,
    });
    const cli = result.checks.find((c) => c.id === 'cli');
    expect(cli?.status).toBe('warn');
    expect(cli?.message).toContain('CLI 探测失败');
  });

  it('scan 抛错：折成「无实例」而不是失败', async () => {
    const result = await runDoctorChecks(WS, {
      fs: tauriFs(),
      scan: () => {
        throw new Error('discovery 目录读不了');
      },
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const live = result.checks.find((c) => c.id === 'live-instance');
    expect(live?.status).toBe('warn');
  });
});

describe('doctor 工具', () => {
  it('工具名与参数面正确', () => {
    const tool = createVictauriDoctorTool();
    expect(tool.name).toBe(DOCTOR_TOOL_NAME);
    expect(tool.name).toBe('victauri_doctor');
    // defineTool 把 parameters 包装成 JSON Schema:{type:'object',properties:{...}}
    const schema = tool.parameters as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'identifier',
      'probe_timeout_ms',
      'workspace',
    ]);
    expect(DOCTOR_PROBE_TIMEOUT_MS).toBe(2000);
  });

  it('execute：返回结构化报告且永不抛错', async () => {
    const tool = createVictauriDoctorTool({
      fs: tauriFs(),
      scan: () => [],
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    const value = (await tool.execute(
      { workspace: WS },
      {} as never,
    )) as unknown as DoctorResult;
    expect(value.verdict).toBe('partial');
    expect(value.workspace).toBe(WS);
    expect(value.is_tauri_project).toBe(true);
    expect(value.checks.length).toBe(6);
    expect(value.summary).toContain('体检 6 项');
  });

  it('execute：identifier 入参透传到 scan', async () => {
    let seenIdentifier: string | undefined;
    const tool = createVictauriDoctorTool({
      fs: tauriFs(),
      scan: (options) => {
        seenIdentifier = options.identifier;
        return [];
      },
      probeCli: fakeCli('available'),
      cwd: WS,
    });
    await tool.execute(
      { workspace: WS, identifier: 'com.example.only' },
      {} as never,
    );
    expect(seenIdentifier).toBe('com.example.only');
  });

  it('execute：内部异常也不会抛给宿主（折成 fail 检查）', async () => {
    const tool = createVictauriDoctorTool({
      fs: {
        existsSync: () => {
          throw new Error('fs 炸了');
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
    expect(value.checks[0]?.status).toBe('fail');
    expect(value.checks[0]?.message).toContain('体检执行异常');
  });
});
