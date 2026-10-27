---
'@zhidal/dsh-llm-fallback': minor
---

配置卡样式层改造为 shadcn/ui 体系（Tailwind CSS v4 + Radix 原语 + CVA）：新增 `components/ui/` 组件层（Button/Switch/Badge/Input/Checkbox/ScrollArea，交互态 hover/focus/disabled/过渡齐备），删除 `styles.ts` 内联样式对象。主题经 `@theme inline` 全量映射宿主 `--dsw-alias-*` token（明暗双模式跟随，无 `.dark` class 策略）。构建管线新增 Tailwind 编译（`@tailwindcss/cli`，granular import 禁用 preflight 防宿主 DOM 污染，`source(none)` 锁定扫描范围），产物以内联 CSS 字符串 + 运行时幂等注入 `<style data-plugin>` 交付（宿主 claimStyles/removeOwnedStyles 托管清理）；`react-dom` 加入 external 由宿主 seed 解析，构建断言防第二份 React 回归。功能、配置 schema、slots/locale 契约零变化，bundle 体积 35KB → 94KB（Radix 原语，设置卡场景可接受）。
