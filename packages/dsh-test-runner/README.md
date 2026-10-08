# @lzhida/dsh-test-runner

把 `.agents/skills/dsh-plugin-dev/scripts/test-e2e.ts` 的 e2e 编排能力拆为 5 个 `test_runner_*` agent 工具,供任意 dsh agent 在会话内调用,而非开发者手跑 shell 脚本。

## 5 步法

| 步骤 | 工具                          | 用途                                                                                        |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | `test_runner_review_profiles` | 审查 `~/.dsh/profiles/`,标记 test 用途 profile;`createIfMissing=true` 时按官方 web 模板新建 |
| 2    | `test_runner_install`         | 把被测插件装入 test profile(自动维护 cordis.patch.yml 兼容 local executor)                  |
| 3    | `test_runner_boot`            | 后台启动 `dsh web`,返回 `sessionId` + tokened URL;`ctx.effect` 卸载时强 kill                |
| 4    | `test_runner_run_assertions`  | 轮询收集三项断言(插件加载日志 / 端口可达 / tokened URL 页面),**可重复调用直到就绪**         |
| 5    | `test_runner_cleanup`         | 显式 kill 进程 + 卸载被测插件,恢复 profile 干净态                                           |

## 三种调用路径

1. **直接 CLI(开发者自跑)**:走 `npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts`,与原始 shell 脚本一致。
2. **后台 job + 浏览器接管**:用 `test_runner_boot` + 长 `timeoutMs` 让进程长跑;用浏览器/MCP 工具打开返回的 tokened URL 做真实验证。
3. **dsh agent 会话内调用**:在任意 dsh 会话中加载 `dsh-test-runner`(已 `dsh plugin add link:packages/dsh-test-runner`),模型按 5 步法串行/并发调用工具,由 system-prompt section 引导协议。

## 加载日志契约

被测插件 `apply` 时必须打印 `[<name>]` 前缀格式的日志行(如 `[dsh-taskboard] plugin loaded`)。`test_runner_run_assertions` 按结构化正则 `\[<name>\]` 匹配,避免路径/堆栈中裸包名假阳性。

## profile 隔离

profile 只隔离**插件列表**,模型凭证全局共享。本插件默认 profile 名 `e2e`,默认端口 3865(3080 是上游默认,3865 是本机现状产物);可通过 `TEST_RUNNER_PROFILE` / `TEST_RUNNER_PORT` / `TEST_RUNNER_TIMEOUT_MS` 覆盖。

**不要在 default profile 上跑 e2e** — 会污染用户当前会话。工具描述里硬编码了此警告。

## 清理义务

`test_runner_cleanup` 必须显式调用,否则后台 web 与被测插件会残留进后续会话。`ctx.effect` 卸载时作为兜底强 kill,但不卸载被测插件。

## 实现边界

- **纯逻辑**(端口检测 / 补丁层剥离 / token 解析 / 超时预算)下沉到 `src/lib.ts`,27 个 vitest 覆盖。
- **副作用**(spawn dsh / 读 `~/.dsh` / 写 cordis.patch.yml)封装在 `src/runner.ts`,经 `defineTool` 暴露给 dsh agent。
- 命名 `tool:test-runner`,`order: 2850`(TOOL_REPORT 2900 与 TOOL_SUBAGENT 2800 之间的空档)。

## 安装

```sh
# 仓库内开发
pnpm dsh plugin --profile e2e add link:packages/dsh-test-runner

# 外部安装(github 子路径)
pnpm dsh plugin --profile e2e add github:lzhida/dsh-plugins-workspace#dev&path:packages/dsh-test-runner
```

## 配套 skill

- `.agents/skills/dsh-plugin-dev/SKILL.md` 的 §5bis 段:agent 自驱测试流程 + 三种调用路径示例 + DoD 审计清单。
