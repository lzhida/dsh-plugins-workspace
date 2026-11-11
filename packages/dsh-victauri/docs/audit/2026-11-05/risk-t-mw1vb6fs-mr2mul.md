# 批六 4/4（t-mw1vb6fs-mr2mul）残余风险自评

日期：2026-11-05 ｜ 卡片：基线声明升级 + smoke 活体复核 + 上游反馈材料 ｜ 状态：实现与验证完成，交接中

## 闭合项（卡面验收 4 项全达成）

1. **基线声明四处升级**：README.md:65、docs/TOOLS.md 头部 blockquote、src/tools/standalone/catalog.ts 头注释、src/tools/compound/catalog.ts 头注释，全部改为「victauri 0.10.3 双源对齐」。grep 全仓确认无残留「0.8.8 为基线」表述；证据类 0.8.8 实测（cli-doctor.test.ts、cli-hints 门控文案、contract.test.ts 注释）按设计保留。
2. **smoke 活体复核**：cargo update -p victauri-plugin -p victauri-core -p victauri-macros 成功（0.10.2→0.10.3）；cargo build --features victauri 成功；`pnpm smoke`（SMOKE_SKIP_BUILD=1）9/9 PASS（health/info 0.10.3/tools 35/get_plugin_info 35/app_info pid 一致/eval_js/dom_snapshot/invoke_command/无 token→401）。
3. **上游反馈材料**：docs/upstream-feedback-0.10.3.md 成文（4 缺口 + 4 自纠 + 2 复核确认无误），全部带源码行号/文档行号。
4. **explain/fault webview_label 活体复核闭环**：0.10.3 demo-app 活体证实——explain 带 webview_label 正常返回（字段生效）；fault 带 webview_label 注入成功且 fault list 可见（静默忽略生效、作用域不按窗口限定）。结论已回写 docs/TOOLS.md:78-83 与 compound/catalog.ts WEBVIEW_LABEL_FAULT 注释。

## 残余风险

- **R1 基线声明文本无测试守护**：src/tools/contract.test.ts:5 声称「口径四处一致」，但实际断言只锁工具数（20/15/38），catalog 头注释的基线声明文本无 readFileSync 断言。评估：文档性声明，补断言属过度工程，暂不补。若后续注释漂移，属低风险（不影响运行时行为）。
- **R2 smoke 未补 backend_logs 检查**：scripts/smoke.mjs 不在本卡允许文件清单（卡面只授权基线声明+反馈材料）。活体复核证据（logs backend_digest sources、invoke_command with_logs 5 键返回）已持久化到 docs/TOOLS.md 与 catalog 注释。**已决定建新卡**（批八）补该检查。
- **R3 上游 issue 提交未决**：docs/upstream-feedback-0.10.3.md 材料已备（4 缺口带行号证据），但父卡范围明确「不对上游 victauri 仓库发 PR/issue」——提交与否由用户裁决。
- **R4 活体实例生命周期**：复核用 demo-app 进程（pid 30924）已结束；后续任何活体验证需重启 demo-app（cargo build --features victauri 的产物仍在 target/debug/）。
- **R5 gen/schemas 构建产物漂移**：cargo check（不带 victauri feature）会重新生成 demo-app/src-tauri/gen/schemas/*（移除 victauri 权限清单）。本次已 git checkout 恢复、未夹带提交；但开发者本地跑 `cargo check`（不带 feature）会再次触发——属上游 tauri-build 行为，建议后续在 CONTRIBUTING/README 注明「提交前若 gen/ 有意外变动，用 cargo build --features victauri 再生成」。本卡不处理（超范围）。

## 验证记录

- V1：typecheck 0 / test 15 files 178 passed / lint 0 / prettier --check（5 改动文件 + 新文档）全绿。
- V2：子代理连续 8 次启动失败（provider 侧，id：42c4a7ee、8e33c2be、8e07f027、5251e63b、c43d7d36、c05e4d2b、10765e85、856eb58b、b5d9413d）→ 按「失败重试 3 次」纪律超限，降级为 Lead 亲自核对（6 项 A-F 全 PASS/PASS_WITH_NOTE，证据见卡评论）。降级原因已如实记录。
- 失败计数：format:check 首跑 FAIL（新文档未格式化）→ prettier --write 后绿（1/3）；V2 子代理失败 8 次（超 3 次上限，已按纪律降级并记录）。
