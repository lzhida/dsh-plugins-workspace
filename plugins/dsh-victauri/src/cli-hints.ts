/**
 * victauri CLI 子命令口径与**版本感知提示**（单一事实源）。
 *
 * 为什么要独立成文件：
 * - 原来 `CLI_ACTIONS`（src/cli.ts）与 `ACTION_HINTS`（src/tools/cli.ts）是两处
 *   手写清单，新增子命令必须改两处，enum 与提示容易漂移；
 * - 现在 `CLI_ACTION_SPECS` 是唯一来源：新增子命令只加一项，
 *   工具参数 enum、动作提示、版本门控说明同步生效（一致性由单测守护）；
 * - 提示按**探测到的 CLI 版本**门控：版本专属选项只对满足门槛的版本出现
 *   （如 tools/call 的 `--json` 需 ≥0.10.1），版本未知时一律不给版本门控文本
 *   （保守不外推）。`doctor` 的 `--json` 属**不存在的选项**（0.8.8 实测报
 *   unexpected argument，0.10.3 源码亦无），口径为无门控的恒定提示。
 */

import { isAtLeast, isBelow } from './cli-version.ts';

/** 版本门控提示：仅在探测版本落在 [since, until) 区间时出现。 */
export interface CliActionNote {
  /** 提示正文。 */
  readonly text: string;
  /** 生效的最低版本（含）；undefined = 不限。 */
  readonly since?: string;
  /** 失效的最高版本（不含）；undefined = 不限。 */
  readonly until?: string;
}

/** 子命令规格（语义 + 行为标记 + 版本门控提示）。 */
export interface CliActionSpec {
  /** 一句话语义（版本无关）。 */
  readonly summary: string;
  /** 该子命令出现的最低版本（含）；undefined = 0.8.8 起可用。 */
  readonly since?: string;
  /** 该子命令消失的最高版本（不含）；undefined = 一直可用。 */
  readonly until?: string;
  /** 长驻子命令：不自行退出，必须配合 timeout_ms。 */
  readonly longRunning?: boolean;
  /**
   * 「部分模式才长驻」的补充说明（如 `logs` 仅 `--follow` 长驻）。
   *
   * `longRunning` 是静态布尔，描述不了按选项才长驻的子命令；
   * 这类子命令保持 `longRunning` 不开，另用本字段把「哪种用法长驻」写进提示。
   */
  readonly longRunningNote?: string;
  /** 是否支持交互式 stdin；false = 非交互（等退出模型下拿不到交互通道）。 */
  readonly interactive?: boolean;
  /** 版本门控提示。 */
  readonly notes?: readonly CliActionNote[];
}

/**
 * 子命令规格表（唯一事实源）。
 *
 * 键顺序 = `CLI_ACTIONS` 顺序：对齐上游 0.10.3 的 `victauri --help` 子命令顺序
 * （Init, Setup, Check, Test, Record, Doctor, Watch, Invoke, Tools, Call, Bridge,
 * Coverage, Run, Logs）；本机 0.8.8 实测是它的子集（无 setup/tools/call/run/logs，
 * 且 invoke 仍在）。
 *
 * 有意不接的上游子命令：
 * - `setup`（上游 0.10.0 新增）：只写 agent 客户端接入指令，`init` 已覆盖首次接入；
 *   需要时按上游 `victauri setup --help` 手工执行。
 * - clap 内置 `help`：不是可路由的 action。
 *
 * 新增子命令：在此加一项即可（enum / 提示 / 文档口径同步生效）。
 */
