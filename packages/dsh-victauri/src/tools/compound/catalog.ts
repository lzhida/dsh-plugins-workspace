/**
 * compound 批工具目录（15 个，action 参数结构：一个 dsh 工具覆盖一组子动作）。
 *
 * 参数 schema 来源（每个工具已标注）：
 * - [文档] 上游 tools-reference（0.10.3）——当前基线口径；
 * - [源码] 上游 victauri-plugin 0.10.2 crate 源码（compound_params.rs 等）——参数
 *   结构体的真实字段集，用于判定某参数在哪个服务端版本起存在；
 * - [桥] 本机 victauri bridge 0.8.8 暴露的 MCP 工具 schema（action 枚举与参数名）——旧版兼容性参考。
 *
 * 基线声明（victauri 0.10.3 双源对齐）：以 [文档 0.10.3] + [CHANGELOG 0.10.3] 为基线，
 * 与 [源码 0.10.2] 及 [桥 0.8.8] 实测逐项核对；一致处不另标注，差异处按来源标注。
 * 新增 action/参数全部为透传型：0.8.8 服务端收到未知 action 会按 serde
 * 未知枚举值报错（新增 logs 子动作属此类），未知**参数**则被静默忽略
 * （两版 crate 均未开启 `deny_unknown_fields`）。
 *
 * 与 standalone 的差异：复合工具只有 `action` 是必填 enum，其余参数按子动作可选，
 * 服务端（victauri-plugin）负责子动作级校验，本层只透传。
 *
 * ParameterSchemaSpec 顶层即属性映射（implicit open object root），
 * required 是 per-property `required: true` 注解。
 *
 * 工具数口径：Victauri 全量 35（standalone 20 + compound 15）+ CLI 桥 1 + CLI 探测 1
 * + 工具发现 1 + 桥接体检 1 = 39 个 dsh 工具；
 * 本文件 15 = README「工具清单」compound 行 = docs/TOOLS.md = 契约测试（常量推导）。
 */
import type { ParameterPropertySpec } from '@deepseek-ai/dsh-tools';

import {
  ARRAY_RESULT_NOTE,
  BOOL,
  ENUM,
  INT,
  STR,
  WEBVIEW,
} from '../standalone/catalog.ts';
import type { RestToolSpec } from '../standalone/catalog.ts';
import { JSON_VALUE } from '../standalone/json-value.ts';
/** 开放对象参数辅助（headers/args/state 等 JSON 对象透传）。 */
const OBJ = (description: string) => ({
  type: 'object' as const,
  additionalProperties: true,
  description,
});
/** 浮点参数辅助（坐标/秒数/阈值）。 */
const NUM = (description: string) => ({
  type: 'number' as const,
  description,
});
/** 字符串数组参数辅助。 */
const STRARR = (description: string) => ({
  type: 'array' as const,
  items: { type: 'string' as const },
  description,
});

/**
 * explain 的 webview_label。
 *
 * [源码] 服务端 0.10.2 的 `ExplainParams.webview_label` 存在
 * （`introspection_params.rs:158-169`，别名 `window`，缺省 main 窗口）；
 * 0.8.8 的 ExplainParams 只有 action + seconds（`introspection_params.rs:160-167`），
 * 且两版 crate 均未开启 `deny_unknown_fields`（全仓 grep 无命中），
 * 故旧服务端收到该字段会静默忽略、不报错。
 */
const WEBVIEW_LABEL_EXPLAIN = STR(
  '目标 webview 标签（缺省 main 窗口）。[源码] 服务端 0.10.2 起支持' +
    '（ExplainParams.webview_label，别名 window）；0.8.8 服务端无此字段，' +
    '传入被静默忽略、不报错',
);

/**
 * fault 的 webview_label。
 *
 * [源码] 服务端 0.10.2 的 `FaultParams`（`introspection_params.rs:119-142`）
 * 与 0.8.8 的 FaultParams（`introspection_params.rs:121-144`）**均未定义**
 * webview_label，故传入会被忽略、不改变故障规则作用域；
 * 上游 0.10.x 的 fallback 工具清单口径含该字段，仅是工具清单口径。
 * [活体 0.10.3] 2026-11-05 复核：注入成功且 fault list 可见 = 静默忽略生效，
 * 与源码口径一致。
 */
