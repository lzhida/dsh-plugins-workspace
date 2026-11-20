# 残余风险自评：批八 3/4 t-mw2eu6r5-uew7ds（测试增强与 doctor 口径修正）

日期：2026-11-05 ｜ 分支 dev ｜ 提交：见卡评论（A=测试增强，B=D-5 口径，C=审计文档）

## 闭合项

- C1 T-1：wait_for 闭集枚举客户端前置拒绝已锁定（三案负向断言 + calls===0 证明请求不发出）。
- C2 T-2：7 个新增参数的来源标注升级为三元组逐参精确断言（[文档 0.10.3] / [CHANGELOG 0.10.3]），误标不再放行。
- C3 T-3：invoke_command.timeout_ms 与本通道 REST 预算脱钩已成显式契约（timeout.test.ts + standalone.test.ts 双锁），消除「传了 timeout_ms 就以为本通道会等更久」的误解。
- C4 T-4：wait_for.condition 枚举断言已注明「闭集契约 tripwire」性质。
- C5 T-5：compound 桥首次具备运行时透传覆盖（校验拒绝 / 闭集合法值 / 未知参数放行三链路）。
- C6 D-5：doctor --json 口径改为「不提供」的恒定提示（0.8.8 实测 + 0.10.3 源码双证），旧「0.10.0 起的文档才提供」不实口径已从 hints/docs/测试三处清除并被负向断言锁死。

## 残余风险

- R1【低】T-1 的负向断言绑定 dsh-tools 的错误文案（/must be one of/、/missing required property/、/must be an integer/）——dsh-tools 大版本升级改文案时用例会红（属 tripwire 性质，红即需同步，可接受）。
- R2【低】tripwire 注释本身无守护（注释文本不可断言）；其防误改能力由同一份字面量的 toEqual 断言承担——只能抓误改，抓不了与上游口径漂移（上游 0.10.4 新增条件需随插件升级，卡面已知）。
- R3【低】compound/bridge.test.ts 的 route 用例断言「未知顶层参数放行」是**当前实现口径**（透传语义）；若未来改为本地白名单拒绝，该用例需随口径更新（有注释说明）。
- R4【低】cli.test.ts 的 doctor 用例连带修改超出卡面允许文件清单——已显式记录为「必要连带」（不改则 V1 红）；范围纪律的例外扩展需验收人知悉。
- R5【极低】D-5 的「0.10.3 CLI 源码无该选项」结论来自对 v0.10.3 main.rs 的 grep；若上游未来新增 --json，需回改（负向断言「不提供 --json」会红提示）。

## 结论

可执行残余缺口：无（R1-R5 均为记录性风险，不建卡）。