const SPEC_TABLE = {
  init: {
    summary:
      '为 Tauri 项目生成 victauri 接入脚手架(Cargo 依赖/capability/init 调用)',
  },
  check: {
    summary: '校验项目接入配置完整性(Cargo.toml/capability/register_commands)',
  },
  test: {
    summary: '在真实 app 上跑 victauri 测试集',
    notes: [{ text: '可能耗时较长,建议显式传 timeout_ms' }],
  },
  record: {
    summary: '录制会话轨迹供回放',
    notes: [{ text: '可能耗时较长,建议显式传 timeout_ms' }],
  },
  doctor: {
    summary: '诊断 CLI/服务/发现链路健康状态',
    notes: [
      {
        // D-5 口径修正:上游 v0.10.3 main.rs 的 doctor 子命令只有 AppTarget(--app),
        // 未见 --json;0.8.8 实测报 unexpected argument。旧文案「0.10.0 起的文档才
        // 提供」与上游源码不符,已废弃。该 note 无版本门控(任何版本下都成立)。
        text:
          'doctor 不提供 --json 结构化输出:0.8.8 实测报 unexpected argument,' +
          '上游 0.10.3 CLI 源码亦未见该选项;结构化明细以本工具输出的 doctor 字段为准',
      },
    ],
  },
  watch: {
    summary:
      '监视测试目录变化(仅 .rs 文件触发)并重跑 cargo test(-d/--dir 默认 tests,-f/--filter 只跑匹配用例)',
    longRunning: true,
    interactive: false,
    notes: [
      {
        text:
          '上游 watch 语义=递归监视测试目录的文件变化(仅 .rs 变化触发,启动即先跑一轮)' +
          '并重跑 cargo test:-d/--dir 指定被监视目录(默认 tests),-f/--filter 只跑匹配的测试;' +
          '目录须落在含 Cargo.toml 的 Rust 测试工程里(用 cwd 指定工程根);' +
          '目录不存在时上游自身报 watch directory does not exist',
      },
      {
        text:
          '输出是人类向 ANSI 终端文本(banner 与摘要走 stderr);' +
          '上游不提供 JSON 结构化输出,也没有 --once(跑一次即退)/--follow(跟随逐轮)模式',
      },
      {
        text:
          '长驻子命令:不会自行退出,必须传 timeout_ms;超时会 kill 子进程并返回 ' +
          'timed_out=true、partial=true,stdout/stderr 为已捕获的部分输出',
      },
      {
        text:
          '本通道是 spawn-等退出模型:只能在超时后拿到一次部分输出,拿不到逐轮增量;' +
          '多轮效果≈重复执行项目自身的 cargo test(用 cwd 指定工程根);' +
          'test/coverage 是跑在活体 app 上的另一套(内置冒烟套件/IPC 覆盖报告),' +
          '不能替代 watch 的重跑',
      },
    ],
  },
  invoke: {
    summary:
      '不依赖 dsh 直接触发一次 app 的 Tauri IPC 命令(invoke <command> [--args JSON])',
    notes: [
      { text: '需要 app 在运行;app 未起时调用会失败' },
      {
        text:
          '上游 0.10.1 起 call 是更通用的入口(可调全部工具);' +
          '0.10.3 仍保留 invoke(两者并存),故本通道不按版本禁用 invoke',
        since: '0.10.1',
      },
      {
        text:
          '上游 invoke 走同一 discovery、信任检查与 --app pin;' +
          '不接受 port/URL/token 参数,永不打印 token',
      },
    ],
  },
  tools: {
    summary:
      '列出 victauri 工具与其参数(victauri tools 每工具一行,victauri tools <tool> 看单个工具)',
    since: '0.10.1',
    notes: [
      {
        text:
          '上游 0.10.1 起提供:从活体 app 的 input schema 列出工具;' +
          'victauri tools --json 输出 MCP 工具对象与 input schema',
        since: '0.10.1',
      },
      {
        text: '无 app 可达时只列内置工具名与描述(参数 schema 来自运行中的 app,拿不到)',
        since: '0.10.1',
      },
      {
        text: '本插件已有 victauri_tools_list 工具做同类事(走 REST 主通道,不受 CLI 版本限制)',
        since: '0.10.1',
      },
    ],
  },
  call: {
    summary:
      '不依赖 dsh 直接触发一次工具调用(key=value / key:=json / --args-file 传参,图像用 --out 落盘)',
    since: '0.10.1',
    notes: [
      {
        text:
          '上游 0.10.1 起提供:比 invoke 更通用——invoke 只触发 app 的 Tauri IPC 命令,' +
          'call 可调全部工具',
        since: '0.10.1',
      },
      {
        text:
          '传参四种形式:key=value(字符串)/ key:=json(任意 JSON 值)/ 首个参数为 JSON 对象 / ' +
          '--args-file <path|->(- 读 stdin;Windows PowerShell 下推荐 --args-file)',
        since: '0.10.1',
      },
      {
        text:
          '图像结果(screenshot/animation scrub/trace frames)用 --out 保存(绝不打印 base64,' +
          '多张图编号 <stem>-1.<ext>)',
        since: '0.10.1',
      },
      {
        text:
          '退出码:0 成功 / 1 工具报错或 app 拒绝(stdout 上 {"error": …}) / ' +
          '2 本地问题(参数错、无 app 可达——什么都没发出、或 --out/stdout 写不了——但工具确实跑了) / ' +
          '3 请求已发出但未完成(超时、连接丢失;工具可能已跑,勿盲目重试)',
        since: '0.10.1',
      },
      {
        text:
          '与 invoke 同 discovery、信任检查、--app pin 与 token;不接受 port/URL/token 参数,' +
          '永不打印 token',
        since: '0.10.1',
      },
    ],
  },
  bridge: {
    summary: '启动 stdio MCP 代理(连接时自动发现端口+读 token,--app 过滤)',
    longRunning: true,
    interactive: false,
    notes: [
      {
        text:
          '上游定位:给只会说 stdio 的第三方 MCP 宿主用的 stdio→HTTP 代理' +
          '(Claude Code 等;本机 0.8.8 实测 bridge --help 首行,0.10.x 文档同口径);' +
          '上游 CLI 不提供 --http/--port 等服务端选项,' +
          'HTTP/MCP 端点实际运行在 victauri app 进程内(/mcp、/api/tools、' +
          '/info、/health)',
      },
      {
        text:
          '本插件已有 REST 主通道(victauri_* 工具)直连同一 app 的同一套工具,' +
          '工具调用勿绕道 bridge;bridge 在本通道仅适合诊断性短时使用' +
          '(如确认握手输出)',
      },
      {
        text:
          '长驻子命令:不会自行退出,必须传 timeout_ms;超时会 kill 子进程并返回 ' +
          'timed_out=true、partial=true,stdout/stderr 为超时前已捕获的部分输出;' +
          'partial 还有第二个来源:单路输出超 512KB 捕获上限(软上限)会被追加 ' +
          '[truncated] 标记,partial 按该字面量判定(命令自身打印同名文本会假阳性)',
      },
      {
        text:
          'bridge 是 stdio MCP 代理,本通道(spawn-等退出模型)只能等它退出,' +
          '拿不到 stdio 交互会话;跨 app 重启自动重发现并重建后端会话的能力' +
          '由上游 CLI 侧的长驻 bridge 进程在内部完成,' +
          '本通道因 spawn-等退出模型观察不到这个重建过程' +
          '(上游 app 侧会话 id 随 app 重启即失效)',
      },
    ],
  },
  coverage: {
    summary: '报告 #[inspectable] 命令的工具覆盖情况',
  },
  run: {
    summary:
      '带捕获启动 Tauri app(victauri run -- <cmd>,捕获 stdout/stderr 与退出记录)',
    since: '0.10.2',
    longRunning: true,
    interactive: false,
    notes: [
      {
        text:
          '上游 0.10.2 起提供:命令写在 -- 之后(如 victauri run -- npm run tauri dev);' +
          '--capture 指定捕获文件路径,不指定则落私有 per-user 目录 console/<pid>-<ms>.jsonl',
        since: '0.10.2',
      },
      {
        text:
          '捕获逐字节透传到终端并同时写 JSONL(记录时间/流/行);末条记录 app 如何退出' +
          '(退出码/信号/NTSTATUS 解码)',
        since: '0.10.2',
      },
      {
        text: 'app 内嵌插件经 logs{action:"stdout"} 读同一份捕获文件,app 死后也能读',
        since: '0.10.2',
      },
      {
        text:
          '长驻子命令:不会自行退出,必须传 timeout_ms;本通道是 spawn-等退出模型,' +
          '只能在超时后拿到一次部分输出,拿不到实时增量',
        since: '0.10.2',
      },
      {
        text:
          '停止 launcher 会带走 app(Windows job object / Unix 停止信号转发 + DeathWatch 辅助进程);' +
          '被强杀的 launcher 不写退出记录,victauri logs 会报 launcher_gone',
        since: '0.10.2',
      },
    ],
  },
  logs: {
    summary: 'CLI 侧查看或跟随后端日志(victauri logs;--follow 逐行跟随)',
    since: '0.10.2',
    longRunningNote:
      '仅 --follow 是长驻用法(逐行跟随新行,不会自行退出,须传 timeout_ms);' +
      '不带 --follow 时打印最近若干行即退出',
    notes: [
      {
        text:
          '上游 0.10.2 起提供:选项 --app/--level/--target/--grep/--limit(默认 100)/' +
          '--follow/--digest/--stdout/--capture/--json/--interval-ms(默认 500)',
        since: '0.10.2',
      },
      {
        text: 'app 未运行时回落最近一次 victauri run 的捕获文件',
        since: '0.10.2',
      },
      {
        text:
          '选项互斥:--target 与 --stdout/--capture/--digest 互斥;' +
          '--digest 与 --follow/--stdout/--capture/--grep/--level 互斥;' +
          '--app 与 --stdout/--capture 互斥',
        since: '0.10.2',
      },
      {
        text:
          '上游 logs 也提供 --json(输出原始 JSON records,不是格式化行);' +
          '与插件 logs{action:"backend"} 同源但面向 CLI 侧;' +
          '需要 --follow 这类长驻跟随才用本子命令',
        since: '0.10.2',
      },
    ],
  },
} as const satisfies Record<string, CliActionSpec>;

