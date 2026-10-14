---
'@zhidal/dsh-llm-fallback': patch
---

npm 包元数据修正:显式声明 `homepage` 指向插件子目录(`…/tree/main/packages/dsh-llm-fallback#readme`)。此前包缺 `homepage` 字段,npm 发布时自动回退生成 monorepo 根目录的 `#readme` 链接,官网「Homepage」跳不到插件目录;`repository.directory` 早已正确,保持不变。新增 `src/manifest.test.ts` 防回归:断言 homepage 指向子目录、repository 带 directory、两者路径同源一致。
