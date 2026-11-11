/**
 * standalone 批工具目录（20 个，victauri 工具名 1:1 映射 dsh victauri_<name>）。
 *
 * 参数 schema 来源（每个工具已标注）：
 * - [文档] 上游 tools-reference（0.10.3）——当前基线口径；
 * - [CHANGELOG] 上游 CHANGELOG（0.9.0–0.10.3）——文档参数表未收录的新增项以它为准
 *   （例：0.10.3 的 find_elements 四新参、0.9.0 引入的 invoke_command.timeout_ms）；
 * - [实测] 本机活体实例历史记录（victauri 0.8.8，REST POST /api/tools/<name> 空参探测
 *   "missing field" 错误消息 + 成功调用返回形状）——旧版服务端兼容性参考。
 *
 * 基线声明（victauri 0.10.3 双源对齐）：以 [文档 0.10.3] + [CHANGELOG 0.10.3] 双源为基线，
 * 与 [源码 0.10.2 cargo registry] 及 [实测 0.8.8] 历史记录逐项核对；一致处不另标注，差异处按来源标注。
 * 新增参数全部可选且为透传型（服务端按自身版本校验），旧版服务端不会因
 * "未使用的可选参数" 而失败——仅当真的把新参数发给旧服务端时由服务端自行决定。
 *
 * ParameterSchemaSpec 顶层即属性映射（implicit open object root），
 * required 是 per-property `required: true` 注解。
 *
 * 工具数口径：Victauri 全量 35（standalone 20 + compound 15）+ CLI 桥 1 + CLI 探测 1
 * + 工具发现 1 + 桥接体检 1 = 39 个 dsh 工具；
 * 本文件 20 = README「工具清单」standalone 行 = docs/TOOLS.md = 契约测试（常量推导）。
 */
import type { ParameterSchemaSpec } from '@deepseek-ai/dsh-tools';

import { JSON_VALUE } from './json-value.ts';

/** 单个 standalone 工具的静态规格。 */
export interface RestToolSpec {
  /** victauri REST 工具名（dsh 工具名 = `victauri_` + 本值）。 */
  readonly name: string;
  /** 一句话中文标题（render 摘要用）。 */
  readonly title: string;
  /** dsh 工具描述：语义 + 参数说明 + schema 来源注释。 */
  readonly description: string;
  /** 参数 schema（顶层属性映射；来源见 description 尾注）。 */
  readonly parameters: ParameterSchemaSpec;
  /**
   * 该工具的 REST 请求预算毫秒（可选声明；语义见 timeout.ts 优先级文档）。
   * 声明值夹 TOOL_BUDGET_MAX_MS=120s；未声明的工具沿用客户端配置/默认 30s。
   */
  readonly requestBudgetMs?: number;
}

/**
 * 数组型结果的统一说明（批十一 3/3）。
 *
 * 上游 victauri 的部分工具/子动作直接返回**顶层数组**（裸数组）；本插件的 REST 桥
 * 按 dsh execute 契约要求顶层是 object，故把数组结果统一包装为 `{"items":[...]}`。
 * 裸数组直透提案见看板卡 `t-mw1ri0ep-8vw7ql`——该卡为 backlog 提案卡，**未授权执行**。
 */
export const ARRAY_RESULT_NOTE =
  '数组结果会被本插件统一包装为 {"items":[...]}（dsh execute 契约要求顶层为 object）；' +
  '上游同名工具/动作返回的是裸数组。' +
  '裸数组直透提案见看板卡 t-mw1ri0ep-8vw7ql（未授权执行，需用户批准后才能认领）。';

/** 标量参数辅助（standalone/compound catalog 共用）。 */
export const STR = (description: string, required = false) => ({
  type: 'string' as const,
  description,
  ...(required ? { required: true as const } : {}),
});
export const INT = (description: string, required = false) => ({
  type: 'integer' as const,
  description,
  ...(required ? { required: true as const } : {}),
});
export const BOOL = (description: string) => ({
  type: 'boolean' as const,
  description,
});
/** 闭合枚举参数辅助（值域由服务端定义，本层只做透传前的收敛提示）。 */
export const ENUM = (
  description: string,
  values: readonly string[],
  required = false,
) => ({
  type: 'string' as const,
  enum: [...values],
  description,
  ...(required ? { required: true as const } : {}),
});
export const WEBVIEW = STR(
  '目标 webview 标签;缺省取第一个可用 webview [文档]。' +
    '上游正式别名 window / window_label 服务端同样接受(0.10.2 webview_params.rs:11 等) [源码];' +
    '本插件 schema 仍以 webview_label 为主名',
);