/** 子命令名（由规格表推导，新增子命令自动进入联合类型）。 */
export type CliAction = keyof typeof SPEC_TABLE;

/** 子命令规格表（对外只读视图，键与 `CLI_ACTIONS` 一致）。 */
export const CLI_ACTION_SPECS: Record<CliAction, CliActionSpec> = SPEC_TABLE;

/** 子命令清单（顺序 = 规格表键顺序）。 */
export const CLI_ACTIONS = Object.keys(SPEC_TABLE) as CliAction[];

/** 版本感知的子命令提示。 */
export interface CliActionHint {
  /** 一句话语义（含长驻/交互行为标记）。 */
  readonly summary: string;
  /** 版本门控提示正文（按探测版本过滤后）。 */
  readonly notes: string[];
  /** 是否长驻子命令（必须配合 timeout_ms）。 */
  readonly longRunning: boolean;
  /** 是否支持交互式 stdin。 */
  readonly interactive: boolean;
}

/**
 * 版本是否已越过某子命令的 `until` 门槛（上游在该版本起移除/替换该子命令）。
 *
 * 版本未知/不可解析一律 false——门控提示宁可不给，也不外推。
 *
 * @param spec - 子命令规格。
 * @param version - 探测到的 CLI 版本；null = 未知。
 */
