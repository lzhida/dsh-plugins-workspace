# 官方进程外子代理（codex / claude-code）：可选接入指南

「看板模式」预设的 delegation 组内追加了两行官方 `@deepseek-ai/dsh-tool-subagent`
实例（`provider: codex` / `provider: claude-code`）。它们是**可选增强**：

- **未安装**官方提供方插件 → 这两行静默不挂载，不算失败，预设与工具清单零影响；
- **已安装** → `subagent_codex` / `subagent_claude_code` 两个委派工具自动出现，
  可作为额外的并行工位。

本文记录行集口径、启用步骤、凭证归属、限制清单与设计取舍。核实基线：
`@deepseek-ai/dsh-tool-subagent@0.2.2-rc.5`、`@deepseek-ai/dsh-subagent-codex@0.0.1-rc.1`、
`@deepseek-ai/dsh-subagent-claude-code@0.0.1-rc.1`、`@deepseek-ai/dsh-subagent@0.0.1-rc.1`
（后三者为 DSH 官方限定发布包，`publishConfig.access: restricted`）。

## 一、为什么「未安装零影响」是官方语义保证的

`dsh-tool-subagent` 的官方语义（0.2.2-rc.5 源码实读）：

- 每个委派目标挂载一个工具实例，且**每个实例的 `toolName` 必须不同**；
- 「插件在提供方存在时向所属组合注册定义，并在提供方离开时释放它」——
  **工具与其提供方同时存在、同时消失**；
- `apply()` 末段（`src/index.ts:189-193`）：先注册
  `subagent/provider-added` 事件监听，再看
  `ctx.subagents.getProvider(config.provider)`——提供方**缺失时不抛错、
  不注册工具、不算挂载失败**；提供方后到（或重启）时经事件补挂载，不悬空。

因此预设里只挂**工具行**、提供方交给宿主 profile 层，就是「可选」的全部实现：
预设行集不探测环境、不携带凭证、构建结果与「装没装官方 provider」完全无关。

## 二、预设里的两行长什么样

位置：`src/preset-def.ts` 的 delegation 组内，`tool-subagent-fork` 之后、
`workflow-ptc` 之前（同族委派实例彼此相邻）：

```ts
{
  id: 'tool-subagent-codex',
  name: '@deepseek-ai/dsh-tool-subagent',
  config: {
    provider: 'codex',
    toolName: 'subagent_codex',
    maxDepth: 'provider-managed',
  },
},
{
  id: 'tool-subagent-claude-code',
  name: '@deepseek-ai/dsh-tool-subagent',
  config: {
    provider: 'claude-code',
    toolName: 'subagent_claude_code',
    maxDepth: 'provider-managed',
  },
},
```

键位取舍（每一条都有源码依据）：

| 键                                                   | 取值                                      | 依据                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                                           | `codex` / `claude-code`                   | 官方 provider 包的固定注册名（provider 注册表同名重复注册会抛 DUPLICATE_PROVIDER）                                                                                                                                                      |
| `toolName`                                           | `subagent_codex` / `subagent_claude_code` | 官方推荐名；组内四个委派实例 toolName 互异（`subagent` / `subagent_fork` / 两个新名）                                                                                                                                                   |
| `maxDepth`                                           | `'provider-managed'`                      | 进程外提供方没有 `depthLimit` 能力，数值上限（含 Host 默认 1）会让挂载失败；官方报错原文即建议 `set maxDepth: 'provider-managed' to leave the recursion budget to the provider`；`resolveMaxDepth` 对该值返回 `undefined`（不发送上限） |
| `disabled`                                           | **不设**                                  | 见「四、设计取舍」                                                                                                                                                                                                                      |
| `modelSelection` / `modelDiscovery` / `agentOptions` | **不设**                                  | 进程外提供方缺这些能力，配了会在挂载期被 `assertSubagentProviderConfiguration` 拒绝                                                                                                                                                     |

## 三、启用步骤（装在宿主 profile 层，不改本包）

提供方插件由**用户自行安装到宿主 profile 层**；本预设**绝不**提供 provider 行（理由见四）。

### codex（OpenAI Codex CLI）

```sh
dsh plugin add @deepseek-ai/dsh-subagent-codex
```

- 走本机 PATH 上的 `codex`（`codex app-server --stdio`）；插件不安装 CLI、
  不选模型、不登录、不探测版本——**CLI 需自备**（协议基线锁 `@openai/codex@0.147.0`）。
- **API key 必须经 provider 行 config 显式提供**：子进程 seam 会移除具有凭证特征的
  环境变量，宿主环境里的 `OPENAI_API_KEY` 传不进子进程。需要在 profile 的插件行上配：

  ```yaml
  - id: subagent-codex
    name: '@deepseek-ai/dsh-subagent-codex'
    config:
      env:
        OPENAI_API_KEY: !!js process.env.OPENAI_API_KEY
  ```

  （官方推荐配方；`!!js` 从宿主环境读取，密钥不落盘到 profile 文件。）

