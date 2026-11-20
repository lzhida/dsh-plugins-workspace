# round-9：用户裁决授权执行轮（backlog-A + backlog-B 拆卡批十三 1/2、2/2）

- 日期：2026-11-05
- 缘起：round-8 收敛后，用户裁决「文档缺口就不管了，插件内部自行消化问题就好了，不需要提 issue，然后处理剩下的非提issue的问题」——上游反馈材料转存档不提 issue；backlog-A（t-mw2eut5k-6k1elc，S-1/S-2/M-1 + bridge.ts:112 注释订正）与 backlog-B（t-mw2evd2u-0dukch，M/L 组）获授权。本轮按「提案先行 → 用户圈定范围 → 实施」执行。
- `{items}` 裸数组透传（t-mw1ri0ep-8vw7ql）维持用户 2026-11-04 裁定，不在本轮范围。

## 一、执行流程

1. **提案阶段（0884406）**：两卡 waitingForHuman=false → backlog→todo→in_progress（backlog 直接移 in_progress 会 invalid_transition，须经 todo）；落盘 backlog-A-design-proposal.md（kind 7→11 值映射 + 重发现触发矩阵 + 4 个决策点）与 backlog-B-evaluation.md（13 条三类分类）。ask_user_question 实答：backlog-A 照提案实施（4 决策点全认可）；backlog-B 小改全做拆 2 卡、需设计暂缓。
2. **backlog-A 实施（649b392，feat(client)，12 files +534/-42 含 risk 文档）**：S-1 = client.ts callTool 200 分支识别「object + 'error' 键 + 显式无 'result' 键」→ 抛 VictauriError('tool-error')（≤500 字符摘要）；S-2 = 新增 `shouldResetClient`（VictauriHttpError 401/403 或 kind='http-error' → true；Timeout → false）+ `ReconnectingVictauriClient implements VictauriClientLike` 包装（命中才回调 onReset 并原样 rethrow），apply 接线 clientPromise 复位重跑 discovery；M-1 = kind 7→11 值（+invalid-params/auth/not-found/rate-limited）+ `kindForStatus` 机械映射 + 信封可选 status 键；bridge.ts:112 注释订正（上游无 deny_unknown_fields，别名键移除仅为本插件防混淆）；README/docs 新小节「HTTP 分流与信封可选键」。测试：新建 src/reconnect.test.ts（矩阵 + 包装行为 8 用例）+ client/standalone/contract 四处增强。
3. **backlog-B 拆卡**：批十三 1/2（t-mw36ua1v-848yxm，M-10a CLI timeout_ms 上限 + L-10 图像落盘 20MiB 上限）、批十三 2/2（t-mw36ua79-1fkccm，M-4 ignored_args 可观测性 + M-5 eval_js 声明预算）。
4. **批十三 1/2（48d8acb + 2ad96d7，in_review v13，清单 8/8）**：CLI_MAX_TIMEOUT_MS=300_000 与宿主工具声明同源，execute 夹取 `Math.min(Math.max(requestedTimeoutMs,1), MAX)`（V2 低-4 补 0/负数防御）；IMAGE_SAVE_MAX_BYTES=20MiB，超限抛错不落盘、经 applyImageChannel 回退 image_save_error。V2（subagent c6d2cf8d，PASS_WITH_NITS 2 中 + 6 低）全部处置：中-1 归 M-10b 登记 risk R5 不修；中-2 补不变量断言；低-3 注入 version:'0.8.8' 桩避免真实 spawn 与污染 cli-status 缓存；低-4 Math.max 防御；低-7 删冗余断言与旧注释。
5. **批十三 2/2（1010ca9 + d07c744，in_review v11→v12 清单 8/8）**：M-5 前置查证——上游 eval_js **无 per-call timeout 参数**（0.10.3 webview_params.rs:7-13；app 级 lib.rs:549 默认 30s / :1007-1013 校验 1-300s）→ 按清单「不支持」分支给 eval_js 声明 requestBudgetMs:45_000（默认档留余量，不追 300s）；M-4 = bridge.ts `collectIgnoredArgs`（透传语义不变，仅顶层附加 ignored_args，图像通道/错误信封不附加）。V2（subagent 6eeaaa9f，PASS_WITH_NITS 1 中 + 8 低）九条全修复：中-1 上游 serde 别名误报（新增 UPSTREAM_WINDOW_ALIAS_TOOLS 23 工具 + UPSTREAM_EXTRA_ALIASES，消除 eval_js{window}/recording{label} 误报，与插件自身描述不再矛盾）；低-2 删 ARG_ALIASES 死分支；低-3 补图像通道不附加用例；低-4 risk 文档自评订正；低-5 ignored_args_plugin 备用键防御；低-6 预算覆盖语义写明；低-7 声明不认键备忘入 risk R5；低-8 行号 :1007-1013；低-9 第三参集成断言。