export function isBeyondUntil(
  spec: CliActionSpec,
  version: string | null,
): boolean {
  if (spec.until === undefined || version === null) return false;
  return !isBelow(version, spec.until);
}

/**
 * 构建单个子命令的版本感知提示。
 *
 * @param action - 子命令名。
 * @param version - 探测到的 CLI 版本；null = 未知（不给版本门控文本）。
 */
export function buildActionHint(
  action: CliAction,
  version: string | null,
): CliActionHint {
  const spec = CLI_ACTION_SPECS[action];
  const notes: string[] = [];
  const summaryParts: string[] = [spec.summary];
  if (spec.longRunning === true) {
    summaryParts.push('长驻子命令(不自行退出,必须配合 timeout_ms)');
  }
  if (spec.interactive === false) {
    summaryParts.push('不支持交互式 stdin');
  }
  if (
    spec.since !== undefined &&
    version !== null &&
    !isAtLeast(version, spec.since)
  ) {
    notes.push(`当前 CLI 版本 ${version} 不支持该子命令(需 >= ${spec.since})`);
  }
  if (isBeyondUntil(spec, version)) {
    notes.push(`上游 ${spec.until} 起不再提供该子命令`);
  }
  // 「部分模式才长驻」的说明：仅在该子命令本身可用时给出（不可用时先看上面的版本门控）。
  // 版本未知时同样不给（与 notes 的 isAtLeast 门控保持同一套标准，保守不外推）。
  if (
    spec.longRunningNote !== undefined &&
    (spec.since === undefined || isAtLeast(version, spec.since))
  ) {
    notes.push(spec.longRunningNote);
  }
  for (const note of spec.notes ?? []) {
    if (note.since !== undefined && !isAtLeast(version, note.since)) continue;
    if (note.until !== undefined && !isBelow(version, note.until)) continue;
    notes.push(note.text);
  }
  return {
    summary: summaryParts.join(';'),
    notes,
    longRunning: spec.longRunning ?? false,
    interactive: spec.interactive ?? true,
  };
}

