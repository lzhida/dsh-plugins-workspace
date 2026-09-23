# 运行器参数与浏览器对接

## 启动命令（仓库根目录）

```sh
E2E_KEEP_MS=1200000 E2E_RELEASE_FILE=/tmp/nushell-chat-e2e.release \
  npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts -- \
  packages/dsh-tool-nushell/src/index.ts \
  packages/dsh-nushell-local/src/index.ts \
  packages/dsh-guided-goal/src/index.ts
```

- 长时间运行：放后台执行，轮询输出拿 tokened URL
- 必须用 `--` 透传插件入口列表（pnpm 11 会把 `--` 字面量透传，运行器自行过滤）
- 插件组合：tool（模型契约）+ local（执行器）两个；`dsh-guided-goal` 不入组合（Web client 集成需构建产物，见 SKILL.md）

## 关键环境变量

| 变量 | 语义 |
| --- | --- |
| `E2E_KEEP_MS` | 断言通过后保活窗口；对话测试设 ≥ 20 分钟（goal 执行 12 项耗时数分钟） |
| `E2E_RELEASE_FILE` | 设置后保活改为「文件出现即收尾」（KEEP_MS 仍是硬上限） |
| `E2E_PORT` | 默认 3865；占用时运行器预检直接退出，先查 `ss -tlnp` |
| `E2E_TIMEOUT_MS` | 启动断言超时（默认 180000）；首次引导 profile 建议 300000 |

## 流程时序

1. 首次运行自动从官方 web 模板引导 `e2e` profile（约 30-60s）
2. **自动写入 profile patch 层**：禁用 `permission` presets（被测 local 执行器非禁闭，组合互斥，不禁用 web 启动即崩）
3. `dsh plugin add link:<包目录>` 装入插件（bundle patch 自动激活）
4. 启动 web → 断言：`[dsh-tool-nushell]`/`[dsh-nushell-local]` 加载日志 + 端口可达 + tokened URL 可访问
5. 打印 `[e2e] ✓ 捕获插件加载日志` 与 tokened URL → 进入保活（释放文件模式轮询）
6. 浏览器完成对话测试后：`touch $E2E_RELEASE_FILE` → 运行器杀进程树、卸载插件、恢复 profile

**手动运行等价路径**（运行器保活窗口的调试替代）：`hub start` 常驻 `pnpm dsh --profile e2e --no-open --port 3865`，`hub logs` 实时取 tokened URL 与崩溃输出——首次排障（如组合崩溃）时优先用这条路径定位。

## 浏览器对接（Edge 为准，MCP 可用性视环境）

- Edge 路径：`/usr/bin/microsoft-edge-stable`（Windows 下为 `msedge.exe`）
- 首选 chrome devtool MCP；**已知环境约束**：MCP 的 `executablePath` 固定指向 `/usr/bin/chromium`，不存在时 MCP 不可用（报 `Browser was not found`）——修复需装 chromium / 改 MCP 配置 / root 软链，超出本 skill 权限
- **降级路径（已验证可行）**：用会话内 browser 工具指定 `app.path = /usr/bin/microsoft-edge-stable` 驱动真实 Edge，能力等价（打开 URL、observe、snapshot、evaluate、截图）
- tokened URL 带鉴权 token，直接打开即登录，无需额外认证步骤

## 激活确认（Web UI）

设置 → 插件 → 插件列表 → 「全局插件」分组：`dsh-tool-nushell`、`dsh-nushell-local`、`dsh-guided-goal` 三项均显示「已启用」。

## 清理验证

收尾后确认：

- 运行器输出 `[e2e] ✓ 已卸载被测插件,profile 恢复干净态`
- 无残留进程：`pgrep -f "dsh --profile e2e"` 为空
- `<BASE_DIR>` 临时目录删除（goal 执行产物在系统临时目录，可留待系统清理，但主动删更干净）
