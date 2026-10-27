---
'@zhidal/dsh-llm-fallback': minor
---

配置卡客户端半区重构为 TSX 组件化源码（`client/src/`：组件/hooks/纯函数分层，草稿状态收敛为单一对象），经 `scripts/build-client.ts`（esbuild）打包为惰性 CJS 注册壳 `client/index.js` 随包提交；react 改为 devDependency（运行时仍经宿主模块表注入，产物保持 external），功能、文案、样式与宿主加载契约零变化。测试从 vm 沙箱 + 源码文本 grep 迁移为纯函数直接 import + 契约断言 + jsdom 真实渲染冒烟（`FallbackCard.test.tsx`），并新增产物加载级 sanity 与 `PKG_NAME`/`ENTRY_NS` 同步防回归断言。