### claude-code（Anthropic Claude Code）

```sh
dsh plugin add @deepseek-ai/dsh-subagent-claude-code
```

- 走本机 PATH 上的 `claude`（官方 Claude Agent SDK，锁
  `@anthropic-ai/claude-agent-sdk@0.3.220`）；**账号登录由 Claude Code 原生机制管理**
  （读宿主机常规用户/项目设置），插件不做登录动作；如走 API key 路线，同理在
  provider 行 `env` 里显式提供 `ANTHROPIC_API_KEY`。

### 安装后的效果

两个 provider 包自带 profile 行，会在宿主上各注册一个提供方；本预设的两行工具随即
自动挂载，看板模式会话的工具清单多出 `subagent_codex` / `subagent_claude_code`。
卸载 provider 包（或其 profile 行被移除）后工具自动释放，预设其余部分不受影响。

## 四、设计取舍（与官方 README 配方的三处偏离及理由）

1. **只挂工具行，绝不挂 provider 行。** provider 行归宿主 profile 层：
   - 若预设也挂一份 → 与宿主 profile 的提供方**重复注册**，官方注册表直接抛
     `a subagent provider named "X" is already registered`；
   - 若用户没装 provider 包 → provider 行加载失败，**整份预设**跟着失败。
     这两条都会把「可选增强」变成「必装依赖」，与目标相反。

2. **不设 `disabled: true`。** 官方 provider README 的配方把工具行默认写成
   `disabled: true`，语义是「随附 preset 携带但默认隐藏，复制 preset 后人工删除
   该字段才暴露」——那是**通用预设**的保守默认。本预设的目标相反：「装了即自动
   可用、不装零影响」，前者已由官方语义兜底，显式 `disabled` 只会制造「装了也不
   出现」的坑，故不设。

3. **省略 `enableRunInBackground`。** 官方 provider README 配方里写了
   `enableRunInBackground: false`，但该键在 `dsh-tool-subagent@0.2.2-rc.5` 的
   Config schema（zod）里**不存在**（全包 `src/lib/d.ts` grep 零命中）。写一个
   schema 不认的键零语义增益、只有未知键风险，故省略；待上游 schema 收录该键后
   再按需补回。

## 五、限制清单（启用前必读）

两个提供方都是**进程外、一次性（one-shot）**委派，与内置 spawn/fork 工位语义不同：

- **每次运行新进程、新线程、新轮次**：不支持续接 / 恢复 / 池化 / 进度流；
- **无人工审批路径**：Codex 侧无审批交互，Claude 侧 AskUserQuestion 被禁用；
- **只返回最终文本**：无输出 schema、无共享能力（子任务角色设定 / 工具筛选 /
  深度强制约束均被拒绝）；
- **CLI 本机自备**：`codex` / `claude` 须已在 PATH 且各自完成登录或配好凭证；
  插件不代装、不代登录、不探测版本；
- **无按实际时间超时、无副作用回滚**：委派出去的改动不会因会话结束而撤销；
- **发布形态**：三个相关官方包（`dsh-subagent` / `dsh-subagent-codex` /
  `dsh-subagent-claude-code`）均为 `publishConfig.access: restricted` 的**限定
  发布**包——外部环境能否直接 `dsh plugin add` 取决于该 npm scope 的访问授权，
  安装前请先确认可达性。

工作法「并行」段的对应口径（`src/context-text.ts`）也写明：官方进程外工位是
**可选**增强、只适合无共享上下文的独立小任务、未安装不影响并行工作法。

## 六、「未安装零影响」的验证面

| 层   | 断言                                                                                                | 位置                       |
| ---- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| 结构 | 行集内没有任何 `@deepseek-ai/dsh-subagent-*` provider 行（预设不带提供方，不可能重复注册/加载失败） | `src/preset-def.test.ts`   |
| 结构 | 两行无 `disabled`、`maxDepth='provider-managed'`、无进程外提供方不支持的能力键                      | `src/preset-def.test.ts`   |
| 数据 | 行集纯数据：不含 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`，构建结果与环境无关                         | `src/preset-def.test.ts`   |
| 行序 | delegation 组内 7 行 id 序列锁定（官方 5 行 + 追加 2 行）                                           | `src/preset-def.test.ts`   |
| 文案 | 「并行」段只做可选提示，断言含「可选 / 未安装 / 不受任何影响」且不含「必须安装」                    | `src/context-text.test.ts` |

行为面（真装 provider 后工具出现、真卸载后工具消失）依赖宿主 profile 与官方包运行
时，属 e2e 范围，本包未覆盖——依据是官方语义源码（见「一」），不是本仓实测。