/**
 * 构建全部子命令的版本感知提示。
 *
 * @param version - 探测到的 CLI 版本；null = 未知。
 */
export function buildActionHints(
  version: string | null,
): Record<CliAction, CliActionHint> {
  const hints = {} as Record<CliAction, CliActionHint>;
  for (const action of CLI_ACTIONS) {
    hints[action] = buildActionHint(action, version);
  }
  return hints;
}

/**
 * 工具描述文案。
 *
 * 说明：描述里给出**子命令语义 + 显式版本门槛**（子命令摘要 + timeout_ms/cwd 要求 +
 * 结构化输出说明）；某子命令在当前 CLI 上是否可用、以及它有哪些专属参数，随执行结果里的
 * `hints` 字段返回——那时已经探测到真实版本，避免在描述里写死某个版本才成立的用法。
 * 摘要里出现的版本专属语法（--args-file / --out / --follow 等）必须同时写明版本门槛。
 *
 * @param version - 已知版本（测试/调用方注入）；null = 未知（描述不含版本门控文本）。
 */
export function buildCliToolDescription(version: string | null): string {
  const actions = CLI_ACTIONS.map(
    (action) => `${action}=${buildActionHint(action, version).summary}`,
  ).join('; ');
  return [
    '执行 victauri CLI 子命令(辅通道;victauri 服务经 victauri_* 工具走 REST 主通道)。',
    `action 选择子命令:${actions}。`,
    '子命令版本门槛:tools/call 需 CLI >= 0.10.1,run/logs 需 >= 0.10.2;' +
      '摘要里的版本专属参数(--args-file/--out/--follow 等)在旧 CLI 上不存在,' +
      '是否可用以执行结果的 hints 为准(本机 0.8.8 只有 ' +
      'init/check/test/record/doctor/watch/invoke/bridge/coverage)。',
    'args 透传给子命令(不含子命令名本身)。',
    'doctor 会输出文本报告;本工具另外把 PASS/FAIL/WARN 明细解析到输出结构的 doctor 字段' +
      '(依次解析 stdout 与 stderr;识别不到报告时 doctor=null,stdout/stderr 原样保留)。',
    'doctor 需在 Tauri 项目根(含 Cargo.toml)执行,否则报告全 FAIL;用 cwd 指定项目根。',
    '长驻子命令(watch/bridge/run,以及 logs 的 --follow 模式)不会自行退出,必须传 timeout_ms;' +
      '超时会 kill 子进程,返回 timed_out=true、partial=true,stdout/stderr 为已捕获的部分输出。',
    'partial 还有第二个来源:单路输出超 512KB 捕获上限(软上限)会追加 [truncated] 标记,' +
      'partial 按该字面量判定;模型侧预览再按头 3000+尾 3000 截断(另含一行省略标记),' +
      '截断前的完整输出仍在返回字段里。',
    '输出含 cli_version(探测到的 CLI 版本)与 hints(该子命令的版本感知提示)。',
  ].join(' ');
}
