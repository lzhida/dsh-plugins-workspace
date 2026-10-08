# @lzhida/dsh-nushell

Nushell 组合包:一次安装即得**完整替换形态**——`nushell` 工具 + confining 沙箱执行器,官方 bash/pwsh 家族自动停用。对齐官方 agent-team-profile 的「单包安装、patch 一次接线」模式。

## 这包里有什么

本包是**纯接线包**(无运行时逻辑),`dependencies` 拉入两个实现件,`cordis.patch.yml` 一次插入两个条目:

| 条目              | 来源                          | 职责                                                                                     |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `tool-nushell`    | `@lzhida/dsh-tool-nushell`    | 模型契约:参数校验、canonical 输出、marker 渲染、后台 job、promote 升格、系统提示 section |
| `nushell-sandbox` | `@lzhida/dsh-nushell-sandbox` | `ctx.shell` 提供方:confining 执行器(权限选择器可用)                                      |

并停用官方 `pwsh-sandbox` / `bash-sandbox` / `tool-pwsh` / `tool-bash`(完全替换)。

## 安装

仓库内开发(`packages/<name>` 子目录与 monorepo 同源):

```sh
pnpm dsh plugin --profile <name> add link:packages/dsh-nushell
```

对外安装(`@lzhida/dsh-nushell` 私有包,需走 git 子目录定位;`pnpm dsh plugin add` 底层即 `pnpm add`,以下四种 git 形式等价):

```sh
# 1) github 短形式(推荐,锁 ref + path)
pnpm dsh plugin --profile default add \
  github:lzhida/dsh-plugins-workspace#main&path:packages/dsh-nushell

# 2) git+https 全 URL
pnpm dsh plugin --profile default add \
  git+https://github.com/lzhida/dsh-plugins-workspace.git#main&path:packages/dsh-nushell

# 3) git+ssh 全 URL
pnpm dsh plugin --profile default add \
  git+ssh://git@github.com/lzhida/dsh-plugins-workspace.git#main&path:packages/dsh-nushell

# 4) 离线 tarball(先把仓库打包到本地)
pnpm dsh plugin --profile default add \
  /path/to/dsh-plugins-workspace#main:packages/dsh-nushell
```

`#main` 是发布分支;开发期可改为 `#dev` 或具体 commit/tag。子目录用 `&path:packages/<name>` 锁定,这与 taskboard README 的安装段并列四形态对齐(REF-ID `eaf19254`)。

装这一个包即可,**不要**再同时安装 `@lzhida/dsh-nushell-local` / `@lzhida/dsh-nushell-sandbox`(条目 id 冲突)。

### 装完自检

```sh
# 1) 装载契约:进程输出应出现 [dsh-tool-nushell] plugin loaded
#    与 [dsh-nushell-sandbox] sandbox shell executor module loaded
pnpm dsh plugin --profile default list

# 2) e2e 验证(需先有 dsh Web UI 在跑或允许运行器引导):
npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts \
  -- packages/dsh-nushell/src/index.ts

# 3) 浏览器级验证:
E2E_KEEP_MS=180000 npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts \
  -- packages/dsh-nushell/src/index.ts
#   打开运行器打印的 tokened URL,设置 → 插件 → 全局插件应看到
#   tool-nushell / nushell-sandbox 「已启用」,且 nushell 工具实际可调用。
```

### 常见失败点

- `nu` 不在 PATH 且 `nuPath` 未设:工具调用即报 `HarnessError`,但插件加载仍成功——属工具级失败,不是插件级;先 `nu --version` 自查。
- 同 profile 已装 `@lzhida/dsh-nushell-local` / `dsh-nushell-sandbox`:cordis 重复注册,实例启动 fail loud。先 `dsh plugin remove <冲突包>`。
- pnpm 安装报 `unmet peer` rc.1 ↔ rc.2:仓库已通过 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 集中豁免;若你装在自己机器且报这条,说明 npm 上 transitive dsh-* 子包尚未发布 rc.2,等待上游或临时在 `~/.npmrc` 加 `minimum-release-age-exclude[]=@deepseek-ai/dsh-*`。

## 组合矩阵(总览)

| 安装                               | 官方 bash/pwsh 工具 | nushell 工具 | `ctx.shell`        | permission 选择器 | 适用场景                                |
| ---------------------------------- | ------------------- | ------------ | ------------------ | ----------------- | --------------------------------------- |
| **本包**(`dsh-nushell`)            | 停用                | ✅           | nushell(confining) | ✅ 可用           | **推荐**:完全替换 + 沙箱约束 + 权限档位 |
| `tool-nushell` 单装                | 保留                | ✅           | 官方(不变)         | ✅ 可用           | 直跑模式:只想加 nushell 工具            |
| `tool-nushell` + `nushell-sandbox` | 停用                | ✅           | nushell(confining) | ✅ 可用           | 等价于本包(手动分装)                    |
| `tool-nushell` + `nushell-local`   | 停用                | ✅           | nushell(无沙箱)    | ❌ 须停用 presets | 完全替换且明确不要沙箱                  |