const WEBVIEW_LABEL_FAULT = STR(
  '目标 webview 标签（对齐 0.10.x fallback 工具清单口径）。[源码] 服务端 ' +
    '0.8.8 与 0.10.2 的 FaultParams 均未定义该字段，传入会被忽略、' +
    '不改变故障规则的作用域',
);

/** action 参数（每个复合工具的公共必填头，枚举值见各规格）。 */
const ACTION = (tool: string, values: readonly string[]) =>
  ENUM(`${tool} 要执行的子动作`, values, true);

/** 15 个 compound 工具规格（顺序 = 文档 tools-reference 顺序）。 */
export const COMPOUND_TOOL_SPECS: readonly RestToolSpec[] = [
  {
    name: 'animation',
    title: '动画introspection与逐帧seek',
    description:
      '动画检查（无 CDP，读 Web Animations API）：list 列运行中 CSS 动画（timing/keyframes/进度）；' +
      'scrub 确定性暂停并 seek 到 points 个等分进度点，返回几何曲线（rect+transform+opacity），' +
      'capture=true 另返回 contact-sheet filmstrip（帧图同样落盘 ' +
      '%TEMP%\\dsh-victauri\\，查看用 read_image，展示给用户用 present）；' +
      'sample 实时录制 rAF 曲线（record=true 布防、false 收读，含丢帧统计；' +
      '清空录制用 clear=true 参数）。仅 CSS 动画可 seek（JS/rAF 用 sample）。' +
      '注意：动画仅在运行/挂起时可见——先触发动画再调用。' +
      'action 值域基线 0.10.3（list/scrub/sample）：[源码] 0.8.8 另有 clear 动作，0.10.x 起废弃' +
      '（清空改经 sample 的 clear=true 参数，见 0.10.3 tools-reference），本插件不再暴露 ' +
      'clear 动作；连 0.8.8 服务端时清空录制请改用 sample + clear:true。' +
      'list 动作返回顶层数组;' +
      ARRAY_RESULT_NOTE +
      ' [桥+文档 0.10.3]',
    parameters: {
      action: ACTION('animation', ['list', 'scrub', 'sample']),
      capture: BOOL('(scrub) 为 true 时每进度点原生截图并返回 filmstrip PNG'),
      clear: BOOL('(sample) 为 true 时调用后清空已录制会话'),
      cols: INT('(scrub) filmstrip 网格列数，默认 ~sqrt(n)'),
      points: INT(
        '(scrub) 等分进度点数，默认 20，夹到 2..120（上游 schema 口径且为实现值；上游 0.10.3 markdown 文档写 default 6，两者自相矛盾，以 schema 为准） [源码 0.10.2] + [文档 0.10.3]',
      ),
      record: BOOL('(sample) true 布防 rAF 录制；false 收读实测曲线'),
      restore: BOOL('(scrub) 默认 true 恢复动画；false 停在终点'),
      selector: STR('目标元素 CSS 选择器；list 省略 = 全部运行中动画'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'css',
    title: 'CSS 注入调试',
    description:
      'CSS 注入：inject 把自定义 CSS 注入页面；remove 移除先前注入的 CSS。' +
      'allow_remote 仅在确需加载远程样式表（@import/url()）时开启，默认 false ' +
      '（远程引用可被用作数据外泄/SSRF 向量，尤其与页面源 prompt injection 组合时）。 [桥]',
    parameters: {
      action: ACTION('css', ['inject', 'remove']),
      allow_remote: BOOL(
        '允许注入 CSS 中的远程 @import/url() 引用（默认 false）',
      ),
      css: STR('(inject) 要注入的 CSS 文本'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'explain',
    title: '活动关联叙述',
    description:
      '把 IPC + DOM + console + network + window 事件跨层关联成连贯叙述：' +
      'summary 最近 N 秒高层活动摘要（IPC 调用数/DOM 变更/console/network/错误计数，默认 30s）；' +
      'last_action 把最近一次事件爆发关联为因果时间线（如「IPC call → DOM update → console.log」）；' +
      'diff 最近 N 秒变化（事件计数/错误/新 IPC 命令）。 [桥]',
    parameters: {
      action: ACTION('explain', ['summary', 'last_action', 'diff']),
      seconds: NUM(
        '回看秒数：summary 默认 30，last_action 默认 5，diff 默认 10',
      ),
      webview_label: WEBVIEW_LABEL_EXPLAIN,
    },
  },
  {
    name: 'fault',
    title: '命令故障注入（chaos）',
    description:
      '按故障规则干扰经 invoke_command 工具驱动的命令执行，用于错误路径测试。' +
      '注意：只影响经由本桥 invoke_command 发起的调用，不拦截应用真实用户 IPC。' +
      'inject 加规则（command+fault_type 必填）；list 列规则；clear 按 id 删；clear_all 全删。 [桥]',
    parameters: {
      action: ACTION('fault', ['inject', 'list', 'clear', 'clear_all']),
      command: STR('(inject/clear) 目标命令名'),
      delay_ms: NUM('(fault_type=delay) 命令执行前人工延迟毫秒'),
      error_message: STR('(fault_type=error) 返回的错误消息'),
      fault_type: ENUM('(inject) 故障类型', [
        'delay',
        'error',
        'drop',
        'corrupt',
      ]),
      max_triggers: NUM('规则最多触发次数；0 或省略 = 不限'),
      webview_label: WEBVIEW_LABEL_FAULT,
    },
  },
  {
    name: 'input',
    title: '文本与键盘输入',
    description:
      '输入动作：fill 直接设置输入元素值（ref_id 必填）；type_text 逐字符键入' +
      '（trusted=true 走真实 OS 键盘事件，先聚焦目标元素，Windows 已实现）；' +
      'press_key 触发键盘键/组合（如 Enter/Control+a/Escape/Tab/ArrowDown）。 [桥]',
    parameters: {
      action: ACTION('input', ['fill', 'type_text', 'press_key']),
      key: STR('(press_key) 键名或组合'),
      ref_id: STR('(fill/type_text) DOM 快照 ref 句柄；press_key 可省略'),
      text: STR('(type_text) 要键入的文本'),
      trusted: BOOL('为 true 时投递真实 OS 输入（isTrusted: true）'),
      value: STR('(fill) 要设置的字符串值'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'inspect',
    title: 'CSS 与视觉检查',
    description:
      '检查动作：get_styles 取元素计算 CSS（properties 可指定属性清单）；' +
      'get_bounding_boxes 批量取布局矩形；highlight 加调试高亮 overlay；' +
      'clear_highlights 移除全部高亮；audit_accessibility 跑无障碍审计；' +
      'get_performance 取 timing/heap/DOM 指标。ref_id 来自 dom_snapshot。' +
      'get_bounding_boxes 动作返回顶层数组;' +
      ARRAY_RESULT_NOTE +
      ' [桥]',
    parameters: {
      action: ACTION('inspect', [
        'get_styles',
        'get_bounding_boxes',
        'highlight',
        'clear_highlights',
        'audit_accessibility',
        'get_performance',
      ]),
      color: STR('(highlight) overlay 颜色，默认 rgba(255,0,0,0.3)'),
      highlight_label: STR('(highlight) 高亮上方文字标签'),
      properties: STRARR(
        '(get_styles) 要返回的 CSS 属性名清单；省略 = 关键属性',
      ),
      ref_id: STR('目标元素 ref 句柄（get_styles/highlight 必需）'),
      ref_ids: STRARR('(get_bounding_boxes) 批量元素 ref 句柄'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'interact',
    title: 'DOM 元素交互',
    description:
      '元素交互：click/double_click/hover/focus；scroll_into_view 把元素滚入视口' +
      '（ref_id 优先，无 ref 用 x/y 像素滚动位）；select_option 在 <select> 里按值选' +
      '（单选用 value，多选用 values 数组）。多数动作需 dom_snapshot 返回的 ref_id。 [桥]',
    parameters: {
      action: ACTION('interact', [
        'click',
        'double_click',
        'hover',
        'focus',
        'scroll_into_view',
        'select_option',
      ]),
      ref_id: STR('目标元素 ref 句柄（click/hover/focus/select_option 必需）'),
      trusted: BOOL('为 true 时投递真实 OS 鼠标点击（Windows 已实现）'),
      value: STR('(select_option) 单选项值的便捷别名'),
      values: STRARR('(select_option) 多选项值数组'),
      webview_label: WEBVIEW,
      x: NUM('(scroll_into_view) 无 ref_id 时的水平滚动像素'),
      y: NUM('(scroll_into_view) 无 ref_id 时的垂直滚动像素'),
    },
  },
  {
    name: 'introspect',
    title: '后端深度introspection',
    description:
      '后端introspection全集：command_timings 每命令执行耗时统计（slow_threshold_ms 过滤）；' +
      'coverage 本会话被调用过的命令 + ipc_calls_observed；command_catalog 从活体 IPC 日志挖掘' +
      '每命令参数/返回形状（不用 #[inspectable] 也能拿到真实 schema）；' +
      'contract_record 记录命令响应形状基线；contract_check 检查 schema 漂移；' +
      'contract_list/contract_clear 基线管理；startup_timing 插件启动分相计时；' +
      'capabilities 枚举 Tauri v2 capabilities/安全配置/窗口定义；db_health SQLite 诊断' +
      '（journal/WAL/页统计，db_path 只读）；plugin_state 插件内部状态快照；' +
      'processes 枚举宿主进程与子进程；plugin_tasks 插件自有异步任务；' +
      'event_bus 列捕获的 Tauri 事件（args 传 {limit,since_ms}）；event_bus_clear 清缓冲。 [桥]',
    parameters: {
      action: ACTION('introspect', [
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
      ]),
      args: OBJ(
        '(contract_record/event_bus) 调用命令时的参数对象，如 {"limit":500,"since_ms":5000}',
      ),
      command: STR(
        '(contract_record/contract_check/contract_clear) 目标命令名',
      ),
      db_path: STR('(db_health) SQLite 库文件路径；省略自动发现'),
      slow_threshold_ms: NUM('(command_timings) 只显示慢于此毫秒数的命令'),
      webview_label: WEBVIEW,
    },
    // event_bus 大缓冲导出 / command_catalog 挖掘活体 IPC 日志：长操作显式预算
    requestBudgetMs: 90_000,
  },
  {
    name: 'logs',
    title: '应用日志与监控',
    description:
      '日志与监控动作：console 捕获的 console.log/warn/error；network 被拦截的 fetch/XHR；' +
      'ipc IPC 调用日志（wait_for_capture=true 等待至多 500ms 抓响应体）；navigation URL 变更史；' +
      'dialogs alert/confirm/prompt 事件；events 合并事件流；slow_ipc 慢调用检测' +
      '（threshold_ms 过滤）；clear 清 IPC+network 日志（按测试隔离）。' +
      '后端日志（Rust 侧）：backend 结构化条目（typed fields/span context/thread/file:line，' +
      '按 level/target/filter/fields 过滤，用 since_seq 游标分页）；backend_digest 摘要' +
      '（每级计数/最吵 target/重复消息折叠模板/近期告警/每个 panic，先看它）；' +
      'stdout 由 victauri run 捕获的原始 stdout/stderr 与进程退出记录' +
      '（since_seq 向前分页但 next_seq 不透明，含轮转文件标记；' +
      '[文档 0.10.3] gap:true 表示捕获已轮转越过；[源码] 0.10.2 的 stdout 无 gap 键，' +
      '0.10.2 的 gap 只出现在 backend 且语义为环形缓冲已淘汰）。' +
      '游标语义：带 since_seq 的读取返回游标之后最旧的条目、next_seq 紧随其后，' +
      '需读到 truncated=false；不带 since_seq 取最新。' +
      '捕获来源需服务端具备后端日志捕获：应用侧装 log_layer/log_logger/wrap_logger 之一' +
      '（[源码] release 构建不捕获），或经 victauri run 启动；' +
      '[源码] backend 无捕获源时返回空页并附 hint，stdout 未经 victauri run 启动时返回错误。' +
      '[文档] 0.10.3 口径（backend/backend_digest/stdout 自 0.10.2 起；bodies 自 0.10.3 起）；' +
      '[源码] 0.8.8 的 LogsParams 无 level/target/since_seq/fields/bodies，' +
      '0.10.2 起已含 level/target/since_seq/fields（仅缺 bodies）；' +
      '0.8.8 另无 backend/backend_digest/stdout 三个动作。' +
      '旧服务端兼容性：新增动作在 0.8.8 会因未知枚举值报错；' +
      '新增参数被 serde 静默忽略、不报错（两版服务端均未开 deny_unknown_fields）。' +
      'console/network/ipc/navigation/dialogs/events 六个动作返回顶层数组;' +
      ARRAY_RESULT_NOTE +
      ' [桥]',
    parameters: {
      action: ACTION('logs', [
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
      ]),
      bodies: BOOL(
        '(ipc/network) false 时省略 args 与请求/响应体，默认 true（读 1000 条时体积可控）；' +
          '[文档] 0.10.3 起（0.10.2 及以前的 LogsParams 无此字段，传入被静默忽略、不报错）',
      ),
      fields: OBJ(
        '(backend) 行的结构化字段须与此相等（文本比较，不区分大小写），如 {"run_type":"foreground"}；' +
          '[源码] 0.10.2 起',
      ),
      filter: STR(
        '(network) 按 URL 子串过滤；(backend/stdout) 对 message/target/fields/spans 的大小写不敏感文本匹配',
      ),
      level: STR(
        '(backend/stdout) 最低级别 trace/debug/info/warn/error；[源码] 0.10.2 起',
      ),
      limit: INT(
        '最多返回条目数；0 = 不返回。默认 100（slow_ipc 20，backend_digest 10）；' +
          '[源码] 0.10.2 的 backend/backend_digest/stdout 走 clamp，limit=0 被夹为 1',
      ),
      since: NUM('(console/events/backend) 只返回该 Unix 毫秒时间戳之后'),
      since_seq: INT(
        '(backend/stdout) 游标：只取序号 ≥ 该值的条目（backend 为条目序号，stdout 为字节偏移）；' +
          '[源码] 0.10.2 起',
      ),
      target: STR(
        '(backend) target 前缀过滤，逗号分隔（如 "app::db,app::sync"）；[源码] 0.10.2 起',
      ),
      threshold_ms: NUM('(slow_ipc) 慢调用阈值毫秒'),
      wait_for_capture: BOOL('(ipc) true 时等待最新条目响应体抓取完成'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'navigate',
    title: '导航与对话框控制',
    description:
      '导航与对话框：go_to 导航到 URL；go_back 浏览器后退；get_history 导航历史日志；' +
      'set_dialog_response 自动应答 alert/confirm/prompt（dialog_action=accept|dismiss，' +
      'prompt 可带 text）；get_dialog_log 取已捕获对话框事件。go_to/set_dialog_response ' +
      '受隐私控制约束。' +
      'get_history/get_dialog_log 两个动作返回顶层数组;' +
      ARRAY_RESULT_NOTE +
      ' [桥]',
    parameters: {
      action: ACTION('navigate', [
        'go_to',
        'go_back',
        'get_history',
        'set_dialog_response',
        'get_dialog_log',
      ]),
      dialog_action: ENUM('(set_dialog_response) 对话框应答', [
        'accept',
        'dismiss',
      ]),
      dialog_type: STR(
        '(set_dialog_response) 对话框类型（alert/confirm/prompt）',
      ),
      text: STR('(set_dialog_response) prompt 对话框的应答文本'),
      url: STR('(go_to) 目标 URL'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'recording',
    title: '时间旅行录制与回放',
    description:
      '录制与回放：start 开始录制（session_id 可指定，省略生成 UUID）；stop 停止并返回会话；' +
      'checkpoint 保存状态快照（checkpoint_label 起名，省略生成 cp-<uuid>）；' +
      'list_checkpoints 列快照；get_events 取 since_index 之后事件；' +
      'events_between 取两个快照间事件（from/to）；get_replay 取 IPC 回放序列；' +
      'export/import 会话 JSON 导入导出（session_json）；' +
      'replay 重放录制命令：录制不含调用参数，故只重放「成功且无参数」的调用，' +
      '有参数/失败/未完成/被 route 规则应答/走 postMessage 的调用被 skipped 并给出原因，' +
      '被隐私名单拦截的记为 blocked；passed 只表示重放成功，不与原响应 diff（只报 JSON 类型）；' +
      '每条调用在录制它的那个窗口重放，窗口不存在即 skipped，绝不回退 main；' +
      'webview_label 只过滤不重定向；重放真实产生副作用。' +
      'flush 立即排干挂起事件（不等 1 秒轮询）。' +
      'list_checkpoints/get_events/get_replay 三个动作返回顶层数组' +
      '(events_between 无丢弃事件时也是顶层数组,有丢弃时返回对象);' +
      ARRAY_RESULT_NOTE +
      ' [文档 0.10.3]',
    parameters: {
      action: ACTION('recording', [
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
      ]),
      checkpoint_id: STR('(events_between/get_replay) 快照 ID'),
      checkpoint_label: STR(
        '(checkpoint) 快照标签;上游正式别名 label(0.10.2 compound_params.rs:454) [源码]',
      ),
      from: STR('(events_between) 起始快照 ID'),
      session_id: STR('(start) 会话 ID，省略自动生成'),
      session_json: STR('(import) 先前 export 的 JSON 串'),
      since_index: INT('(get_events) 只取该索引之后的事件'),
      state: OBJ('(checkpoint) 要快照的状态 JSON'),
      to: STR('(events_between) 结束快照 ID'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'route',
    title: '网络请求拦截',
    description:
      '网络拦截（Playwright route 等价物，无 CDP）：按 URL 模式匹配 webview 的 fetch/XHR，' +
      'block 中止 / fulfill 返回 mock 响应 / delay 延迟放行。' +
      'match_type 选 pattern 语义（substring/glob/regex/exact，glob 中 * 匹配任意串、' +
      '其余字符含 ? 按字面）；times 限制触发次数；规则按页面作用域，reload 清空。' +
      '[文档 0.10.3] fetch 与 XHR 均支持全部 behavior（fulfill 的 XHR 不会真正触网，' +
      '按其 responseType 回报状态/头/体）；0.8.8/0.10.2 的服务端 XHR 只支持 block/delay' +
      '（fulfill 会退化为 delay）。' +
      '注意：顶层导航/子资源/WebSocket 不拦截。' +
      'Tauri IPC 规则（fetch 传输：http(s)://ipc.localhost/<cmd>、ipc://localhost/<cmd>）：' +
      'fulfill 伪造该命令（Rust handler 不执行），headers 含 "Tauri-Response": "ok" 时 ' +
      'invoke 才 resolve，否则以 body reject（可借此让命令失败）；delay 拦下调用；' +
      'block 不会让调用失败——被拦截的 fetch 报错后 Tauri 改走 postMessage 重试并沿用至 reload' +
      '（后端仍会执行）。被规则触碰的调用标记 mocked/route_delay_ms，' +
      'mocked 调用不进入 ghost detection/command_catalog/coverage/command_timings，' +
      '被延迟的调用不计入 command_timings；' +
      'add 返回 ipc_note 提示规则可能命中 IPC URL；postMessage IPC 不受影响。' +
      'add（0.10.x 服务端的 fulfill 规则）会拒绝两类规则：pattern 命中 IPC host 且 mock ' +
      '不可读（无 body、非 JSON body、204+application/json），或 mock 不被 Response 构造器 ' +
      '接受（header 名或值非法、非 ByteString status_text）[文档 0.10.3]；' +
      '更宽的 pattern（如 greet、*/greet）会被接受；当该 mock 同样不可读时 add 返回 ipc_warning：' +
      '命中 Tauri IPC 调用时 Tauri 读不出 mock，服务端回 Tauri 错误并记录 mock_unreadable，' +
      '真实命令不执行 [文档 0.10.3] + [源码 0.10.2 js_bridge.rs:1886-1889]；' +
      '正则 pattern 的重复捕获组（如 (a+)+）在 add 时被拒（会挂起页面，JavaScript 无正则超时）' +
      '[文档 0.10.3] + [源码 0.10.3 js_bridge.rs:3552]，0.10.2 及以前没有此校验' +
      '（本机可核 0.8.8 / 0.10.2 均无）；' +
      'ipc_warning/mock_unreadable 是 0.10.x 引入的细化，0.8.8 服务端没有这两项' +
      '（本机可核 0.8.8 无、0.10.2 有）。' +
      'add 加规则，list 列规则+触发日志，clear 按 id 删，clear_all 全删，matches 返回拦截日志。' +
      '[源码] 0.10.2 的 RouteBehavior 注释仍写 "fetch only; XHR falls back to delay"。' +
      'list/matches 两个动作返回顶层数组;' +
      ARRAY_RESULT_NOTE +
      ' [桥]',
    parameters: {
      action: ACTION('route', ['add', 'list', 'clear', 'clear_all', 'matches']),
      behavior: ENUM('(add) 规则行为', ['block', 'fulfill', 'delay']),
      body: STR('(fulfill) mock 响应体；字符串原样，其余 JSON 序列化'),
      content_type: STR(
        '(fulfill) mock 响应 Content-Type，默认 application/json',
      ),
      delay_ms: NUM('(delay/fulfill) 延迟毫秒'),
      headers: OBJ('(fulfill) mock 响应头 JSON 对象'),
      id: INT('(clear) 要删的规则 id'),
      limit: INT('(matches) 最多返回日志条数'),
      match_type: ENUM('(add) pattern 匹配语义', [
        'substring',
        'glob',
        'regex',
        'exact',
      ]),
      method: STR('(add) 限定单一 HTTP 方法'),
      pattern: STR('(add) URL 匹配模式（语义由 match_type 决定）'),
      status: INT('(fulfill) mock 状态码，默认 200'),
      status_text: STR('(fulfill) mock 状态文本'),
      times: NUM('(add) 规则最多触发次数；0/省略 = 不限'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'storage',
    title: '浏览器存储与 Cookie',
    description:
      '存储操作：get 读 localStorage/sessionStorage（storage_type 选，默认 local）；' +
      'set 写（value 为任意 JSON 值，服务端按 JSON 序列化后写入）；delete 删键；' +
      'get_cookies 取页面的 Cookie——[源码] 仅非 httpOnly（两版服务端均经 document.cookie 读取），' +
      'httpOnly Cookie 读不到（0.10.3 文档同）。' +
      'set/delete 受隐私控制约束。' +
      'get_cookies 动作返回顶层数组;' +
      ARRAY_RESULT_NOTE +
      ' [桥]',
    parameters: {
      action: ACTION('storage', ['get', 'set', 'delete', 'get_cookies']),
      key: STR('(get/set/delete) 存储键'),
      storage_type: ENUM('存储类型', ['local', 'session']),
      value: JSON_VALUE(
        '(set) 要存的值(任意 JSON 值:字符串/数值/布尔/null/数组/对象,原样透传;服务端按 JSON 序列化后写入)',
      ),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'trace',
    title: '截屏流/视觉轨迹',
    description:
      '视觉轨迹（无 CDP）：start 按固定间隔截窗进环形缓冲，形成视觉时间线；' +
      'with_events=true 同时启动事件录制器（捆绑 IPC/DOM/console 事件时间线）。' +
      'stop 停止并返回摘要（帧数/时长/时间戳）；status 查询活跃与缓冲帧数；' +
      'frames 取已捕获帧（base64 PNG，limit 限制数量，0/省略 = 全部）——' +
      '本插件把帧图像落盘 %TEMP%\\dsh-victauri\\ 返回文件路径，' +
      '查看用 read_image，展示给用户用 present。 [桥]',
    parameters: {
      action: ACTION('trace', ['start', 'stop', 'status', 'frames']),
      interval_ms: NUM('(start) 截屏间隔毫秒，默认 500，最小 50'),
      limit: INT('(frames) 最多返回帧数；0/省略 = 全部缓冲'),
      max_frames: INT('(start) 环形缓冲容量，默认 60，最大 600'),
      webview_label: WEBVIEW,
      with_events: BOOL('(start) 同时启动事件录制器'),
    },
    // frames 可取全部环形缓冲（上限 600 帧 base64 PNG）：长操作显式预算
    requestBudgetMs: 90_000,
  },
  {
    name: 'window',
    title: '窗口管理',
    description:
      '窗口管理：get_state 取窗口位置/尺寸/可见性；list 列全部窗口标签；' +
      'manage 执行窗口动作（manage_action：minimize/unminimize/maximize/unmaximize/' +
      'close/focus/show/hide/fullscreen/unfullscreen/always_on_top/not_always_on_top）；' +
      'resize 调整逻辑像素尺寸（width/height）；move_to 移动（x/y 逻辑像素）；' +
      'set_title 改标题；introspectability 探测每个窗口 Victauri 是否真能 introspect' +
      '（有响应的 JS bridge）；[文档 0.10.3] 在 visible:true 的窗口上不可探' +
      '（introspectable:false）几乎总是其 capability 缺 victauri:default，' +
      '需为每个窗口单独配置 capability（不只 main）。' +
      'label 选目标窗口，省略 = 主窗口。' +
      '[文档 0.10.3] resize/move_to 返回读回值（物理像素/位置）并附 requested，' +
      'settled:false 表示约 500ms 内窗口未变化（Linux/macOS 异步生效，窗口管理器可能忽略）。' +
      '[源码] introspectability 在 0.8.8 与 0.10.2 的 WindowAction 中均已存在。' +
      'list/get_state 两个动作返回顶层数组;' +
      ARRAY_RESULT_NOTE +
      ' [桥]',
    parameters: {
      action: ACTION('window', [
        'get_state',
        'list',
        'manage',
        'resize',
        'move_to',
        'set_title',
        'introspectability',
      ]),
      height: INT('(resize) 逻辑像素高'),
      label: STR('目标窗口标签（省略 = 主/首个可见窗口）'),
      manage_action: ENUM('(manage) 窗口动作', [
        'minimize',
        'unminimize',
        'maximize',
        'unmaximize',
        'close',
        'focus',
        'show',
        'hide',
        'fullscreen',
        'unfullscreen',
        'always_on_top',
        'not_always_on_top',
      ]),
      title: STR('(set_title) 新窗口标题'),
      width: INT('(resize) 逻辑像素宽'),
      x: INT('(move_to) 逻辑像素 X'),
      y: INT('(move_to) 逻辑像素 Y'),
    },
  },
];

/** compound 批工具数（口径锚点，契约测试与 README/docs 同源）。 */
export const COMPOUND_TOOL_COUNT = COMPOUND_TOOL_SPECS.length;

/** action 枚举值守卫（导出供契约测试与装配方使用）。 */
export function compoundActionOf(spec: RestToolSpec): readonly string[] {
  const action = spec.parameters['action'] as ParameterPropertySpec & {
    enum?: readonly string[];
  };
  return action.enum ?? [];
}
