/**
 * 内嵌 skill：victauri-fullstack-debug。
 *
 * 注册方式与 @zhidal/dsh-patent 的 patent-disclosure 一致——apply() 内
 * `ctx.skills.register({ name, description, source: 'bundled', content })`；
 * 宿主 skills 服务由 dsh-base 顶层提供（dsh-skill 的 SkillRegistry），
 * 本包只承担内容与元数据，不自带服务实现。
 */

export const SKILL_NAME = 'victauri-fullstack-debug';

export const SKILL_DESCRIPTION =
  'Victauri 全栈调试 SOP：用 dsh-victauri 的 39 个工具对 Tauri 应用做' +
  '「前端 DOM → IPC 契约 → Rust 后端 → 数据层」的端到端排障——' +
  '环境确认、观察、交互、后端日志三段式、状态断言、故障注入与窗口盲区排障。' +
  '开发/测试 Tauri 应用、排查 IPC 命令不生效、验证后端行为时使用。';

export const SKILL_CONTENT = `
# Victauri 全栈调试套路

对 Tauri 应用做端到端排障的固定动线：**环境 → 观察 → 交互 → 后端 → 数据 → 断言 → 契约 → 注入 → 盲区**。
每一步只列该步骤该用的工具与陷阱；工具参数细节看各工具 description（带 [文档]/[源码]/[实测] 来源标注）。

## 0. 环境确认（动手前 30 秒）

1. \`victauri_get_diagnostics\`：IPC 捕获完整性（ipc_capture）、service worker、iframe、大 DOM、CSP——先看这里能省掉后面一半猜疑。
2. \`victauri_app_info\`：确认插件桥接的就是目标 app（identifier/pid/版本）。
3. CLI 侧 \`victauri_cli_status\`：本机 victauri CLI 版本；\`victauri check\` 做活体体检。
4. 没有活体 app？先启动（\`victauri run -- <dev 命令>\` 或直接启动），不要对着空端口调。

## 1. 观察（先看后动）

- \`victauri_dom_snapshot\` 拿语义树与 [ref=N] 句柄；\`victauri_find_elements\` 按文本/角色/选择器精查。
- **ref 时效**：ref 是 per-page-load 的——页面导航/重载后旧 ref 全部失效，必须重新 snapshot。
- 首次接手陌生应用先 \`victauri_get_registry\`（或 CLI \`victauri tools --json\`）看这个 app 实际注册了哪些 IPC 命令。

## 2. 交互（复现问题）

- \`victauri_interact\`（click/double_click/hover/focus/scroll_into_view/select_option）与 \`victauri_input\`（fill/type_text/press_key）。
- **Windows 限制**：\`trusted: true\`（真实 OS 键鼠输入）目前仅 Windows 实现；其他平台自动回退合成事件。
- 交互后立刻 \`victauri_explain { action: 'last_action' }\`：把「IPC 调用 → DOM 变化 → console 报错」串成因果时间线——这一步经常直接给出答案。

## 3. 后端验证三段式（核心套路）

要证明「前端点击真的调到了 Rust 并按预期执行」：

1. \`victauri_invoke_command { command, args, with_logs: true }\`：返回体带 backend_logs 与 **backend_log_cursor**（服务端需具备 logs.backend 能力，且应用侧已装 log_layer/log_logger/wrap_logger 之一，否则捕获为空）。
2. \`victauri_wait_for { condition: 'log', value: '关键字', since_seq: <cursor> }\`：边沿触发等待后端出现目标日志行；支持 level/fields 精确过滤。
3. \`victauri_logs { action: 'backend_digest' }\`：分级计数、最吵 target、重复消息折叠、近期 warn/error 与 panic——一屏看全后端健康。

陷阱：服务端可能开启脱敏——filter/fields/wait_for 匹配的是**脱敏后文本**（password/token 之类被遮蔽）；日志环形缓冲默认 5000 条（VICTAURI_LOG_CAPACITY 可调，上限 100000），long-running 压测要用 since_seq 游标增量读。

## 4. 数据层取证

- \`victauri_query_db { query }\`：只读 SQL 直查 app 数据库（SELECT/PRAGMA/EXPLAIN/WITH）。
- \`victauri_list_app_dir { directory }\` / \`victauri_read_app_file { path }\`：data/config/log/local_data 四目录内的文件清单与内容（不经 webview，后端视角）。

## 5. 状态断言（防回归）

- \`victauri_assert_semantic\`：单点断言（equals/contains/truthy/exists…），适合「点完按钮后购物车计数 === 3」。
- \`victauri_verify_state\`：前端表达式 vs 后端命令结果对照，两边都 JSON 比对——全栈一致性的终极检查。

## 6. 契约健康（前后端接缝）

- \`victauri_detect_ghost_commands\`：前端 invoke 了但后端没有 handler 的命令（按 IPC **结果**判定，高置信）。
- \`victauri_check_ipc_integrity\`：stale pending 与 errored calls 汇总。
- \`victauri_introspect { action: 'command_catalog' }\`：从**活体 IPC 流量**挖出每个命令真实的参数/返回形状（不依赖 #[inspectable] 宏）。

## 7. 故障注入配方（验证错误路径）

- **慢后端**：\`victauri_fault { action: 'inject', command, fault_type: 'delay', delay_ms: 3000 }\` → 立刻在前端触发该命令 → 观察加载态/超时处理 → \`fault { action: 'clear_all' }\` 清场。注意 fault 只作用于**你经 invoke_command 驱动的调用**，不碰用户真实点击。
- **后端报错**：faultType: 'error' + 自定义 error_message；\`fault { action: 'list' }\` 查活跃规则。
- **网络 mock**：\`victauri_route { action: 'add', pattern, behavior: 'fulfill', status, body }\`——fetch 与 XHR 都生效；reload 后规则消失；对 Tauri IPC URL（ipc.localhost/<cmd>）fulfill 需要响应头含 "Tauri-Response": "ok"，否则 invoke 拒收。
- **重放验证**：\`victauri_recording\` 录一轮回放一轮——只有无参成功调用会被重放，副作用真实发生，注意环境要可重入。

## 8. 窗口盲区排障

\`victauri_eval_js\` / \`victauri_dom_snapshot\` 对某个窗口返回空或报 not introspectable？

1. \`victauri_window { action: 'introspectability' }\`：逐窗口探测 JS bridge 是否可达。
2. \`introspectable: false\` 且窗口可见 → 几乎总是该窗口的 capability 缺 \`victauri:default\`——检查 app 侧 \`src-tauri/capabilities/*.json\`，把窗口名加进对应 capability 的 windows 数组。
3. 修完需要重建窗口（capability 在窗口创建时装配，改文件后要重开窗口才生效）。

## 9. 图像结果查看

\`victauri_screenshot\` / \`victauri_animation\`（scrub capture）/ \`victauri_trace\`（frames）返回的图像已由插件落盘
\`%TEMP%\\dsh-victauri\\\` 并以文件路径回传——**不占上下文**。要看图用 read_image 读文件路径；
要给人看/出交付卡用 present。

## 10. 收尾

- 清理注入的 fault/route 规则（clear_all），避免污染下一轮调试。
- \`victauri_explain { action: 'summary' }\` 回顾本轮全部活动，确认没有遗漏的报错。
- CLI 侧等价物：\`victauri logs --digest\`（后端摘要）、\`victauri logs --follow\`（跟随新行）、\`victauri call <tool> key=value\`（裸 shell 直调工具）。
`.trim();