/** 20 个 standalone 工具规格（顺序 = 文档 tools-reference 顺序）。 */
export const REST_TOOL_SPECS: readonly RestToolSpec[] = [
  {
    name: 'app_info',
    title: 'Tauri 应用全景信息',
    description:
      '获取 Tauri 应用全景信息：config（identifier/product_name/windows 列表）、databases、env、paths、process。' +
      '无必填参数。schema 来源：[实测 0.8.8 空参成功]。',
    parameters: {},
  },
  {
    name: 'app_state',
    title: '后端状态探针',
    description:
      '经注册探针读后端状态。probe=探针名（缺省列出全部可用探针名）。' +
      'schema 来源：[文档 tools-reference] + [实测 0.8.8 空参成功]。',
    parameters: {
      probe: STR('要执行的探针名;缺省返回可用探针列表 [文档]'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'assert_semantic',
    title: '语义断言',
    description:
      '在 webview 里求值 JS 表达式并对结果做语义断言。' +
      '必填 expression（JS 表达式）与 condition（equals/not_equals/contains/greater_than/less_than/truthy/falsy/exists/type_is）；' +
      'expected 为条件期望值（任意 JSON 值：字符串/数值/布尔/null/数组/对象；truthy/falsy/exists 免）；' +
      'label 人类可读断言名。' +
      'schema 来源：[实测 0.8.8 缺参报 missing field `expression`] + [文档 condition 枚举] + [服务端 expected 为 serde_json::Value]。',
    parameters: {
      expression: STR('在 webview 求值的 JS 表达式 [实测必填]', true),
      condition: STR(
        '断言条件:equals|not_equals|contains|greater_than|less_than|truthy|falsy|exists|type_is [文档]',
        true,
      ),
      expected: JSON_VALUE(
        '条件期望值(任意 JSON 值:字符串/数值/布尔/null/数组/对象,原样透传不字符串化);truthy/falsy/exists 可省 [文档]',
      ),
      label: STR('人类可读断言名(报告用) [文档]'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'check_ipc_integrity',
    title: 'IPC 完整性检查',
    description:
      '检查 IPC 往返完整性:找出卡死(pending 超阈值)与报错的 IPC 调用。stale_threshold_ms 卡死判定毫秒阈值(默认 5000)。' +
      'schema 来源：[文档] + [实测 0.8.8 空参成功]。',
    parameters: {
      stale_threshold_ms: INT('卡死判定毫秒阈值,默认 5000 [文档]'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'detect_ghost_commands',
    title: '幽灵命令检测',
    description:
      '按 IPC 调用结果检测幽灵命令(前端调了但永远没有成功返回的命令)。' +
      'since_ms 只看最近 N 毫秒窗口。返回 confirmed_ghosts/verified_handlers/frontend_only/registry_only 等。' +
      'schema 来源：[文档] + [实测 0.8.8 空参成功]。',
    parameters: {
      since_ms: INT('时间窗口毫秒;>0 只看最近窗口 [文档]'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'dom_snapshot',
    title: 'DOM 快照',
    description:
      '读取带稳定 ref 句柄的 DOM 快照。format: compact(默认,可达性文本省 70-80% token)|json(全树含属性)。' +
      'schema 来源：[文档] + [实测 0.8.8 空参成功 keys=format,stale_refs,tree]。',
    parameters: {
      format: STR('快照格式:compact|json,默认 compact [文档]'),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'eval_js',
    title: '执行 JS',
    description:
      '在 Tauri webview 里执行 JavaScript 并返回结果。' +
      '参数名版本差异:本插件参数为 code [实测 0.8.8 报 missing field `code`];' +
      '上游 0.10.3 文档与 0.10.2 源码(webview_params.rs)均只接受 code,无 expression 别名;' +
      'expression 是本插件自有的兼容别名,自动归一为 code(见 src/tools/standalone/bridge.ts ARG_ALIASES)。' +
      '异步表达式自动包 await。本通道固定 45s 请求预算(经 client.callTool 第三参覆盖' +
      '全局 requestTimeoutMs 配置,不随其放大;app 端 VICTAURI_EVAL_TIMEOUT 调到 >45s 时本通道会先放弃)。',
    parameters: {
      code: STR(
        '要执行的 JS 代码;必填:code 或 expression 至少其一 [实测 0.8.8 接受 code]',
      ),
      expression: STR(
        '(兼容别名,插件自有)与 code 等价;两者都给时以 code 为准 [桥:本地归一 bridge.ts ARG_ALIASES]',
      ),
      webview_label: WEBVIEW,
    },
    // M-5(批十三 2/2):上游 eval_js 无 per-call 超时参数(0.10.3 webview_params.rs:7-13
    // 仅 code/webview_label;SemanticAssertParams 同样无)。超时是 app 级配置:
    // lib.rs:549 eval_timeout() 默认 30s、env VICTAURI_EVAL_TIMEOUT 可覆盖、
    // builder 校验 1s<t≤300s(lib.rs:1007-1013,MAX_EVAL_TIMEOUT_SECS=300)。
    // 本通道 30s 默认预算遇 app 端调大配置会先放弃(服务端仍在跑,见 gap-list M-8),
    // 故声明 45s:给默认档留余量,不追 300s 上限(declare 上限 TOOL_BUDGET_MAX_MS=120s 也兜不住)。
    // 预算覆盖语义(V2 低-6):声明值经 client.callTool 第三参 timeoutMsOverride 生效
    // (src/client.ts: timeoutMsOverride ?? this.timeoutMs)——eval_js 固定 45s,
    // 全局 requestTimeoutMs 调大不会放大它;同理调小也不缩它。
    requestBudgetMs: 45_000,
  },
  {
    name: 'find_elements',
    title: '查找元素',
    description:
      '按文本/角色/test_id/CSS 选择器/可访问名搜索元素,返回轻量匹配与 ref 句柄。' +
      '全部条件可选(可组合);本工具返回顶层数组;' +
      ARRAY_RESULT_NOTE +
      '0.10.3 起服务端计算可访问名并给出诚实的 visible/enabled,文本匹配返回最深的匹配节点;' +
      'exact 与 text_exact 的取舍以服务端实现为准(0.10.3 文档参数表未收录 text_exact)。' +
      'schema 来源：[文档 0.10.3 参数表] + [CHANGELOG 0.10.3 attribute/attribute_value/text_exact/include_hidden] + [实测 0.8.8 空参成功(返回数组)]。',
    parameters: {
      alt: STR('alt 文本子串匹配(忽略大小写) [文档]'),
      css: STR(
        'CSS 选择器(上游文档口径 0.8.8–0.10.3 及 main 一律 selector 为主名、css 为别名;' +
          '上游源码/schema 口径一律 css 为主名、selector 为别名;两键上游均接受、语义等价;' +
          '同时传两键时 0.10.3 源码取 css) [文档 0.10.3] + [源码 0.10.3]',
      ),
      enabled: BOOL('按可用状态过滤 [文档]'),
      exact: BOOL('文本精确匹配(默认子串) [文档]'),
      label: STR('关联 label 文本匹配(按 label 找 input) [文档]'),
      max_results: INT('返回上限,默认 10 [文档]'),
      name: STR('可访问名(aria-label/title/placeholder)子串匹配 [文档]'),
      placeholder: STR('placeholder 文本匹配 [文档]'),
      role: STR('ARIA 角色精确匹配 [文档]'),
      selector: STR(
        'CSS 选择器(上游文档口径 0.8.8–0.10.3 及 main 一律 selector 为主名、css 为别名;' +
          '上游源码/schema 口径一律 css 为主名、selector 为别名;两键上游均接受、语义等价;' +
          '同时传两键时 0.10.3 源码取 css,此时 selector 被忽略) [文档 0.10.3] + [源码 0.10.3]',
      ),
      tag: STR('HTML 标签名,如 button/input [文档]'),
      test_id: STR('data-testid 属性值精确匹配 [文档]'),
      text: STR('文本内容子串匹配(忽略大小写) [文档]'),
      title_attr: STR('title 属性子串匹配(忽略大小写) [文档 0.10.3]'),
      attribute: STR(
        'HTML 属性名匹配(与 attribute_value 配合使用;语义按参数名推断,以服务端实现为准) [CHANGELOG 0.10.3]',
      ),
      attribute_value: STR(
        'attribute 指定的属性值匹配(与 attribute 配合使用;语义按参数名推断,以服务端实现为准) [CHANGELOG 0.10.3]',
      ),
      text_exact: BOOL(
        '文本精确匹配(0.10.3 新增;与 exact 的区别以服务端实现为准) [CHANGELOG 0.10.3]',
      ),
      include_hidden: BOOL(
        '包含隐藏元素(默认只返回可见元素;语义按参数名推断,以服务端实现为准) [CHANGELOG 0.10.3]',
      ),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'get_diagnostics',
    title: '环境诊断',
    description:
      '运行环境诊断:检测 service worker/关闭的 shadow DOM/iframe/大 DOM/CSP。连接陌生应用时先调它。' +
      'schema 来源：[文档] + [实测 0.8.8 空参成功 keys=info,warnings]。',
    parameters: {
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'get_memory_stats',
    title: '进程内存统计',
    description:
      '从 OS 读实时进程内存统计(working set/page file 用量)。Windows 返回详细指标;Linux 返回 virtual/resident。' +
      'schema 来源：[文档] + [实测 0.8.8 空参成功]。',
    parameters: {},
  },
  {
    name: 'get_plugin_info',
    title: '插件信息',
    description:
      '获取应用全景信息:Tauri config(identifier/product_name/version)、app 目录路径(data/config/log/local_data)、' +
      '进程环境变量、app 目录内发现的数据库文件。schema 来源：[文档] + [实测 0.8.8 空参成功]。',
    parameters: {},
  },
  {
    name: 'get_registry',
    title: '检索命令注册表',
    description:
      '按名称/描述子串过滤列出全部注册的 Tauri 命令及参数 schema(#inspectable 宏注册才有 schema)。' +
      'query 缺省返回全部。本工具返回顶层数组;' +
      ARRAY_RESULT_NOTE +
      'schema 来源：[文档] + [实测 0.8.8 空参成功]。',
    parameters: {
      query: STR('按命令名或描述过滤的子串 [文档]'),
    },
  },
  {
    name: 'invoke_command',
    title: '调用 Tauri 命令',
    description:
      '经 IPC 调用注册的 Tauri 命令(等价前端 invoke),调用会入日志且可验证。' +
      '必填 command;args 为 JSON 对象(键=命令参数名)。隐私命令过滤可能拦截。' +
      'timeout_ms 是服务端整次调用预算(发命令+等结果,默认 30s、上限 300000),给合法慢命令调大;' +
      '注意本通道自身的 REST 请求预算是独立的一层(默认 30s,invoke_command 未单独放宽),' +
      '超过它的 timeout_ms 不会让本插件等更久。' +
      'with_logs=true 时返回变为 {result, backend_logs, backend_log_cursor}:backend_logs 是调用期间' +
      '记录的后端日志(debug 及以上,含并发后台活动),失败调用(命令报错/超时)的错误结果里也带日志;' +
      '需服务端具备 logs.backend 能力,且应用侧已装 log_layer/log_logger/wrap_logger 之一(否则捕获为空)。' +
      '后端日志调试三段式:①本工具 with_logs=true 拿 backend_log_cursor → ' +
      '②wait_for(condition=log, since_seq=backend_log_cursor) 等下一条日志 → ' +
      '③logs(action=backend_digest) 看全局摘要(上游 0.10.2 起提供;若当前组合尚未开放该子动作,前两步仍可用);' +
      '捕获量由服务端环境变量 VICTAURI_LOG_LEVEL(trace|debug|info|warn|error,默认 debug)与 ' +
      'VICTAURI_LOG_CAPACITY(默认 5000 条、上限 100000)调节。' +
      'schema 来源：[实测 0.8.8 报 missing field `command`] + [文档 0.10.3 args/timeout_ms/with_logs] + ' +
      '[CHANGELOG 0.9.0 引入 timeout_ms、0.10.2 with_logs 返回形状]。',
    parameters: {
      command: STR(
        '要调用的 Tauri 命令名,如 greet/save_settings [实测必填]',
        true,
      ),
      args: {
        type: 'object',
        additionalProperties: true,
        description: '命令参数 JSON 对象 [文档]',
      },
      timeout_ms: INT(
        '服务端整次调用预算毫秒(发命令+等结果,默认 30000,上限 300000;0.9.0 引入) [文档 0.10.3]',
      ),
      with_logs: BOOL(
        'true 时返回变为 {result, backend_logs, backend_log_cursor},附调用期间的后端日志;' +
          '需服务端后端日志捕获 [文档 0.10.3]',
      ),
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'list_app_dir',
    title: '列出应用目录',
    description:
      '列出应用 data/config/log/local_data 目录内容,发现数据库/配置/日志文件,免经 webview。' +
      'directory 默认 data;path 为相对子目录;pattern glob 如 *.sqlite;max_depth 默认 1。' +
      'schema 来源：[文档] + [实测 0.8.8 空参成功 keys=base,count,entries,exists,path,truncated]。',
    parameters: {
      directory: STR('目录别名:data|config|log|local_data,默认 data [文档]'),
      max_depth: INT('递归深度,默认 1(仅直接子项) [文档]'),
      path: STR('所选根下的相对子目录,如 databases [文档]'),
      pattern: STR('glob 过滤,如 *.sqlite、*.db [文档]'),
    },
  },
  {
    name: 'query_db',
    title: '查询 SQLite',
    description:
      '对应用数据目录里的 SQLite 库执行有界只读 SQL(自动发现库文件)。仅 SELECT/PRAGMA/EXPLAIN/WITH。' +
      '必填 query(别名 sql);params 位置绑定参数数组;path 相对 app data 目录;max_rows 默认 100。' +
      'sql 是上游正式 serde alias(0.10.2 backend_params.rs:130、0.8.8 :117)' +
      '[源码];0.10.3 文档参数表未列 sql 属文档省略。' +
      '上游同时收到 query 与 sql 会触发 serde duplicate field 报错,' +
      '故本插件仍在 bridge.ts ARG_ALIASES 里做本地归一(保留 query、移除 sql)以规避该冲突。' +
      'schema 来源：[实测 0.8.8 报 missing field `query`] + [文档其余字段]。',
    parameters: {
      query: STR(
        '只读 SQL(SELECT/PRAGMA/EXPLAIN/WITH);必填:query 或 sql 至少其一 [实测 0.8.8 接受 query]',
      ),
      sql: STR(
        '(上游正式别名)与 query 等价 [源码];上游同时收到 query 与 sql 会触发 serde duplicate field,' +
          '本插件本地归一保留 query、移除 sql(见 bridge.ts ARG_ALIASES)',
      ),
      params: { type: 'array', description: '位置绑定参数数组 [文档]' },
      path: STR('库文件路径,相对 app data 目录;缺省自动发现 [文档]'),
      max_rows: INT('返回行数上限,默认 100 [文档]'),
    },
  },
  {
    name: 'read_app_file',
    title: '读取应用文件',
    description:
      '从应用 data/config/log/local_data 目录读文件(默认 UTF-8 文本,binary:true 返回 base64)。' +
      '必填 path(相对所选目录,如 settings.json、databases/app.db);max_bytes 默认 1MB。' +
      'schema 来源：[实测 0.8.8 报 missing field `path`] + [文档其余字段]。',
    parameters: {
      path: STR('文件相对路径(相对所选目录) [实测必填]', true),
      binary: BOOL('true 返回 base64 字节;默认 UTF-8 文本 [文档]'),
      directory: STR('目录别名:data|config|log|local_data,默认 data [文档]'),
      max_bytes: INT('读取字节上限,默认 1MB [文档]'),
    },
  },
  {
    name: 'resolve_command',
    title: '自然语言解析命令',
    description:
      '按自然语言描述解析匹配的 Tauri 命令,按相关度打分排序(命令名/描述/意图/类别/示例)。' +
      '必填 query;limit 默认 5。本工具返回顶层数组;' +
      ARRAY_RESULT_NOTE +
      'schema 来源：[实测 0.8.8 报 missing field `query`] + [文档 limit]。',
    parameters: {
      query: STR(
        '描述想做什么的自然语言,如 "save the user settings" [实测必填]',
        true,
      ),
      limit: INT('返回结果数上限,默认 5 [文档]'),
    },
  },
  {
    name: 'screenshot',
    title: '窗口截图',
    description:
      '把 Tauri 窗口截成 PNG(Windows PrintWindow/macOS CGWindowList/Linux X11;纯 Wayland 失败回退整屏)。' +
      '本插件把返回的 base64 落盘 %TEMP%\\dsh-victauri\\ 并返回文件路径(不占上下文),' +
      '查看用 read_image 读该路径,展示给用户用 present 出卡。' +
      '隐藏窗口截图会报错,先 show 再截。schema 来源：[文档] + [实测 0.8.8 keys=data,mimeType,type]。',
    parameters: {
      window_label: STR('目标窗口标签;缺省截主/第一个可见窗口 [文档]'),
    },
  },
  {
    name: 'verify_state',
    title: '前后端状态对照',
    description:
      '对比前端状态(JS 表达式求值)与后端状态,返回含 mismatches 的 VerificationResult。' +
      '必填 frontend_expr;后端取态二选一:backend_command(经 invoke_command 取)或 backend_state(JSON 直给);' +
      'backend_command 需要传参时用 backend_args。' +
      'schema 来源：[实测 0.8.8 报 missing field `frontend_expr`] + [文档]。',
    parameters: {
      frontend_expr: STR('返回前端状态对象的 JS 表达式 [实测必填]', true),
      backend_command: STR(
        '取后端状态的 Tauri 命令(与 backend_state 互斥) [文档]',
      ),
      backend_state: {
        type: 'object',
        additionalProperties: true,
        description: '直给的后端状态 JSON(与 backend_command 互斥) [文档]',
      },
      backend_args: {
        type: 'object',
        additionalProperties: true,
        description:
          'backend_command 的传参对象(仅 backend_command 路径生效;后端命令需要参数时用它,' +
          '如 {"itemId":42}) [文档 0.10.3 起提供,0.10.2 源码 verification_params.rs 已含]',
      },
      webview_label: WEBVIEW,
    },
  },
  {
    name: 'wait_for',
    title: '条件等待',
    description:
      '按固定间隔轮询直到条件满足或超时。必填 condition:text|text_gone|selector|selector_gone|url|' +
      'ipc_idle|network_idle|expression|event|log;配套 value/expected/poll_ms(默认 200)/timeout_ms(默认 10000)/' +
      'since_ms(默认 2000, event/log 回看窗口)。expected 为任意 JSON 值(原样透传不字符串化)。' +
      'condition=log 阻塞到后端日志出现含 value 的行(大小写不敏感,匹配 message/target/fields/spans),' +
      'level 限定最低级别,fields 要求结构化字段等值匹配(大小写不敏感),' +
      'since_seq 只接受序号≥该值的行(优先于 since_ms);边沿触发,' +
      '超时返回 missed_entries(等待前被驱逐的条目数);需服务端开启后端日志捕获。' +
      '游标来源是 invoke_command(with_logs=true) 返回的 backend_log_cursor,' +
      '完整三段式套路与捕获量调节(VICTAURI_LOG_LEVEL 默认 debug、VICTAURI_LOG_CAPACITY 默认 5000 条' +
      '上限 100000)见 invoke_command 的 with_logs 说明。' +
      'schema 来源：[实测 0.8.8 报 missing field `condition`] + [文档 0.10.3 condition 枚举与 log 参数] + ' +
      '[CHANGELOG 0.10.2 log 条件]。',
    parameters: {
      condition: ENUM(
        '等待条件:text|text_gone|selector|selector_gone|url|ipc_idle|network_idle|expression|event|log ' +
          '(值域按 0.10.3 闭集校验;上游后续新增条件需随插件升级才能用) [实测必填]',
        [
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
        ],
        true,
      ),
      value: STR(
        '条件值:文本/CSS 选择器/URL 子串/JS 表达式/Tauri 事件名;' +
          'condition=log 时为日志行须含的文本 [文档]',
      ),
      expected: JSON_VALUE(
        '条件期望值(任意 JSON 值:字符串/数值/布尔/null/数组/对象,原样透传不字符串化);缺省任意真值 [文档]',
      ),
      level: STR(
        'condition=log 的最低日志级别:trace|debug|info|warn|error [文档 0.10.3]',
      ),
      fields: {
        type: 'object',
        additionalProperties: true,
        description:
          'condition=log 时日志行的结构化字段须等值匹配(大小写不敏感);' +
          '服务端开启脱敏时匹配的是脱敏后文本(如 key=value 对已被过滤) [文档 0.10.3]',
      },
      since_seq: INT(
        'condition=log 只接受序号≥该值的日志行(优先于 since_ms);' +
          '取 invoke_command with_logs 的 backend_log_cursor [文档 0.10.3]',
      ),
      poll_ms: INT('轮询间隔毫秒,默认 200 [文档]'),
      timeout_ms: INT('超时毫秒,默认 10000 [文档]'),
      since_ms: INT('event/log 条件回看窗口毫秒,默认 2000 [文档]'),
      webview_label: WEBVIEW,
    },
  },
];

/** standalone 工具数口径(代码头注释 = README = docs = 契约测试 四处一致)。 */
export const STANDALONE_TOOL_COUNT = REST_TOOL_SPECS.length;