> 非 confining 形态(local)无法与 permission presets 组合——官方语义:presets 要求占缝执行器 confining。

## 全面替代意味着什么(以及坑在哪)

装本包或 `tool-nushell + nushell-sandbox` 走的就是「**完全替换**」——不只是「多了 nushell 一个工具」,而是把官方 shell 家族从模型可见面里**整族移除**:

1. **官方 bash/pwsh 工具不可见。** `cordis.patch.yml` 直接把 `tool-pwsh` / `tool-bash` 设为 `disabled: true`,模型在 tool 列表里再也看不到 `bash` / `pwsh`,session 启动时也不会下发 `tool:bash` / `tool:pwsh` 的 system-prompt section。任何需要 bash/PowerShell 方言的脚本、官方教程里的 `pwsh` 命令、agent 团队预设里默认带的 `bash` 工具,都会**全部消失**——这不是「可选共存」。
2. **`ctx.shell` 单一实现接缝。** 宿主 base 组合按平台挂 shell 沙箱执行器(win32=`pwsh-sandbox`,POSIX=`bash-sandbox`)。nushell 要变成 `ctx.shell` 提供方就必须独占,这就是为什么 patch 里**同时**停用 `pwsh-sandbox` / `bash-sandbox`。如果你的 profile 里同时装了多个 shell 替代方案(例如 `dsh-pwsh-local` + nushell-sandbox),cordis 在启动时会**重复注册 fail loud**——这是宿主硬约束,不是插件挑食。
3. **模型要重新学 nu 方言。** `bash` / `pwsh` 工具的 system-prompt section 没了,nushell 的 section 取而代之。模型对管道、`$env`、`error handling`、`stderr/exit` 的反射都会从 POSIX/PowerShell 切到 nu 语义;老的 bash 经验直接搬过来会写错(参见仓库 `.agents/skills/nushell-command-writing/SKILL.md`)。已在用 nushell 的会话保持不变,但新会话的「肌肉记忆」要重训。
4. **执行器仅支持 confining 形态。** 替换路径上 nushell 不暴露「无沙箱」的本地执行器选项;若同时需要 confining 与本地,只有装 `dsh-nushell-local`(独立本地包)走非 confining 形态,但 permission presets 会因此被官方要求停用——见 sandbox 包 README 的 `sandbox_permissions` / `justification` 升权通道,这是 confining 才有的逃生口。
5. **组合包互斥。** 本包与独立的 `dsh-nushell-local` / `dsh-nushell-sandbox` 共享同样的 `tool-nushell` / `nushell-sandbox` 条目 id,同 profile 二选一;想并存只能一个 profile 装组合包、另一个 profile 装直跑 `tool-nushell`。
6. **跨平台一致性。** nushell 工具统一走 `nu --no-config-file -c`,Windows / POSIX 模型契约一致;但**沙箱执行器**按宿主策略选 runner——win32 是 ACL 受限令牌,POSIX 用平台缺省。两条路径的拒绝/失败分类经 `ShellSandboxInfo` 暴露,跨平台语义一致但行为细节不同。

### 全面替代的前置检查

- 确认 `nu` 在 PATH 或显式 `nuPath` 配置可达(`candidateNuPaths`:win32 走 PATH → 常见安装点;POSIX 走 PATH);缺失时报 `HarnessError`,模型无法执行命令。
- 确认工作区路径不依赖 bash-only / pwsh-only 特性(例如 `Start-Process` / `kill -9`);改 nu 的等价写法(`job spawn` / `kill`)。
- 模型预设(agent preset)里若硬编码 `bash` / `pwsh` 工具的 system-prompt section,需要复制一份并改为 nushell;仓库里 `presets/nushell/` 已提供去 tool-bash/tool-pwsh 的副本。
- 团队习惯里若习惯 `nushell-command-writing` skill 之外的 nu 方言速查,先读一遍 `.agents/skills/nushell-command-writing/SKILL.md`(12 类 shell 场景实测校验)。

## 配置

- **工具层**(`tool-nushell` 条目):`enableRunInBackground` / `promoteOnTimeout`,见 tool 包 README;
- **执行器层**(`nushell-sandbox` 条目):`cwd` / `timeoutMs` / `maxTimeoutMs` / `maxOutputBytes` / `maxSpillBytes` / `graceMs` / `nuPath`(全字段 volatile,设置页热生效),见 sandbox 包 README。

设置 → 插件 → 对应条目即可编辑,无需重启。

## License

MIT
