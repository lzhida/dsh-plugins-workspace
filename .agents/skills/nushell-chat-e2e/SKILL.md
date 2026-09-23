---
name: nushell-chat-e2e
description: 对话级 e2e 测试 dsh nushell 工具——真实 dsh Web UI 独立 profile 启动、确认插件接入激活、浏览器发送单句 goal 对话（12 类 shell 场景、对话不出现 nushell 字样）、机械审查应答。当需要端到端验证 nushell 工具真实可用性、跑 goal 对话测试、或审查 dsh 会话应答内容时使用。
---

# nushell 工具对话级 e2e 测试

比「加载级别」e2e 更进一步：真实 dsh + 真实模型凭证 + 浏览器驱动对话，验证模型会在合适时机调用 nushell 工具且执行结果正确。

## 流程总览（5 步）

1. **启动**：运行器拉起真实 dsh（独立 `e2e` profile，插件装入 profile 层），拿 tokened URL
2. **激活确认**：浏览器打开 Web UI → 设置 → 插件 → 「全局插件」分组目标插件显示「已启用」
3. **对话**：聊天框发送**单句** goal 对话（`/guided-goal` + 12 项场景要求，全文不出现 "nushell"）
4. **收集**：等 goal 自主执行完毕（输出总结），snapshot/截图采集应答与工具调用痕迹
5. **审查**：按 12 项清单逐条机械比对，输出审查表

## 快速命令

```sh
# 启动（仓库根目录；保活到释放文件出现，硬上限 20 分钟）
E2E_KEEP_MS=1200000 E2E_RELEASE_FILE=/tmp/dsh-shell-e2e.release \
  npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts -- \
  packages/dsh-tool-nushell/src/index.ts \
  packages/dsh-nushell-local/src/index.ts
```

- **组合只装 2 个插件**：tool（模型契约）+ local（执行器）。`dsh-guided-goal` 暂不入组合——其 manifest 声明 `client` Web 集成，要求可导入的 client 产物，而本仓插件是免构建 TS 源码，Web 端打包会报 `failed to import loader entry … client-modules`（页面顶部横幅报错）。对话级测试用 dsh 官方 `/goal` 命令承载 goal 能力，效果等价
- 运行器自动在 profile patch 层禁用 `permission` presets（local 执行器按设计非禁闭，与 presets 组合互斥，不禁用则 web 启动即崩）
- tokened URL 从 `dsh web: http://...` 行取（保活窗口内自动等待并打印）
- 测试完成后 `touch $E2E_RELEASE_FILE`，运行器自动卸载插件、杀进程树、恢复 profile
- 浏览器方案：chrome devtool MCP + Edge（`/usr/bin/microsoft-edge-stable`）

## 详细参考（写 goal 对话前必读对应文件）

| 文件 | 内容 |
| --- | --- |
| [references/scenarios.md](references/scenarios.md) | 12 类场景定义与硬校验期望值 |
| [references/conversation-template.md](references/conversation-template.md) | 单句 goal 对话模板与构造规则（禁词、五字段齐备跳过访谈） |
| [references/review-protocol.md](references/review-protocol.md) | 证据采集方式、逐条判定规则、失败分类、报告格式 |
| [references/runner.md](references/runner.md) | 运行器参数、浏览器对接细节、清理验证 |

## 硬性规则

- 对话内容**禁止出现 "nushell" 字样**——工具选择必须由模型的系统提示驱动，这是被测能力本身
- 12 项场景**集成在一句对话中**发送（`/guided-goal 1.xxx; 2.xxx; …` 格式）
- 期望值必须是硬校验值（如求和 = 55），拒绝「看起来对」的主观判断
- 审查必须有会话内证据（工具调用痕迹 + 结果文本），不允许只看最终总结
