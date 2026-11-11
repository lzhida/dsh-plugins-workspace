# 残余风险自评：批八 4/4 t-mw2euhui-e3bo22（文档同步 D 组 + E-2）

日期：2026-11-05 ｜ 分支 dev ｜ 提交：见卡评论

## 闭合项

- C1 D-1：docs logs 动作表 11 值与 compound/catalog.ts 枚举一致，并有逐名同源护栏。
- C2 D-2：docs window 动作表 7 值（+introspectability 语义）与 catalog 一致，护栏同上。
- C3 D-3：wait_for 10 值闭集在 docs 全量列出（表格行引用 + 小节详述）。
- C4 D-4：README 与 docs 双侧补齐 timeout_ms / with_logs / since_seq / backend_log_cursor / include_hidden 关键词且口径正确（三段式 + 游标方向 + 脱敏匹配）。
- C5 E-2：demo-app/README.md 双口径并存（服务端 35 + dsh 桥接 38=35+3）。
- C6 护栏：cli-hints.test.ts 新增同源用例（三工具枚举逐名 + wait_for 10 值 + 五关键词 + 38/35 口径），文档再漂移必红。
- C7 连带：README doctor 句（批八 3/4 漂移）与 docs animation 表（批八 2/4 漂移）一并修正。

## 残余风险

- R1【低】护栏用例的枚举逐名断言锁的是「docs 文字包含反引号名」这一层；若 docs 动作表整行被删，用例红；若某动作名在**其他段落**恰好出现（如正文提及），该名可能被绕过——但整表删除类漂移仍会被抓，属文档护栏的天然边界。
- R2【低】E-2 保留「服务端 35」的裁决依赖读者理解两个口径并存（服务端清单 vs dsh 桥接面）；已用括号注释写明换算关系。
- R3【低】docs/TOOLS.md 动作表经 prettier 重排（列宽对齐），与 in_review 卡已提交段落的既有口径（watch/bridge/长驻/512KB）无交集——diff 抽查确认只动本卡目标行与新小节。

## 结论

可执行残余缺口：无（R1-R3 记录性风险，不建卡）。
