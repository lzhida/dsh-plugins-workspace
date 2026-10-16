# dsh-plugins-workspace

[English](./README.en.md) | 简体中文

[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)(DeepSeek Harness)插件仓库——TypeScript + cordis 插件 monorepo。当前仅收录一个插件:[@zhidal/dsh-llm-fallback](./packages/dsh-llm-fallback/README.md)(构建式发行,入口为 esbuild 打包的 dist,已发布 [npm](https://www.npmjs.com/package/@zhidal/dsh-llm-fallback))。

> **纯 AI 开发**:本仓库的全部代码均由 AI 编码代理生成。

## 插件

### @zhidal/dsh-llm-fallback

dsh 的模型回退插件:拦截全局 LLM 调用,**会话页面指定的模型**(事实主模型)失败时,按回退队列自动切换到下一个 `provider/model`,**对话不中断**。支持每候选重试次数(`retriesBeforeSwitch`)、失败候选冷却跳过与可视化配置卡,失败码路由只按宿主稳定失败码决策。特性、原理、配置与故障排查详见 [packages/dsh-llm-fallback/README.md](./packages/dsh-llm-fallback/README.md)。

## 安装

前置:Node ≥ 22、pnpm 11、已安装 dsh。

```sh
dsh plugin add @zhidal/dsh-llm-fallback                       # npm 安装(推荐)
dsh plugin add link:<仓库绝对路径>/packages/dsh-llm-fallback  # 仓库内开发(link: 必须是绝对路径)
```

完整安装方式(npm / link / git / tarball)、`allowBuilds` 放行与安装验证见 [packages/dsh-llm-fallback/README.md](./packages/dsh-llm-fallback/README.md)。

> **新增 TS 源码入口插件时注意**:TS 源码入口(`main: "src/index.ts"`)仅支持本地 `link:`(绝对路径)安装——`link:` 相对路径按 pnpm 语义解析到 profile 目录,必败;git/npm/tarball 实体安装会被 Node 以 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 拒绝。需要实体安装必须像 dsh-llm-fallback 一样以 dist 为入口(esbuild 构建)。

## 开发

```sh
pnpm install        # 安装依赖并自动执行 lefthook install;同时触发 llm-fallback 的 prepare 构建 dist
pnpm lint           # ESLint(flat config,TS)
pnpm format         # Prettier 写入(format:check 仅校验)
pnpm typecheck      # 递归各包 tsc --noEmit
pnpm test           # Vitest,全仓 src/**/*.test.ts
```

- **构建式发行**:`@zhidal/dsh-llm-fallback` 的 `main` 指向 esbuild 打包的 `dist/index.js`(`pnpm --filter @zhidal/dsh-llm-fallback build` 单独重建)——这是宿主 Node 拒绝对 node_modules 下 `.ts` 文件做 type-stripping 时的唯一可行入口方案;
- **E2E**:无专用脚本——按 [.agents/skills/dsh-plugin-dev/SKILL.md](./.agents/skills/dsh-plugin-dev/SKILL.md) §5 的手工 CLI 流程,以独立 profile(默认 `test`)启动真实 dsh 实例;插件列表按 profile 隔离,`DSH_HOME` 共享全局 `~/.dsh`(模型凭证不隔离);断言 `[dsh-llm-fallback] plugin loaded` 加载日志、端口可达与 tokened URL 页面健康,测完 `plugin remove` 清理;
- **新增插件**:仿照 `packages/dsh-llm-fallback/package.json` 建 `packages/<name>/` 即可,`pnpm-workspace.yaml` 自动收录;`@deepseek-ai/cordis` 只放 `devDependencies` 且仅 `import type` 引入(运行时由宿主提供);
- **版本与发布**:Changesets(`pnpm changeset` → `changeset:version`)+ `{短包名}-v{X.Y.Z}` git tag 触发 npm 发布流水线,详见 [.changeset/README.md](./.changeset/README.md) 与 [scripts/release/README.md](./scripts/release/README.md);
- **提交规范**:中文 Conventional Commits;开发走 `feat/*`、`fix/*` 分支合入 `dev`,验证后合入 `main`。
- **CI**:GitHub Actions 流水线([.github/workflows/ci.yml](.github/workflows/ci.yml))在 push / PR 面向 `main`、`dev` 时运行,Ubuntu 上 Node 22 / 24 双版本执行与本地一致的 `format:check → lint → typecheck → test` 门禁链;[tests/ci-workflow.test.ts](tests/ci-workflow.test.ts) 作为配置回归测试,守护工作流引用的脚本、门禁顺序与 action 固定版本。e2e 与 npm 发布不在 CI 范围内(前者需真实 dsh 实例与凭证,后者需发布授权)。

## License

MIT
