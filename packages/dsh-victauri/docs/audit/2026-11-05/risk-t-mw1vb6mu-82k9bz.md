# 残余风险自评：批七 1/1（t-mw1vb6mu-82k9bz）

> 2026-11-05，dev 分支，提交 `e6251d1`。本文件按父卡 DoD 第 14 项要求落盘。

## 已闭合项

- **C1 机制探明**：dsh-patent（@zhidal/dsh-patent 0.1.0，dist/index.js:8816-8839）代码注册模式三源交叉（npm 解包 dsh-skill 0.2.1-rc.2 类型 + 宿主 dsh-base patch 注释 + 本插件 cordis.patch.yml 同构性），已在卡评论留档。
- **C2 skill 注册实现**：src/index.ts:134-141 `ctx.skills.register({ name, description, source: 'bundled', content, invocation: { modelInvocable: true, userInvocable: true } })`，与 dsh-patent 同构；e2e 契约日志行（`registered N victauri tools`）未破坏。
- **C3 类型声明**：src/victauri-skills.d.ts 手写最小签名（lockfile 受父卡保护不能新增依赖）；返回类型已核对 dsh-skill 0.2.1-rc.2 真实签名 `register(): () => void`（解包包 lib/types/index.d.ts:257），非 Effect。
- **C4 三处图像描述**：screenshot/animation/trace 补 `%TEMP%\dsh-victauri\` 落盘 + read_image/present 指引，与 image.ts:23 `IMAGE_DIR_NAME='dsh-victauri'` 一致；contract.test.ts 锁定。
- **C5 V1 全绿**：typecheck 0 / test 16 files 184 passed / lint 0 / format:check 绿。

## 残余风险

- **R1 活体加载未验证（中）**：注册路径正确性由类型 + 单测锁定，但本会话无法重启宿主插件栈，`ctx.skills.list()` 的活体加载未实测。验证路径：宿主重载插件后在任意会话查 skill 目录是否出现 `victauri-fullstack-debug`，或跑 demo-app e2e 观察插件装载日志 `registered skill victauri-fullstack-debug`。
- **R2 手写 .d.ts 漂移（低）**：声明只对齐 0.2.1-rc.2 的 SkillRegistration 子集（缺 path/whenToUse/resourceBase/metadata）。将来若允许新增 devDependency，应删除本文件直接引用真类型；届时需删除声明防 interface 合并冲突。
- **R3 skill 内容版本漂移（低）**：SOP 按 victauri 0.10.3 口径编写（find_elements 四新参、wait_for log、route XHR fulfill 等）；上游后续版本若改语义，skill 内容需随 catalog 同步。
- **R4 同名冲突（低）**：bundled 源 rank 600；当前 skills 目录无同名 `victauri-fullstack-debug`，无冲突。若用户自建同名 user-dsh skill，registry 按 layer 优先级裁定（同层 first-wins），行为可预期。
- **R5 V2 交叉验证降级（流程）**：V2 审阅子代理连续 9 次启动失败（provider 侧路由问题），按失败重试纪律降级为 Lead 亲自核对（同构性/类型签名/内容三处参数名修正/描述与实现一致/越界检查 git status 仅 8 个本卡文件）。独立视角复核缺失，属流程性让步，已如实记录。
