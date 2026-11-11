/**
 * 包级契约测试：四批工具（standalone 20 + compound 15 + CLI 桥 1 + CLI 探测 1
 * + 工具发现 1 + 桥接体检 1 = 39）的名字唯一性、前缀统一、数量口径与复合工具 action 结构。
 *
 * 口径四处一致：本文件 = README「工具清单」= docs/TOOLS.md = catalog 头注释。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TOTAL_TOOL_COUNT } from '../index.ts';
import { victauriCliTool } from './cli.ts';
import { victauriCliStatusTool } from './cli-status.ts';
import {
  COMPOUND_TOOL_SPECS,
  COMPOUND_TOOL_COUNT,
  compoundActionOf,
} from './compound/catalog.ts';
import { createCompoundTools } from './compound/bridge.ts';
import {
  ARRAY_RESULT_NOTE,
  REST_TOOL_SPECS,
  STANDALONE_TOOL_COUNT,
} from './standalone/catalog.ts';
import { createStandaloneTools } from './standalone/bridge.ts';
import { createVictauriDoctorTool } from './doctor.ts';
import { TOOLS_LIST_TOOL_NAME, createToolsListTool } from './tools-list.ts';

describe('dsh-victauri 工具面契约', () => {
  it('数量口径:standalone 20 + compound 15 + CLI 1 + CLI 探测 1 + 工具发现 1 + 桥接体检 1 = 39,与 README/docs/catalog 一致', () => {
    expect(STANDALONE_TOOL_COUNT).toBe(20);
    expect(COMPOUND_TOOL_COUNT).toBe(15);
    expect(STANDALONE_TOOL_COUNT + COMPOUND_TOOL_COUNT).toBe(35);
    expect(STANDALONE_TOOL_COUNT + COMPOUND_TOOL_COUNT + 4).toBe(39);
    expect(REST_TOOL_SPECS).toHaveLength(STANDALONE_TOOL_COUNT);
    expect(COMPOUND_TOOL_SPECS).toHaveLength(COMPOUND_TOOL_COUNT);
  });

  it('39 个 dsh 工具名全局唯一且统一 victauri_ 前缀', () => {
    const standalone = createStandaloneTools(REST_TOOL_SPECS, {
      getClient: null as never,
    });
    const compound = createCompoundTools({ getClient: null as never });
    const names = [
      ...standalone.map((t) => t.name),
      ...compound.map((t) => t.name),
      victauriCliTool.name,
      victauriCliStatusTool.name,
      createToolsListTool({ getClient: null as never }).name,
      createVictauriDoctorTool().name,
    ];
    expect(names).toHaveLength(39);
    expect(new Set(names).size).toBe(39);
    for (const name of names) {
      expect(name.startsWith('victauri_'), name).toBe(true);
    }
  });

  it('工具面为静态注册:装配入口按固定清单注册,TOTAL_TOOL_COUNT 与实际装配数一致', () => {
    // 装配清单 = REST 桥 20 + compound 桥 15 + CLI 桥 1 + CLI 探测 1 + 工具发现 1
    //          + 桥接体检 1
    expect(TOTAL_TOOL_COUNT).toBe(39);
    expect(TOTAL_TOOL_COUNT).toBe(
      REST_TOOL_SPECS.length + COMPOUND_TOOL_SPECS.length + 4,
    );
    // 工具发现工具不映射服务端工具面,故不进 REST/compound 目录(无动态注册入口)
    expect(REST_TOOL_SPECS.map((spec) => spec.name)).not.toContain(
      'tools_list',
    );
    expect(COMPOUND_TOOL_SPECS.map((spec) => spec.name)).not.toContain(
      'tools_list',
    );
    expect(TOOLS_LIST_TOOL_NAME).toBe('victauri_tools_list');
  });

  it('compound 每个工具的 action 为必填 enum 且枚举值唯一、与文档子动作一致', () => {
    const EXPECTED_ACTIONS: Record<string, readonly string[]> = {
      // 0.10.3 基线三动作：clear 已废弃（0.8.8 有、0.10.x 移除，清空改经 sample 的 clear:true）
      animation: ['list', 'scrub', 'sample'],
      css: ['inject', 'remove'],
      explain: ['summary', 'last_action', 'diff'],
      fault: ['inject', 'list', 'clear', 'clear_all'],
      input: ['fill', 'type_text', 'press_key'],
      inspect: [
        'get_styles',
        'get_bounding_boxes',
        'highlight',
        'clear_highlights',
        'audit_accessibility',
        'get_performance',
      ],
      interact: [
        'click',
        'double_click',
        'hover',
        'focus',
        'scroll_into_view',
        'select_option',
      ],
      introspect: [
        'command_timings',
        'coverage',
        'command_catalog',
        'contract_record',
        'contract_check',
        'contract_list',
        'contract_clear',
        'startup_timing',
        'capabilities',
        'db_health',
        'plugin_state',
        'processes',
        'plugin_tasks',
        'event_bus',
        'event_bus_clear',
      ],
      logs: [
        'console',
        'network',
        'ipc',
        'navigation',
        'dialogs',
        'events',
        'slow_ipc',
        'clear',
        'backend',
        'backend_digest',
        'stdout',
      ],
      navigate: [
        'go_to',
        'go_back',
        'get_history',
        'set_dialog_response',
        'get_dialog_log',
      ],
      recording: [
        'start',
        'stop',
        'checkpoint',
        'list_checkpoints',
        'get_events',
        'events_between',
        'get_replay',
        'export',
        'import',
        'replay',
        'flush',
      ],
      route: ['add', 'list', 'clear', 'clear_all', 'matches'],
      storage: ['get', 'set', 'delete', 'get_cookies'],
      trace: ['start', 'stop', 'status', 'frames'],
      window: [
        'get_state',
        'list',
        'manage',
        'resize',
        'move_to',
        'set_title',
        'introspectability',
      ],
    };
    expect(Object.keys(EXPECTED_ACTIONS)).toHaveLength(COMPOUND_TOOL_COUNT);
    for (const spec of COMPOUND_TOOL_SPECS) {
      const action = spec.parameters['action'] as {
        required?: boolean;
        enum?: string[];
      };
      expect(action?.required, `${spec.name}.action.required`).toBe(true);
      expect(action?.enum, `${spec.name}.action.enum`).toEqual(
        EXPECTED_ACTIONS[spec.name],
      );
      expect(new Set(compoundActionOf(spec)).size).toBe(
        compoundActionOf(spec).length,
      );
    }
  });

  it('compound 的 explain/fault 暴露 webview_label 参数且标注服务端版本口径', () => {
    // ParameterPropertySpec 是联合类型，这里只取字符串型节点的 type/description
    const prop = (
      spec: (typeof COMPOUND_TOOL_SPECS)[number],
      name: string,
    ): { type?: string; description?: string } | undefined =>
      spec.parameters[name] as
        { type?: string; description?: string } | undefined;

    const explain = COMPOUND_TOOL_SPECS.find((s) => s.name === 'explain');
    const fault = COMPOUND_TOOL_SPECS.find((s) => s.name === 'fault');
    // explain：服务端 0.10.2 起支持（ExplainParams.webview_label，别名 window）
    expect(prop(explain!, 'webview_label')?.type).toBe('string');
    expect(prop(explain!, 'webview_label')?.description).toContain('0.10.2');
    // fault：0.10.x fallback schema 口径含该字段，但服务端 FaultParams 未定义
    expect(prop(fault!, 'webview_label')?.type).toBe('string');
    expect(prop(fault!, 'webview_label')?.description).toContain('FaultParams');
    // 其余 compound 工具的 webview_label 口径不变（通用说明文案）
    for (const spec of COMPOUND_TOOL_SPECS) {
      if (spec.name === 'explain' || spec.name === 'fault') {
        continue;
      }
      const label = prop(spec, 'webview_label');
      if (label === undefined) {
        continue;
      }
      expect(label.description, `${spec.name}.webview_label`).toContain(
        '目标 webview 标签',
      );
    }
  });

  it('animation 的参数集合与 Rust AnimationParams 1:1（无 limit），trace 的 limit 保留', () => {
    const animation = COMPOUND_TOOL_SPECS.find((s) => s.name === 'animation');
    const trace = COMPOUND_TOOL_SPECS.find((s) => s.name === 'trace');
    // Rust 0.10.2 / 0.8.8 的 AnimationParams 字段集合（不含 limit）
    const RUST_ANIMATION_PARAMS = [
      'action',
      'capture',
      'clear',
      'cols',
      'points',
      'record',
      'restore',
      'selector',
      'webview_label',
    ];
    expect(Object.keys(animation!.parameters).sort()).toEqual(
      [...RUST_ANIMATION_PARAMS].sort(),
    );
    // limit 属 trace.frames 语义，animation 不得再带（批四 2/6 移除）
    expect(animation!.parameters).not.toHaveProperty('limit');
    // 合法 limit 不受影响
    expect(trace!.parameters).toHaveProperty('limit');
  });

  it('图像类工具描述告知落盘与查看方式（批七 1/1：read_image/present）', () => {
    const screenshot = REST_TOOL_SPECS.find((s) => s.name === 'screenshot');
    const animation = COMPOUND_TOOL_SPECS.find((s) => s.name === 'animation');
    const trace = COMPOUND_TOOL_SPECS.find((s) => s.name === 'trace');
    for (const spec of [screenshot, animation, trace]) {
      expect(spec!.description, `${spec!.name} 落盘路径`).toContain(
        '%TEMP%\\dsh-victauri\\',
      );
      expect(spec!.description, `${spec!.name} read_image 提示`).toContain(
        'read_image',
      );
      expect(spec!.description, `${spec!.name} present 提示`).toContain(
        'present',
      );
    }
  });

  it('standalone 0.10.3 对齐:invoke_command/wait_for/find_elements 新增参数齐备、可选且带来源标注', () => {
    const specOf = (name: string) =>
      REST_TOOL_SPECS.find((spec) => spec.name === name)!;
    const propOf = (name: string, key: string) =>
      specOf(name).parameters[key] as
        | {
            type?: string;
            description?: string;
            required?: true;
            enum?: readonly string[];
          }
        | undefined;

    // invoke_command:timeout_ms(0.9.0 引入,0.10.3 文档仍收录)+with_logs(0.10.2)
    expect(propOf('invoke_command', 'timeout_ms')?.type).toBe('integer');
    expect(propOf('invoke_command', 'with_logs')?.type).toBe('boolean');
    // wait_for:condition 枚举补 log + level/fields/since_seq(0.10.2)。
    // 这是「闭集契约」tripwire：上游 0.10.4+ 新增条件时本断言会红，提示同步插件
    // 枚举——它锁的是本插件与 0.10.3 口径的一致性，不是上游快照。
    expect(propOf('wait_for', 'condition')?.enum).toEqual([
      'text',
      'text_gone',
      'selector',
      'selector_gone',
      'url',
      'ipc_idle',
      'network_idle',
      'expression',
      'event',
      'log',
    ]);
    expect(propOf('wait_for', 'level')?.type).toBe('string');
    expect(propOf('wait_for', 'fields')?.type).toBe('object');
    expect(propOf('wait_for', 'since_seq')?.type).toBe('integer');
    // find_elements:title_attr(0.10.3 文档)+attribute/attribute_value/text_exact/include_hidden(CHANGELOG)
    for (const key of [
      'title_attr',
      'attribute',
      'attribute_value',
      'text_exact',
      'include_hidden',
    ]) {
      expect(propOf('find_elements', key), key).toBeDefined();
    }
    expect(propOf('find_elements', 'text_exact')?.type).toBe('boolean');
    expect(propOf('find_elements', 'include_hidden')?.type).toBe('boolean');

    // 新增参数全部可选(透传型,不得标 required)且来源标注精确到版本源
    // (T-2 三元组:[工具,参数,期望标注]——防「CHANGELOG 项误标成 [实测]」这类漂移)
    const NEW_PARAMS: readonly (readonly [string, string, string])[] = [
      ['invoke_command', 'timeout_ms', '[文档 0.10.3]'],
      ['invoke_command', 'with_logs', '[文档 0.10.3]'],
      ['wait_for', 'level', '[文档 0.10.3]'],
      ['wait_for', 'fields', '[文档 0.10.3]'],
      ['wait_for', 'since_seq', '[文档 0.10.3]'],
      ['find_elements', 'title_attr', '[文档 0.10.3]'],
      ['find_elements', 'attribute', '[CHANGELOG 0.10.3]'],
      ['find_elements', 'attribute_value', '[CHANGELOG 0.10.3]'],
      ['find_elements', 'text_exact', '[CHANGELOG 0.10.3]'],
      ['find_elements', 'include_hidden', '[CHANGELOG 0.10.3]'],
    ];
    for (const [tool, key, tag] of NEW_PARAMS) {
      const prop = propOf(tool, key);
      expect(prop, `${tool}.${key}`).toBeDefined();
      expect(prop?.required, `${tool}.${key}.required`).toBeUndefined();
      expect(prop?.description, `${tool}.${key} 来源标注`).toContain(tag);
    }

    // 后端日志三段式套路与捕获量旋钮落在 invoke_command / wait_for 描述里
    for (const tool of ['invoke_command', 'wait_for']) {
      const desc = specOf(tool).description;
      expect(desc, tool).toContain('backend_log_cursor');
      expect(desc, tool).toContain('VICTAURI_LOG_LEVEL');
      expect(desc, tool).toContain('VICTAURI_LOG_CAPACITY');
    }
    // wait_for.condition 仍是必填（0.8.8 实测 missing field `condition`）
    expect(propOf('wait_for', 'condition')?.required).toBe(true);
  });

  it('批八 2/4 schema 收尾:verify_state backend_args、animation 3 值、别名标注（eval_js [桥] / query_db.sql [源码]）', () => {
    const specOf = (name: string, specs = REST_TOOL_SPECS) =>
      specs.find((spec) => spec.name === name)!;
    const propOf = (name: string, key: string) =>
      specOf(name).parameters[key] as
        { type?: string; description?: string; required?: true } | undefined;

    // P1-1 verify_state 补 backend_args（上游 verification_params.rs:16 Option<Value>）
    const backendArgs = propOf('verify_state', 'backend_args');
    expect(backendArgs).toBeDefined();
    expect(backendArgs?.type).toBe('object');
    expect(backendArgs?.required).toBeUndefined();
    expect(backendArgs?.description).toMatch(/\[文档/);
    expect(specOf('verify_state').description).toContain('backend_args');

    // P2-4 eval_js.expression：上游 webview_params.rs 只有 code，别名是插件自有 → [桥]
    expect(propOf('eval_js', 'expression')?.description).toMatch(/\[桥/);
    expect(propOf('eval_js', 'expression')?.description).not.toMatch(/\[文档/);
    // P2-5 query_db.sql：上游 0.10.2 backend_params.rs:130 / 0.8.8 :117 是正式 serde alias → [源码]
    // （批十 1/2 勘误：此前写成「插件自有 [桥]」是事实错误）
    expect(propOf('query_db', 'sql')?.description).toMatch(/\[源码/);
    expect(propOf('query_db', 'sql')?.description).not.toMatch(/\[桥/);

    // P1-2 animation.action 移除已废弃 clear（0.10.3 基线三动作）+ 0.8.8 兼容口径
    const animation = specOf('animation', COMPOUND_TOOL_SPECS);
    expect(
      (animation.parameters['action'] as { enum?: readonly string[] }).enum,
    ).toEqual(['list', 'scrub', 'sample']);
    expect(animation.description).toContain('0.8.8');
    expect(animation.description).toContain('clear:true');
    // animation 的参数集合不变（clear 参数是 sample 的清空开关，与 action=clear 无关）
    expect(animation.parameters).toHaveProperty('clear');
  });

  it('compound 0.10.3 对齐:logs/window 新动作与参数齐备，route/recording/storage 口径同步', () => {
    const specOf = (name: string) =>
      COMPOUND_TOOL_SPECS.find((spec) => spec.name === name)!;
    const propOf = (name: string, key: string) =>
      specOf(name).parameters[key] as
        | {
            type?: string;
            description?: string;
            required?: true;
            enum?: readonly string[];
          }
        | undefined;

    // logs：0.10.2 起新增 backend/backend_digest/stdout 三个动作
    expect(compoundActionOf(specOf('logs'))).toContain('backend');
    expect(compoundActionOf(specOf('logs'))).toContain('backend_digest');
    expect(compoundActionOf(specOf('logs'))).toContain('stdout');
    // logs：参数全集精确锁定（新增 action 不应顺带引入未登记的参数）
    expect(Object.keys(specOf('logs').parameters).sort()).toEqual([
      'action',
      'bodies',
      'fields',
      'filter',
      'level',
      'limit',
      'since',
      'since_seq',
      'target',
      'threshold_ms',
      'wait_for_capture',
      'webview_label',
    ]);
    // logs：新增参数全部可选（透传型）且带类型
    for (const key of ['bodies', 'level', 'target', 'fields', 'since_seq']) {
      const prop = propOf('logs', key);
      expect(prop, `logs.${key}`).toBeDefined();
      expect(prop?.required, `logs.${key}.required`).toBeUndefined();
    }
    expect(propOf('logs', 'bodies')?.type).toBe('boolean');
    expect(propOf('logs', 'level')?.type).toBe('string');
    expect(propOf('logs', 'target')?.type).toBe('string');
    expect(propOf('logs', 'fields')?.type).toBe('object');
    expect(propOf('logs', 'since_seq')?.type).toBe('integer');
    // logs：新增参数须带来源标注（level/target/since_seq/fields 自 0.10.2，bodies 自 0.10.3）
    for (const key of ['bodies', 'level', 'target', 'fields', 'since_seq']) {
      expect(
        propOf('logs', key)?.description,
        `logs.${key}.description`,
      ).toMatch(/\[(文档|源码)/);
    }
    expect(propOf('logs', 'bodies')?.description).toContain('0.10.3');
    for (const key of ['level', 'target', 'fields', 'since_seq']) {
      expect(
        propOf('logs', key)?.description,
        `logs.${key}.description`,
      ).toContain('0.10.2 起');
    }
    // logs：描述须写明游标分页语义与 stdout 游标不透明/gap
    const logsDesc = specOf('logs').description;
    expect(logsDesc).toContain('next_seq');
    expect(logsDesc).toContain('gap:true');
    expect(logsDesc).toContain('backend_digest');
    expect(logsDesc).toMatch(/带 since_seq 的读取返回游标之后最旧的条目/);
    expect(logsDesc).toContain('next_seq 不透明');
    expect(logsDesc).toMatch(/gap:true 表示[^。]*轮转/);
    // logs：捕获门槛须写明（装 log_layer/log_logger/wrap_logger 之一）
    expect(logsDesc).toContain('log_layer');
    expect(logsDesc).toContain('wrap_logger');
    // logs：版本口径须区分「0.10.2 已有」与「0.8.8 无」
    expect(logsDesc).toContain(
      '0.8.8 的 LogsParams 无 level/target/since_seq/fields/bodies',
    );
    expect(logsDesc).not.toMatch(/0\.8\.8 与 0\.10\.2 的 LogsParams 无/);
    expect(logsDesc).toContain('0.10.2 起已含 level/target/since_seq/fields');
    // logs：须说明「新增动作报错 / 新增参数静默忽略」两类兼容性差异
    expect(logsDesc).toMatch(/新增动作[^。]*报错/);
    expect(logsDesc).toMatch(/新增参数[^。]*静默忽略/);

    // window：0.8.8/0.10.2 源码均已含 introspectability 动作
    expect(compoundActionOf(specOf('window'))).toContain('introspectability');
    // window：resize/move_to 的读回值 + settled 语义须在描述里
    const windowDesc = specOf('window').description;
    expect(windowDesc).toContain('requested');
    expect(windowDesc).toMatch(/settled:false 表示[^。]*500ms/);
    expect(windowDesc).toContain('victauri:default');
    expect(windowDesc).toContain('introspectable');

    // route：0.10.3 起 fetch 与 XHR 都支持 fulfill；Tauri IPC 规则语义须写明
    const routeDesc = specOf('route').description;
    expect(routeDesc).toContain('fetch 与 XHR 均支持全部 behavior');
    expect(routeDesc).not.toContain('只观察不控制');
    expect(routeDesc).not.toContain('（fetch 支持，XHR 回退 delay）');
    expect(routeDesc).toContain('Tauri-Response');
    expect(routeDesc).toContain('ipc.localhost');
    expect(routeDesc).toContain('invoke 才 resolve');
    expect(routeDesc).toContain('postMessage');
    expect(routeDesc).toContain('ipc_note');
    expect(routeDesc).toContain(
      '不进入 ghost detection/command_catalog/coverage',
    );
    expect(routeDesc).toContain('不计入 command_timings');
    expect(routeDesc).toContain('postMessage IPC 不受影响');
    // 冒烟锚点：批十 2/2 新增的四段口径在描述层可见（细粒度断言见下方专用用例），
    // 避免这段既有断言块对新增内容零覆盖、全部依赖单个新用例独守。
    expect(routeDesc).toContain('会拒绝两类规则');
    expect(routeDesc).toContain('真实命令不执行');

    // recording：replay 语义改为 0.10.x 口径（只重放无参成功调用、不与基线 diff）
    const recordingDesc = specOf('recording').description;
    expect(recordingDesc).toContain('skipped');
    expect(recordingDesc).toContain('blocked');
    expect(recordingDesc).toContain('不与原响应 diff');
    expect(recordingDesc).toContain('绝不回退 main');
    expect(recordingDesc).toContain('webview_label 只过滤');
    expect(recordingDesc).toContain('重放真实产生副作用');
    expect(recordingDesc).not.toMatch(/replay[^。]*与基线比对/);

    // storage：get_cookies 仅非 httpOnly
    expect(specOf('storage').description).toContain('httpOnly');

    // explain/fault 的 webview_label 已按源码证据定稿，不再留 [INFERENCE] 待证
    const explainLabel = propOf('explain', 'webview_label');
    const faultLabel = propOf('fault', 'webview_label');
    expect(explainLabel).toBeDefined();
    expect(faultLabel).toBeDefined();
    expect(explainLabel?.description).not.toContain('[INFERENCE]');
    expect(faultLabel?.description).not.toContain('[INFERENCE]');
    expect(explainLabel?.description).toContain('[源码]');
    expect(faultLabel?.description).toContain('[源码]');
    expect(explainLabel?.description).toContain('传入被静默忽略、不报错');
    expect(faultLabel?.description).toContain('均未定义该字段');
    expect(faultLabel?.description).toContain('不改变故障规则的作用域');
  });

  it('批九 1/3 上游口径纠偏:css/selector 主别名方向与 points 默认值矛盾加注', () => {
    const findElements = REST_TOOL_SPECS.find(
      (s) => s.name === 'find_elements',
    )!;
    const css = findElements.parameters['css'] as { description?: string };
    const selector = findElements.parameters['selector'] as {
      description?: string;
    };

    // L-5：上游「文档层」与「源码/schema 层」对 css/selector 的主名长期不一致
    // （≥0.8.8 起并存：文档一律 selector 主名，源码一律 css 主名），
    // 两键上游都接受、语义等价，故描述必须分层写清，避免把本地归一说成上游行为，
    // 也不能写成「0.10.2 及以前相反」这种并不存在的版本翻转。
    for (const [key, desc] of [
      ['css', css?.description ?? ''],
      ['selector', selector?.description ?? ''],
    ] as const) {
      expect(desc, `${key} 文档层口径`).toContain(
        '上游文档口径 0.8.8–0.10.3 及 main 一律 selector 为主名、css 为别名',
      );
      expect(desc, `${key} 源码层口径`).toContain(
        '上游源码/schema 口径一律 css 为主名、selector 为别名',
      );
      expect(desc, `${key} 两键等价`).toContain('两键上游均接受');
      expect(desc, `${key} 两键等价`).toContain('语义等价');
      expect(desc, `${key} 源码同传优先级`).toContain(
        '同时传两键时 0.10.3 源码取 css',
      );
      expect(desc, `${key} 来源标注`).toMatch(
        /\[文档 0\.10\.3\] \+ \[源码 0\.10\.3\]$/,
      );
      // 旧的写反口径与并不存在的版本翻转叙事不得残留
      expect(desc, `${key} 旧口径`).not.toContain('也接受 selector 别名');
      expect(desc, `${key} 旧口径`).not.toContain('(css 别名)');
      expect(desc, `${key} 旧叙事`).not.toContain('0.10.2 及以前相反');
    }

    // selector 键额外说明：两键同传时被忽略的是 selector
    expect(selector?.description).toContain('此时 selector 被忽略');

    // L-7：上游 markdown 文档写 points 默认 6，上游 schema doc-comment 与实现写默认 20，
    // 两者自相矛盾；插件跟 schema/实现口径（20），描述必须写明该矛盾与取舍依据。
    const animation = COMPOUND_TOOL_SPECS.find((s) => s.name === 'animation')!;
    const points = animation.parameters['points'] as { description?: string };
    expect(points?.description).toContain('默认 20');
    expect(points?.description).toContain('2..120');
    expect(points?.description).toContain(
      '上游 0.10.3 markdown 文档写 default 6',
    );
    expect(points?.description).toContain('自相矛盾');
    expect(points?.description).toContain('以 schema 为准');
    expect(points?.description).toContain('[源码 0.10.2]');
    expect(points?.description).toContain('[文档 0.10.3]');
  });

  it('批十 1/2 别名口径收口:query_db.sql 是上游正式 serde alias、webview_label/checkpoint_label 别名登记', () => {
    const specOf = (name: string, specs = REST_TOOL_SPECS) =>
      specs.find((spec) => spec.name === name)!;
    const propOf = (name: string, key: string, specs = REST_TOOL_SPECS) =>
      specOf(name, specs).parameters[key] as
        { description?: string } | undefined;

    // P2-5 勘误：query_db 的 sql 是上游正式 serde alias
    // （0.10.2 backend_params.rs:130 / 0.8.8 :117 `#[serde(alias = "sql")] pub query: String`），
    // 此前 catalog 写「上游只接受 query、无 sql 别名」与源码事实相反。
    const queryDb = specOf('query_db');
    expect(queryDb.description).toContain('上游正式 serde alias');
    expect(queryDb.description).toContain('[源码');
    expect(queryDb.description).toContain('duplicate field');
    expect(queryDb.description).not.toContain('均只接受 query');
    expect(queryDb.description).not.toContain('sql 是本插件自有的兼容别名');
    // 事实锚点：锁上游 crate 行号（措辞可调，行号不可漂）
    expect(queryDb.description).toContain('backend_params.rs:130');
    expect(queryDb.description).toContain('0.8.8 :117');
    // 本地归一也是对外承诺：必须写明「保留 query、移除 sql」与实现位置
    expect(queryDb.description).toContain('文档省略');
    expect(queryDb.description).toContain('ARG_ALIASES');
    expect(queryDb.description).toContain('移除 sql');
    // 参数描述同样要写明本地归一（否则删掉这半句仍全绿）
    const sqlDesc = propOf('query_db', 'sql')?.description;
    expect(sqlDesc).toBeDefined();
    expect(sqlDesc).toContain('duplicate field');
    expect(sqlDesc).toContain('ARG_ALIASES');
    expect(sqlDesc).toContain('移除 sql');
    // 别名归属只对第一分句做否定断言（后续半句描述插件侧本地归一，
    // 未来若标 [桥:本地归一] 不应假红）
    const sqlAliasClause = (sqlDesc ?? '').split(';')[0] ?? '';
    expect(sqlAliasClause).toMatch(/\[源码/);
    expect(sqlAliasClause).not.toMatch(/\[桥/);
    // 别名归属不得写成「插件自有 / 兼容别名」（那是上游正式别名，不是插件自造）
    expect(sqlAliasClause).not.toContain('插件自有');
    expect(sqlAliasClause).not.toContain('兼容别名');

    // P2-4 不变：eval_js.expression 仍是插件自有别名（上游 webview_params.rs 只有 code）
    expect(propOf('eval_js', 'expression')?.description).toMatch(/\[桥/);
    expect(propOf('eval_js', 'expression')?.description).not.toMatch(/\[源码/);
    // 工具级 description 也要声明归属（参数级锁不住这半句）
    expect(specOf('eval_js').description).toContain(
      'expression 是本插件自有的兼容别名',
    );

    // M-6 改判后落地：上游 webview_label 的正式别名 window/window_label 必须在描述里登记
    // （断言整串，避免 'window' 被 'window_label' 的子串满足而空洞通过）
    const webviewDesc = propOf('eval_js', 'webview_label')?.description;
    expect(webviewDesc).toBeDefined();
    expect(webviewDesc).toContain('window / window_label');
    expect(webviewDesc).toContain('上游正式别名');
    expect(webviewDesc).toMatch(/\[源码/);
    expect(webviewDesc).toContain('webview_params.rs:11');

    // recording checkpoint_label 的上游正式别名 label
    const checkpointLabel = propOf(
      'recording',
      'checkpoint_label',
      COMPOUND_TOOL_SPECS,
    )?.description;
    expect(checkpointLabel).toBeDefined();
    expect(checkpointLabel).toContain('别名 label');
    expect(checkpointLabel).toContain('快照标签');
    expect(checkpointLabel).toMatch(/\[源码/);
    expect(checkpointLabel).not.toMatch(/\[桥/);
    expect(checkpointLabel).toContain('compound_params.rs:454');

    // explain 的 webview_label 同属上游正式别名（别名 window），口径也应登记
    const explainWebview = propOf(
      'explain',
      'webview_label',
      COMPOUND_TOOL_SPECS,
    )?.description;
    expect(explainWebview).toBeDefined();
    expect(explainWebview).toContain('别名 window');
  });

  it('批十 1/2 文档守护:差距清单与上游反馈记录别名勘误,且不残留被推翻的旧表述', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const readDoc = (relative: string) =>
      readFileSync(join(repoRoot, relative), 'utf8');

    const gapList = readDoc('docs/audit/2026-11-05/gap-list.md');
    expect(gapList).toContain('【2026-11-05 勘误，批十 1/2】');
    expect(gapList).toContain('【2026-11-05 改判，批十 1/2】');

    const feedback = readDoc('docs/upstream-feedback-0.10.3.md');
    expect(feedback).toContain('### 7. 正式别名');
    expect(feedback).toContain('纯文档缺口');
    expect(feedback).toContain('粒度差异');
    // 被推翻的旧表述不得残留在对外文档里
    expect(feedback).not.toContain('sql 是本插件自有的兼容别名');
    expect(gapList).not.toContain('sql 是本插件自有的兼容别名');

    // 工具表的 query_db 口径与 catalog 一致（上游正式 serde alias）
    const toolsDoc = readDoc('docs/TOOLS.md');
    expect(toolsDoc).toContain('上游正式 serde alias');
  });

  it('批十 2/2 route 0.10.3 细化口径:add 拒绝规则 / ipc_warning / mock_unreadable / regex 重复组', () => {
    const specOf = (name: string) =>
      COMPOUND_TOOL_SPECS.find((spec) => spec.name === name)!;
    const routeDesc = specOf('route').description;
    // 描述是单行拼接，位置约束按「分句」绑定：取含该关键词的那一句再断言来源标注，
    // 避免 [^\n]* 退化成「全文任意位置出现该标注」的弱断言。
    // 分句约定：route 描述的语义分句以中文分号「；」分隔（若日后改用「。」或换行分句，
    // 需同步改此分隔符，否则 helper 会退化为「含关键词的整段」，断言强度下降）。
    const SENTENCE_SEPARATOR = '；';
    const sentenceWith = (keyword: string): string => {
      const hit = routeDesc
        .split(SENTENCE_SEPARATOR)
        .find((s) => s.includes(keyword));
      expect(hit, `route 描述缺少含「${keyword}」的分句`).toBeDefined();
      return hit!;
    };

    // ① add 的两条拒绝规则（[文档 0.10.3]）
    expect(routeDesc).toContain('会拒绝两类规则');
    expect(routeDesc).toContain('不可读');
    expect(routeDesc).toContain('Response 构造器');
    expect(sentenceWith('会拒绝两类规则')).toContain('[文档 0.10.3]');
    // 拒绝类判定只针对 fulfill 规则（上游仅在 action==='fulfill' 时计算 mock 可读性）
    expect(sentenceWith('会拒绝两类规则')).toContain('fulfill');
    // 拒绝判据串必须锁住（上游 mock 可读性判定的具体条件，删掉即语义漂移）
    expect(sentenceWith('会拒绝两类规则')).toContain('命中 IPC host');
    expect(sentenceWith('会拒绝两类规则')).toContain(
      '无 body、非 JSON body、204+application/json',
    );
    expect(sentenceWith('会拒绝两类规则')).toContain(
      '非 ByteString status_text',
    );

    // ② 宽 pattern 的 ipc_warning 与 mock_unreadable（[文档 0.10.3] + [源码 0.10.2]）
    expect(routeDesc).toContain('ipc_warning');
    expect(routeDesc).toContain('mock_unreadable');
    expect(sentenceWith('ipc_warning')).toContain('[文档 0.10.3]');
    expect(sentenceWith('mock_unreadable')).toContain('[源码 0.10.2');
    // ipc_warning 的前置条件：只有该 mock 同样不可读时才返回
    expect(routeDesc).toContain('当该 mock 同样不可读时 add 返回 ipc_warning');
    // 宽 pattern 的行为要点：被接受、命中时回 Tauri 错误、真实命令不执行
    expect(sentenceWith('更宽的 pattern')).toContain('会被接受');
    expect(sentenceWith('ipc_warning')).toContain('Tauri 错误');
    expect(routeDesc).toContain('真实命令不执行');
    // 行号事实锚点（上游 crate 行号漂移可被测出，措辞可调、行号不可漂）
    expect(routeDesc).toContain('js_bridge.rs:1886-1889');

    // ③ regex 重复捕获组在 add 时被拒（0.10.3 引入，0.10.2 及以前无此校验）
    expect(sentenceWith('重复捕获组')).toContain('在 add 时被拒');
    expect(sentenceWith('重复捕获组')).toContain('[文档 0.10.3]');
    expect(sentenceWith('重复捕获组')).toContain('[源码 0.10.3');
    expect(routeDesc).toContain('0.10.2 及以前没有此校验');
    expect(routeDesc).toContain('本机可核 0.8.8 / 0.10.2 均无');
    expect(routeDesc).toContain('js_bridge.rs:3552');

    // ④ ipc_warning/mock_unreadable 是 0.10.x 引入（0.8.8 无）
    expect(sentenceWith('0.10.x 引入')).toContain('0.8.8');
    expect(routeDesc).toContain('0.8.8 服务端没有这两项');
    expect(routeDesc).toContain('本机可核 0.8.8 无、0.10.2 有');

    // 来源标注必须区分三类来源，不得把单源证据冒充成另一类
    expect(routeDesc).not.toMatch(/\[CHANGELOG 0\.10\.3\]/);
  });

  it('批十一 2/3 差距清单状态回填：P3-5/M-2/M-3/M-4/L-11 的状态、归属与建卡映射表同现实一致', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const gapList = readFileSync(
      join(repoRoot, 'docs/audit/2026-11-05/gap-list.md'),
      'utf8',
    );

    // 取某个条目（含其后缩进续行）直到下一个同级条目或小节标题
    const entryOf = (key: string): string => {
      const lines = gapList.split('\n');
      const start = lines.findIndex((line) => line.includes(key));
      expect(start, `gap-list 缺少含「${key}」的条目`).toBeGreaterThanOrEqual(
        0,
      );
      const out: string[] = [];
      for (let i = start; i < lines.length; i += 1) {
        const line = lines[i]!;
        if (i > start && (/^-\s/.test(line) || /^#{2,3}\s/.test(line))) break;
        out.push(line);
      }
      return out.join('\n');
    };
    // 换行不参与语义断言：折行不应让断言变弱或变脆
    const flat = (text: string) => text.replace(/\s+/g, ' ');

    // ① P3-5：状态已回填为已修 + 行号级证据 + 真实落地提交
    const p35 = flat(entryOf('P3-5'));
    expect(p35).toContain('✅');
    expect(p35).toContain('【2026-11-05 已修，批十一 2/3】');
    expect(p35).toContain('README.md:44');
    expect(p35).toContain('docs/TOOLS.md:512');
    expect(p35).toContain('be544f6');

    // ② M-2：拆成「描述层已完成」与「实现层未授权」两段
    const m2 = flat(entryOf('M-2'));
    expect(m2).toContain('【2026-11-05 拆分，批十一 2/3】');
    expect(m2).toContain('描述层说明（已完成');
    expect(m2).toContain('实现层透传');
    expect(m2).toContain('t-mw1ri0ep-8vw7ql');
    expect(m2).toContain('未授权执行，需用户批准后才能认领');
    expect(m2).toContain('docs/TOOLS.md:155-180');

    // ③ M-3 / M-4 / L-11：归属写清且写明未授权
    const m3 = flat(entryOf('M-3'));
    expect(m3).toContain('t-mw2evd2u-0dukch');
    expect(m3).toContain('未授权执行，需用户批准后才能认领');

    const m4 = flat(entryOf('M-4'));
    expect(m4).toContain('t-mw2evd2u-0dukch');
    expect(m4).toContain('t-mw2eut5k-6k1elc');
    expect(m4).toContain('未授权执行，需用户批准后才能认领');

    const l11 = flat(entryOf('L-11'));
    expect(l11).toContain('t-mw2evd2u-0dukch');
    expect(l11).toContain('M-5');
    expect(l11).toContain('未授权执行，需用户批准后才能认领');

    // ④ 建卡映射表：批十一三行登记；未执行的批次不得预填「已执行」
    const rowOf = (key: string): string =>
      gapList
        .split('\n')
        .find((line) => line.startsWith('|') && line.includes(key)) ?? '';
    expect(rowOf('批十一 1/3')).toContain('已执行 e5f11d7');
    expect(rowOf('批十一 2/3')).toMatch(/执行中（本卡）|已执行 [0-9a-f]{7}/);
    const row11c = rowOf('批十一 3/3');
    expect(row11c).toContain('t-mw31b5gs-0czoj5');
    // 批十一 3/3 与批十二 1/1 已于 round-8 执行完毕，状态列须回填提交号
    expect(row11c).toContain('已执行 e98546f');
    const row12 = rowOf('批十二 1/1');
    expect(row12).toContain('t-mw351p2r-b6rxos');
    expect(row12).toContain('已执行 855f6c2');
    // round-8 新登记的四行必须同时带卡号与提交号（只写 hash 会丢追溯入口）
    for (const key of [
      '批十一 1/3',
      '批十一 2/3',
      '批十一 3/3',
      '批十二 1/1',
    ]) {
      const row = rowOf(key);
      expect(row).toMatch(/t-mw[0-9a-z-]+/);
      expect(row).toMatch(/已执行 [0-9a-f]{7}/);
    }

    // ⑤ 映射表不得把已由更早提交结案的差距记到后来的批次名下
    // （P3-5 实由 be544f6/eb549f3 落地，不是批十一 1/3 的成果）
    expect(rowOf('批十一 1/3')).toContain('route 0.10.3 行为边界');
    expect(rowOf('批十一 1/3')).not.toMatch(/^\|\s*P3-5/);
    // M-6 已在批十 1/2 整体结案，不得再列为 backlog-B 的在办项
    expect(rowOf('backlog-B')).toContain(
      'M-6 已在批十 1/2 整体结案故不在本卡范围',
    );
    // T-6 已在批十 2/2 结案，同样不得留在 backlog-B 的在办项里
    expect(rowOf('backlog-B')).toContain('T-6 已在批十 2/2 结案');
    // backlog-B 行的在办项不得把描述层已结案的 M-2/M-3/M-4 混记为未做
    expect(rowOf('backlog-B')).toContain(
      'M-2/M-3/M-4 的描述层已由批十一 1/3 结案',
    );
    expect(rowOf('backlog-B')).not.toContain(
      'M-2/M-3/M-4/M-6 的描述层已由批九 3/3',
    );
  });

  // 数组型工具清单（批十一 3/3 定稿：0.10.3 活体实测 + 上游源码取证，证据见 risk 文档）
  // 「工具描述护栏」与「文档影响面护栏」共用同一份清单，避免文档与描述两处漂移
  const ARRAY_TOOLS = [
    'find_elements',
    'get_registry',
    'resolve_command',
    'logs',
    'recording',
    'route',
    'window',
    'navigate',
    'inspect',
    'animation',
    'storage',
  ];

  it('批十一 3/3 数组型工具描述：只给确实返回顶层数组的工具补 {items:[...]} 说明，措辞统一', () => {
    // 统一措辞的硬编码期望：措辞改动必须同步改本断言，避免"改了文案却不断言"
    const EXPECTED_NOTE =
      '数组结果会被本插件统一包装为 {"items":[...]}（dsh execute 契约要求顶层为 object）；' +
      '上游同名工具/动作返回的是裸数组。' +
      '裸数组直透提案见看板卡 t-mw1ri0ep-8vw7ql（未授权执行，需用户批准后才能认领）。';
    expect(ARRAY_RESULT_NOTE).toBe(EXPECTED_NOTE);

    // 每个工具都要写明「整体返回」还是「哪些子动作返回」顶层数组
    const SCOPE: Record<string, string> = {
      find_elements: '本工具返回顶层数组',
      get_registry: '本工具返回顶层数组',
      resolve_command: '本工具返回顶层数组',
      logs: 'console/network/ipc/navigation/dialogs/events 六个动作返回顶层数组',
      recording: 'list_checkpoints/get_events/get_replay 三个动作返回顶层数组',
      route: 'list/matches 两个动作返回顶层数组',
      window: 'list/get_state 两个动作返回顶层数组',
      navigate: 'get_history/get_dialog_log 两个动作返回顶层数组',
      inspect: 'get_bounding_boxes 动作返回顶层数组',
      animation: 'list 动作返回顶层数组',
      storage: 'get_cookies 动作返回顶层数组',
    };

    const descOf = (name: string): string => {
      const spec = [...REST_TOOL_SPECS, ...COMPOUND_TOOL_SPECS].find(
        (item) => item.name === name,
      );
      expect(spec, `找不到工具 ${name}`).toBeDefined();
      return spec!.description;
    };

    // ① 每个数组型工具都带统一说明，并写明数组范围
    for (const name of ARRAY_TOOLS) {
      const description = descOf(name);
      expect(description, `${name} 缺统一数组说明`).toContain(EXPECTED_NOTE);
      expect(description, `${name} 缺数组范围声明`).toContain(SCOPE[name]!);
      expect(
        description.indexOf(SCOPE[name]!),
        `${name} 的数组范围声明应排在统一说明之前`,
      ).toBeLessThan(description.indexOf(EXPECTED_NOTE));
    }

    // ② 覆盖完整且不误伤：带统一说明的工具集合恰好等于数组型工具清单
    const carriers = [...REST_TOOL_SPECS, ...COMPOUND_TOOL_SPECS]
      .filter((spec) => spec.description.includes(EXPECTED_NOTE))
      .map((spec) => spec.name)
      .sort();
    expect(carriers).toEqual([...ARRAY_TOOLS].sort());

    // ③ 旧措辞必须清退，避免同一语义存在两套说法
    expect(descOf('find_elements')).not.toContain('本插件包装为 {items:[...]}');
    expect(descOf('find_elements')).not.toContain('返回顶层数组,本插件包装为');
  });

  it('批十二 1/1 文档影响面护栏：docs/TOOLS.md 的数组影响面清单与工具描述口径同源', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const toolsDoc = readFileSync(join(repoRoot, 'docs/TOOLS.md'), 'utf8');
    const flat = (text: string) => text.replace(/\s+/g, ' ');

    // 取「数组结果的形状」小节
    const sectionStart = toolsDoc.indexOf('## 数组结果的形状');
    expect(
      sectionStart,
      'docs/TOOLS.md 缺少「## 数组结果的形状」小节',
    ).toBeGreaterThanOrEqual(0);
    const sectionEnd = toolsDoc.indexOf('\n## ', sectionStart + 1);
    const section = toolsDoc.slice(
      sectionStart,
      sectionEnd < 0 ? undefined : sectionEnd,
    );

    // 取「影响面」这一条（到下一个列表项为止），文档里的工具名一律用反引号标注
    const lines = section.split('\n');
    const impactStart = lines.findIndex((line) => line.includes('**影响面'));
    expect(
      impactStart,
      'docs/TOOLS.md 缺少「影响面」说明',
    ).toBeGreaterThanOrEqual(0);
    const impact: string[] = [];
    for (let i = impactStart; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (i > impactStart && /^\s*-\s/.test(line)) break;
      impact.push(line);
    }
    const impactText = flat(impact.join(' '));

    // ① 影响面清单里的工具名集合必须与工具描述护栏的 ARRAY_TOOLS 完全一致
    const knownNames = new Set([
      ...REST_TOOL_SPECS.map((spec) => spec.name),
      ...COMPOUND_TOOL_SPECS.map((spec) => spec.name),
    ]);
    const listed = [
      ...new Set(
        [...impactText.matchAll(/`([a-z_]+)`/g)]
          .map((match) => match[1]!.replace(/^victauri_/, ''))
          .filter((name) => knownNames.has(name)),
      ),
    ].sort();
    expect(listed, '文档影响面清单与工具描述护栏的 ARRAY_TOOLS 不一致').toEqual(
      [...ARRAY_TOOLS].sort(),
    );

    // ② 误列的两条必须不在影响面清单里（trace.frames 走图像通道、fault.list 返回对象）
    expect(impactText).not.toContain('`trace`');
    expect(impactText).not.toContain('`fault`');

    // ③ 非穷举免责句必须保留
    expect(impactText).toContain('本列表非穷举');
    expect(impactText).toContain('判定依据是结果顶层类型');

    // ④ 两条易混例外必须在小节里写明，避免读者以为 trace/fault 拿不到 {"items":...}
    //    例外单独成条，单独取该条断言，避免靠整节里任意位置出现关键词蒙混过关
    const exceptionStart = lines.findIndex((line) =>
      line.includes('**两条易混例外**'),
    );
    expect(
      exceptionStart,
      'docs/TOOLS.md 缺少「两条易混例外」说明',
    ).toBeGreaterThanOrEqual(0);
    const exception: string[] = [];
    for (let i = exceptionStart; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (i > exceptionStart && /^\s*-\s/.test(line)) break;
      exception.push(line);
    }
    const exceptionText = flat(exception.join(' '));
    expect(exceptionText).toContain('`trace`');
    expect(exceptionText).toContain('`fault`');
    expect(exceptionText).toContain('normalizeImageResult');
    expect(exceptionText).toContain('图像通道');
    // 两个例外各自的真实返回形状都必须写明（不是只提工具名）
    expect(exceptionText).toContain('{...merged, paths[], mime_type, count}');
    expect(exceptionText).toContain('{count, faults: [...]}');
    // 例外段不得反过来把 trace/fault 塞回影响面清单
    expect(exceptionText).not.toContain('影响面是');
  });

  it('backlog-A 错误词汇表与重发现护栏:kind 11 值 / HTTP 分流 / S-1 归一 / S-2 矩阵与实现同源', () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const readDoc = (relative: string) =>
      readFileSync(join(repoRoot, relative), 'utf8');

    // ① docs 词汇表 REST 行必须与 errors.ts 的 11 值封闭表同源(逐值反引号锚点)
    const KINDS = [
      'no-instance',
      'instance-incomplete',
      'no-live-instance',
      'invalid-params',
      'auth',
      'not-found',
      'rate-limited',
      'http-error',
      'timeout',
      'tool-error',
      'cli-error',
    ];
    const toolsDoc = readDoc('docs/TOOLS.md');
    const restRow = toolsDoc
      .split('\n')
      .find((line) => line.includes('VictauriErrorKind'));
    expect(restRow, 'docs/TOOLS.md 缺少 REST 桥接词汇表行').toBeDefined();
    for (const kind of KINDS) {
      expect(restRow, `docs 词汇表缺 kind:${kind}`).toContain(`\`${kind}\``);
    }
    expect(restRow).toContain('{error:{kind,message,hint,status?}}');

    // ② errors.ts 源码同源:11 个字面量 + kindForStatus 四条映射
    const errorsSrc = readDoc('src/errors.ts');
    for (const kind of KINDS) {
      expect(errorsSrc, `errors.ts 缺 kind:${kind}`).toContain(`'${kind}'`);
    }
    expect(errorsSrc).toContain('function kindForStatus');
    expect(errorsSrc).toContain("if (status === 400) return 'invalid-params';");
    expect(errorsSrc).toContain(
      "if (status === 401 || status === 403) return 'auth';",
    );
    expect(errorsSrc).toContain("if (status === 404) return 'not-found';");
    expect(errorsSrc).toContain("if (status === 429) return 'rate-limited';");

    // ③ docs 的分流/S-1/S-2 说明必须齐备(含行为变更声明)
    expect(toolsDoc).toContain('HTTP 状态码 → kind 的机械映射');
    expect(toolsDoc).toContain('可选 `status` 键');
    expect(toolsDoc).toContain('工具级失败归一（S-1）');
    expect(toolsDoc).toContain('行为变更');
    expect(toolsDoc).toContain('自动重发现（S-2）');

    // ④ 实现侧同源:S-2 矩阵只认 401/403 与网络层 http-error;包装层接线存在
    const indexSrc = readDoc('src/index.ts');
    expect(indexSrc).toContain('export function shouldResetClient');
    expect(indexSrc).toContain('class ReconnectingVictauriClient');
    expect(indexSrc).toContain('err.status === 401 || err.status === 403');
    expect(indexSrc).toContain("err.kind === 'http-error'");

    // ⑤ bridge.ts:信封透出可选 status;deny_unknown_fields 不实注释已订正
    const bridgeSrc = readDoc('src/tools/standalone/bridge.ts');
    expect(bridgeSrc).toContain('VictauriHttpError ? err.status : undefined');
    expect(bridgeSrc).not.toContain('服务端拒未知字段');
    expect(bridgeSrc).toContain('静默忽略');
  });
});