## 二、验证（V1 全绿后才提交）

| 轮次              | typecheck | test                     | lint | format | 突变                                           | smoke                              |
| ----------------- | --------- | ------------------------ | ---- | ------ | ---------------------------------------------- | ---------------------------------- |
| backlog-A         | exit 0    | 18 files / **208** tests | 0    | 绿     | 三案 RED（定向反向替换）                       | —                                  |
| 批十三 1/2        | exit 0    | 18 files / **212** tests | 0    | 绿     | M1 撤夹取 RED / M2 撤上限 RED                  | —                                  |
| 批十三 2/2 修复轮 | exit 0    | 18 files / **223** tests | 0    | 绿     | M1 撤别名组 / M2 撤备用键 / M3 撤 EXTRA 均 RED | 10/10 PASS（1334ms，0.10.3 @7373） |

- V2 方式：批十三 1/2、批十三 2/2 子代理各一次成功；backlog-A 子代理 1 次路由拒绝 → Lead 亲自五项核对（如实记录，纪律允许的降级）。
- 过程事故（≤3 次/步，全部恢复）：backlog-A 突变还原两次事故（`git checkout --` 误吞未提交实现 → 重放 7 处编辑恢复；备份函数 -replace 未生效致三文件滞留突变态 → 定向反向替换恢复）；首笔提交多行 -m 解析失败且错标 docs(audit) → `git commit --amend -F %TEMP%\amend-msg.txt` 修正为 649b392。教训已沉淀：突变还原一律定向反向替换、多行提交信息用 -F 文件。

## 三、关键结论

1. **错误信封与重连语义成立**：上游工具级失败（HTTP 200 + {"error"}）不再裸透出；401/403/http-error 自动复位重发现；kind 11 值 + 可选 status。信封契约与 docs/TOOLS.md 承诺对齐。
2. **M-4 采用可观测性方案而非改透传语义**：上游静默忽略行为不变（t-mw1ri0ep-8vw7ql 的范围不被侵占），只补 ignored_args 提示；known 集合必须含上游 serde 别名，否则提示与插件自身描述自相矛盾（V2 中-1）。
3. **M-5 走「上游不支持」分支**：eval_js 无 per-call timeout 参数是源码级事实（三处行号），声明预算 45s 只兜默认档，与 app 端可配 300s 的错位已写进描述与 risk。
4. **timeout_ms 上限与宿主预算同源**：CLI_MAX_TIMEOUT_MS 与 defineTool 的 timeoutMs 用同一常量，宿主预算下调时护栏（不变量断言）会红。
5. **backlog-B 剩余范围明确暂缓**：M-3/M-7/M-8/M-9/M-10b/L-3/L-4/L-9/L-11 属需设计/架构级，评估文档已给出「不建议自动执行」理由与路径，待用户后续授权。

## 四、看板状态（本轮收尾实测，台账 rev 5086）

- done 31（未动）；in_review 10（批十 1/2、批十 2/2、批十一 1/3、批十一 2/3、批十一 3/3、批十二 1/1、backlog-A v18、backlog-B v16、批十三 1/2 v13、批十三 2/2 v12）；todo 0；in_progress 0；backlog 1（t-mw1ri0ep-8vw7ql，用户裁定不执行）。
- 未代移任何卡到 done；全部新提交落 dev 未 push。

## 五、剩余缺口（全部非本轮可执行类）

1. `{items}` 实现层直透（t-mw1ri0ep-8vw7ql，用户裁定维持 backlog）。
2. backlog-B 需设计/架构级九项（用户裁决暂缓，见 backlog-B-evaluation.md）。
3. 记录性风险 18 条（见《插件功能审查总结.md》第七节）。
4. 待用户：in_review 10 张卡验收、是否 push dev。

## 六、纪律声明

- 提交均落 dev（Conventional Commits 中文），未 push / 未 force-push / 未在 main-master 提交。
- 每卡改动限于卡面允许文件；批十三 2/2 V2 修复轮的 UPSTREAM_WINDOW_ALIAS_TOOLS 等改动全部在卡面文件内。
- 失败步骤均 ≤3 次/步并已记录；无任何伪造通过；清单勾选均附证据 note。
- 本轮为 round-9，共 10 份 round 文档，未达 20 轮上限；用户裁决范围内事项已全部执行完毕，后续推进依赖用户验收/授权。
