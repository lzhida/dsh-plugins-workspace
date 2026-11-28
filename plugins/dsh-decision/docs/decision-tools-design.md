# 决策工具插件行 · 设置页设计稿

> 版本：v1.0.0（定稿）
> 日期：2026-11-27
> 适用范围：`plugins/dsh-decision` 组合包内新增的 `decision-tools` 插件行（十工具 + react + shadcn 设置页）
> 契约来源：本文件 + 同目录 [`decision-tools-contract.md`](./decision-tools-contract.md)（两者为 2/11–11/11 卡的唯一契约来源）
> 上游事实来源：`ui-ux-pro-max` skill（design_recommend / design_review / design_search）与宿主 `packages/client/ui-theme/src/styles/design-platform.css`（`--dsw-alias-*` token 定义处）

---

## 1. 设计目标与硬约束

| #   | 目标                            | 判定口径                                                          |
| --- | ------------------------------- | ----------------------------------------------------------------- |
| G1  | 设置页与 dsh 宿主控制台视觉一致 | 所有色值取自 `--dsw-alias-*`，文档与代码零硬编码色值              |
| G2  | 深浅两态各自可用                | 明暗由宿主切换，插件零 `.dark` 变体、零主题判断代码               |
| G3  | react + shadcn/ui 实现          | 组件走 shadcn 语义 token，主题层 `@theme inline` 映射到宿主 token |
| G4  | 配置面即功能面                  | 模型接口未配置/未验证时，页面上明示「功能不可用」，不留静默失败   |
| G5  | 十工具开关可见可控              | 十个开关全部暴露在设置页，默认关闭                                |
| G6  | 预算与兜底可解释                | 燃尽率/置信门控阈值在页面上有解释文案，不裸露裸数字               |

### 硬约束（不可协商）

- **C1 零硬编码色值**：颜色只允许出现在 `--dsw-alias-*` 引用处；宿主静态色板 `--dsw-static-*` **不得**直接引用（那是宿主的原始调色板，跨主题语义不对）。
- **C2 零 `.dark` 类**：宿主的明暗切换是 `body[data-ds-dark-theme]` 属性（`design-platform.css:253`），不是 class。插件 CSS 不定义 `.dark` 变体，也不写 `matchMedia('(prefers-color-scheme)')`。
- **C3 零 preflight**：不引入 tailwind preflight（会 reset 宿主页面全局样式）。沿用 `plugins/dsh-llm-fallback/client/src/theme.css` 的 `@layer theme, base, components, utilities` + `source(none)` 写法。
- **C4 语义令牌唯一来源**：组件样式只引用 shadcn 语义变量（`--color-*`），由 `@theme inline` 一对一映射到 `--dsw-alias-*`；组件代码里不出现色值。
- **C5 双语文案**：所有文案走 `dict.ts` 双语字典（namespace 与包内其它行统一），不在组件里写死中文。

---

## 2. 风格选型（design_recommend 结论与裁剪）

检索：`design_recommend(query="开发者工具 设置面板 控制台 深浅主题 开关 仪表盘", stack=shadcn, variance=4, motion=3, density=7)`

| 维度       | 推荐结论                                                                                                                                       | 本页采纳                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 产品类别   | Developer Tool / IDE                                                                                                                           | ✅ 完全一致                                                                   |
| 首选风格   | Modern Dark（Cinema Mobile），浅色 supported / 深色 supported                                                                                  | ⚠️ 取「结构」不取「氛围」：密集分区、弱装饰、状态清晰                         |
| 配色       | 深空蓝主色 + 绿色强调 + 深底卡片 + 高对比危险色                                                                                                | ✅ 全部映射到 `--dsw-alias-*`（见 §3）                                        |
| 字体       | Inter                                                                                                                                          | ❌ 裁剪：字体族由宿主提供，插件不覆盖 `font-family`（避免与宿主排版体系冲突） |
| 间距刻度   | 4 / 8 / 16 / 24 / 32 / 48 / 64                                                                                                                 | ✅ 采纳 4/8dp 双刻度（宿主无间距 token，见 §4）                               |
| 技术栈规范 | 深色支持：`:root` + `.dark` 完整语义方案；颜色用 CSS 变量，禁硬编码 palette                                                                    | ⚠️ 改写：宿主深色是属性选择器，插件不写 `.dark`；「禁硬编码」原样采纳         |
| UX 规范    | Text Reflow and Spacing（流体尺寸、无单位行高）；Compact Control Semantics（用 button 并暴露 pressed/selected）；Color Contrast（正文 ≥4.5:1） | ✅ 三条全采纳                                                                 |
| 反模式     | Light mode default、Slow performance                                                                                                           | ✅ 规避：深色不是默认、零重动画                                               |

### 2.1 被裁剪项及原因（design_recommend 通用风格库 → dsh 宿主控制台）

| 推荐项                                           | 处置 | 原因                                                                                                                       |
| ------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| ambient blobs / 渐变光晕                         | 裁剪 | 宿主设置卡是高频读数面板，装饰性背景降低文字对比与扫读效率                                                                 |
| BlurView / 玻璃拟态                              | 裁剪 | 宿主 token 无「模糊」语义；玻璃态在浅色底下透出宿主页面内容，对比不可控                                                    |
| Haptic / Bottom sheets / React Native Reanimated | 裁剪 | 本设置页是 Web 侧栏卡，无移动端手势层与导航层                                                                              |
| 大圆角（16px 级）+ LinearGradient 主按钮         | 降级 | 宿主面板密度高（density=7），圆角收敛到 4/8px；主按钮必须由 `brand-primary` 决定，渐变会与深浅两态的「反色主按钮」逻辑冲突 |
| 强调绿直写                                       | 映射 | 改用 `--dsw-alias-state-success-primary`，保留语义（成功）而非色相                                                         |
| Inter 字体直写                                   | 裁剪 | 宿主已定义排版体系，插件覆盖会与消息区/插件区不一致                                                                        |
| 图表库（Plotly / D3 / ApexCharts）               | 裁剪 | 预算燃尽率用原生 CSS/SVG bullet 绘制，不引图表依赖（包体与宿主 CSP 双约束）                                                |
| 移动端底部抽屉式设置导航                         | 裁剪 | 宿主已提供 PackageDetail 页导航，插件只提供「配置卡」内容                                                                  |

---

## 3. Token 映射表（色值 → `--dsw-alias-*`，深浅两态）

宿主 token 定义：`packages/client/ui-theme/src/styles/design-platform.css`
浅色段 `:157-247`（`body {}`）、深色段 `:254-345`（`body[data-ds-dark-theme] {}`）。
下表「浅色解析」「深色解析」列给出宿主 token 在两态下的**解析结果说明**，仅用于说明宿主取值行为，插件代码与本文档**均不写任何色值字面量**（无十六进制、无 `rgb()`/`rgba()`、无颜色名色值）；表中的「黑 12% α」「白 6% α」是透明色的**文字化描述**，不是可直接使用的色值。

### 3.1 语义角色映射（shadcn 语义变量 → 宿主 token）

| shadcn 语义变量                  | 宿主 `--dsw-alias-*`                   | 浅色解析            | 深色解析            | 用途                         |
| -------------------------------- | -------------------------------------- | ------------------- | ------------------- | ---------------------------- |
| `--color-background`             | `--dsw-alias-bg-layer-1`               | neutral-bluish-00   | neutral-bluish-875  | 配置卡底色                   |
| `--color-foreground`             | `--dsw-alias-label-primary`            | neutral-bluish-1000 | neutral-bluish-50   | 主文字                       |
| `--color-surface`                | `--dsw-alias-bg-layer-2`               | neutral-bluish-00   | neutral-bluish-850  | 分组/次级区块底              |
| `--color-muted`                  | `--dsw-alias-bg-layer-3`               | neutral-bluish-00   | neutral-bluish-800  | 三级区块底（行 hover 底）    |
| `--color-muted-foreground`       | `--dsw-alias-label-secondary`          | neutral-bluish-700  | neutral-bluish-300  | 次要文字                     |
| `--color-secondary-foreground`   | `--dsw-alias-label-tertiary`           | neutral-bluish-600  | neutral-bluish-400  | 三级文字/单位后缀            |
| `--color-primary`                | `--dsw-alias-brand-primary`            | neutral-bluish-1000 | neutral-bluish-50   | 品牌主色（深浅两态互为反色） |
| `--color-primary-hover`          | `--dsw-alias-button-primary-hover`     | neutral-bluish-750  | neutral-bluish-100  | 主按钮悬停                   |
| `--color-primary-foreground`     | `--dsw-alias-label-primary-foreground` | neutral-bluish-00   | neutral-bluish-1000 | 主按钮前景                   |
| `--color-accent`                 | `--dsw-alias-interactive-bg-hover`     | 深蓝黑 6% α         | 白 8% α             | 行悬停/次按钮底              |
| `--color-accent-foreground`      | `--dsw-alias-label-primary`            | neutral-bluish-1000 | neutral-bluish-50   | 悬停态前景                   |
| `--color-destructive`            | `--dsw-alias-state-error-primary`      | red-600             | red-400             | 危险动作/错误主色            |
| `--color-destructive-foreground` | `--dsw-alias-label-primary-foreground` | neutral-bluish-00   | neutral-bluish-1000 | 危险按钮前景                 |
| `--color-border`                 | `--dsw-alias-border-l1`                | 黑 4% α             | 白 6% α             | 卡片描边                     |
| `--color-border-strong`          | `--dsw-alias-border-l2`                | 黑 10% α            | 白 12% α            | 输入框描边                   |
| `--color-input`                  | `--dsw-alias-border-l2`                | 黑 10% α            | 白 12% α            | 输入框边框                   |
| `--color-ring`                   | `--dsw-alias-brand-primary`            | neutral-bluish-1000 | neutral-bluish-50   | focus-visible 焦点环         |
| `--color-link`                   | `--dsw-alias-link`                     | deepseek-500        | deepseek-400        | 链接                         |
| `--color-success`                | `--dsw-alias-state-success-primary`    | green-500           | green-500           | 验证通过                     |
| `--color-success-soft`           | `--dsw-alias-state-success-tertiary`   | green-100           | green-900           | 成功徽标弱底                 |
| `--color-warning`                | `--dsw-alias-state-warn-primary`       | amber-500           | amber-500           | 预算临近/需注意              |
| `--color-warning-label`          | `--dsw-alias-state-warn-label`         | amber-600           | amber-600           | 警告文案（浅底可读）         |
| `--color-warning-soft`           | `--dsw-alias-state-warn-tertiary`      | amber-100           | amber-900           | 警告徽标弱底                 |
| `--color-overlay`                | `--dsw-alias-bg-overlay`               | neutral-bluish-150  | neutral-bluish-700  | 浮层底                       |
| `--color-tooltip`                | `--dsw-alias-tooltip-bg`               | neutral-bluish-850  | neutral-bluish-750  | 提示条底                     |

### 3.2 宿主 token → 用途补充映射（非 shadcn 语义层，直接引用）

| 宿主 token                                | 用途                         | 浅色解析           | 深色解析           |
| ----------------------------------------- | ---------------------------- | ------------------ | ------------------ |
| `--dsw-alias-bg-base`                     | 页面最底层（若插件需要铺底） | neutral-bluish-00  | neutral-bluish-950 |
| `--dsw-alias-bg-module-platform`          | 平台模块底（设置卡容器）     | neutral-bluish-60  | neutral-bluish-800 |
| `--dsw-alias-border-l3`                   | 强调分隔线/活动边框          | 黑 12% α           | 白 16% α           |
| `--dsw-alias-border-l4`                   | 最强分隔（禁用态描边）       | 黑 16% α           | 白 20% α           |
| `--dsw-alias-interactive-bg-active`       | 选中/激活行底                | 深蓝黑 10% α       | 白 14% α           |
| `--dsw-alias-interactive-bg-hover-danger` | 危险行悬停底                 | 红 5% α            | 红 15% α           |
| `--dsw-alias-button-elevated-fill`        | 次级按钮底                   | neutral-bluish-00  | neutral-bluish-750 |
| `--dsw-alias-button-floating-hover`       | 次级按钮悬停                 | neutral-bluish-75  | neutral-bluish-800 |
| `--dsw-alias-button-ghost-active-fill`    | 幽灵按钮选中底               | neutral-bluish-100 | neutral-bluish-750 |
| `--dsw-alias-button-ghost-active-hover`   | 幽灵按钮悬停底               | neutral-bluish-150 | neutral-bluish-700 |
| `--dsw-alias-button-info-fill`            | 信息按钮底（验证按钮）       | deepseek-500       | deepseek-400       |
| `--dsw-alias-button-info-hover`           | 信息按钮悬停                 | deepseek-400       | deepseek-500       |
| `--dsw-alias-label-caption`               | 弱化说明文字                 | neutral-bluish-400 | neutral-bluish-600 |
| `--dsw-alias-label-dimmed`                | 占位符/禁用文字              | neutral-bluish-200 | neutral-bluish-750 |
| `--dsw-alias-state-error-secondary`       | 错误次级（图标）             | red-400            | red-400            |
| `--dsw-alias-state-business-primary`      | 业务强调（预算燃尽率正常段） | deepseek-500       | deepseek-400       |
| `--dsw-alias-bg-skeleton`                 | 加载骨架                     | 黑 4% α            | 白 8% α            |
| `--dsw-alias-scrollbar-bg-l1`             | 滚动条底                     | neutral-200        | neutral-bluish-700 |

### 3.3 深浅两态差异说明

1. **切换机制**：宿主以 `body[data-ds-dark-theme]` 属性切换（`design-platform.css:253`）。插件不感知主题、不写 `.dark`、不做主题状态订阅 —— 明暗切换是**零延迟**的（CSS 变量重算，无 JS 参与）。
2. **品牌色反相**：浅色态 `brand-primary` = 近黑（neutral-bluish-1000），深色态 = 近白（neutral-bluish-50）。因此主按钮在两态都是「反色块 + 反色前景」，前景统一用 `--color-primary-foreground`（浅色=白字黑底，深色=黑字白底）。**不要**把主按钮写成固定蓝底，否则深浅两态都会掉对比。
3. **层级靠底色而非边框**：浅色态 `border-l1` 仅 4% 不透明度，层级差几乎不可见 → 浅色态靠 `bg-layer-1 / layer-2 / layer-3` 的白→灰（`bg-module-platform` = neutral-bluish-60）拉开；深色态底色本身就是三级递进（875 / 850 / 800），边框只做收边。
4. **危险色亮度补偿**：错误色浅色态用 red-600、深色态用 red-400（宿主已做），保证深色底下红字对比达标；错误徽标底用 `state-error-secondary` + 文字用 `label-primary` 双通道，颜色不作为唯一信息指示。
5. **警告标签**：浅色态用 `state-warn-label`（amber-600）而非 amber-500，浅底上文字对比更稳；深色态同值。
6. **边框在两态都可见**：输入框一律 `border-l2`（浅 10% / 深 12%），不使用 `border-l1` 做输入框边界。

---

## 4. 间距 / 圆角 / 字体 / 动效刻度

> **偏差声明（须知）**：宿主 `design-platform.css` 经 grep 实证 **未定义任何间距 / 圆角 / 字体 token**（`--dsw-(alias-)?(space|radius|font|text)-` 零命中），只有颜色与状态 token。因此：
>
> - **色值**：一律映射 `--dsw-alias-*`（§3，满足硬约束 C1/C4）；
> - **间距 / 圆角**：采用插件自有 CSS 变量 `--dt-space-*` / `--dt-radius-*`，建立在 design_recommend 推荐的 4/8dp 双刻度上，**不硬编码色值**，且与宿主面板密度一致。
>   这是有意为之的取舍：把间距挂到不存在的 `--dsw-alias-space-*` 上会产出永远解析为空的值，属于假映射。

| 变量                | 值                             | 用途                                               |
| ------------------- | ------------------------------ | -------------------------------------------------- |
| `--dt-space-1`      | 4px                            | 图标与文字间隙、徽标内边距                         |
| `--dt-space-2`      | 8px                            | 字段内间距、按钮组间隙                             |
| `--dt-space-3`      | 12px                           | 行间距                                             |
| `--dt-space-4`      | 16px                           | 字段间距、分区内边距                               |
| `--dt-space-6`      | 24px                           | 分区间距                                           |
| `--dt-space-8`      | 32px                           | 大分区留白                                         |
| `--dt-radius-sm`    | 4px                            | 输入框、徽标、Switch                               |
| `--dt-radius-md`    | 6px                            | 按钮、卡片                                         |
| `--dt-radius-lg`    | 8px                            | 浮层、面板                                         |
| `--dt-font-size-xs` | 12px                           | 弱化说明、表格辅助列                               |
| `--dt-font-size-sm` | 13px                           | 次要文字、开关 hint                                |
| `--dt-font-size-md` | 14px                           | 正文、输入框                                       |
| `--dt-font-size-lg` | 16px                           | 分区标题                                           |
| `--dt-line-height`  | 1.5（无单位）                  | 全部文本（design_recommend：unitless line-height） |
| `--dt-motion-fast`  | 120ms                          | 按压反馈（规范要求 80–150ms）                      |
| `--dt-motion-base`  | 200ms                          | 微交互（规范要求 150–300ms）                       |
| `--dt-motion-ease`  | `cubic-bezier(0.2, 0, 0.2, 1)` | 统一缓动                                           |
| `--dt-touch-min`    | 24px                           | 最小可点区域（web 按 WCAG 2.5.8，不用移动端 44px） |

---

## 5. 组件清单

设置页 = 一个**配置卡**（注册进宿主 `plugins.bundle.config` 插槽，key = `@zhidal/dsh-decision`），卡内 5 个分区。

### A 区 · 模型连接（systemone 决策接口）

| #   | 组件     | 类型                      | 说明                                                                                                |
| --- | -------- | ------------------------- | --------------------------------------------------------------------------------------------------- |
| A1  | Base URL | Input                     | 占位 `http://127.0.0.1:3425`，下方只读展示最终端点 `POST {baseUrl}/v1/systemone`（避免用户猜路径）  |
| A2  | API Key  | Input(type=password)      | 密码字段，附「显示/隐藏」图标按钮（必须有可访问名）。不回显、不入日志、不入账本                     |
| A3  | 模型 ID  | Input                     | 例 `ollama-r5/kev-4b`；附说明「决策模型名，非宿主会话模型」                                         |
| A4  | 超时     | NumberInput               | 毫秒，1000–300000，步进 1000                                                                        |
| A5  | 验证连接 | Button(info) + 状态 Badge | 触发一次最小决策探测（1 条 noul 题）；状态机见 §6.1                                                 |
| A6  | 端点说明 | 静态文本                  | 说明本接口是**专用决策端点**，不是 chat completions；载荷 `{model,state,questions}`，响应 `answers` |
| A7  | 错误摘要 | `role="alert"` 容器       | 验证失败时置顶展示，含可操作建议（检查 key / 检查模型名 / 检查服务存活）                            |

### B 区 · 工具开关（十个）

| #   | 组件        | 说明                                                                                                                                                  |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | 十个 Switch | 每行 = 标签 + 一句 hint（说明该工具用途与是否需要模型）+ 右侧 Switch（`aria-label` 同标签）；十个开关**默认全部关闭**                                 |
| B2  | 分组小标题  | 按职责分三组：「判定与守卫」（decide / gate / rerank / batch / locate）、「追溯与审计」（usage / history / recheck / calibrate）、「仲裁」（arbiter） |
| B3  | 关闭提示    | 全部关闭时提示「所有工具均已关闭，插件功能不可用」                                                                                                    |
| B4  | 纯本地标记  | usage / history / calibrate 三者标注「不需要模型」，与需模型的开关视觉区分（用 `state-business-tertiary` 弱底 tag，不用颜色区分唯一信息）             |

### C 区 · 预算与成本

| #   | 组件                                    | 说明                                                                                                                         |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| C1  | 启用硬预算                              | Switch                                                                                                                       |
| C2  | 日调用上限 / 日 token 上限 / 日成本上限 | 三个 NumberInput；上限为 0 视为不限                                                                                          |
| C3  | 费率（每 1K 输入 / 输出 token）         | 两个 NumberInput；**默认 0**（本地模型不计费），非 0 时页面标注「估算口径」                                                  |
| C4  | 燃尽率                                  | 原生 CSS/SVG **bullet chart**：一段量条 + 目标刻度标记 + 文字标注「已用 X / 预算 Y（Z%）」；纯色不可单独承载信息，必须带文字 |
| C5  | 周期                                    | 每日 UTC 0 点重置（可配小时）                                                                                                |

### D 区 · 兜底级联

| #   | 组件                  | 说明                                                                                               |
| --- | --------------------- | -------------------------------------------------------------------------------------------------- |
| D1  | 启用兜底              | Switch                                                                                             |
| D2  | 裁判模型              | provider / model 两个 Input；留空 = 「使用会话当前模型」，并注明「会话模型不可用时该路径直接报错」 |
| D3  | 置信度门控阈值        | Slider/NumberInput，0.05–1，步进 0.05；旁附一句解释「低于该值判定为拿不准」                        |
| D4  | 生效模式              | Select：`auto-fallback` / `explicit-arbiter` / `both`                                              |
| D5  | 兜底超时 / 日调用上限 | 两个 NumberInput，防裁判滥用                                                                       |

### E 区 · 账本与统计

| #   | 组件     | 说明                                                                                   |
| --- | -------- | -------------------------------------------------------------------------------------- |
| E1  | 账本路径 | 只读文本（默认 `<DSH_HOME>/plugins/dsh-decision/ledger.jsonl`）                        |
| E2  | 最大条数 | NumberInput（滚动淘汰上限）                                                            |
| E3  | 统计概览 | calls / tokens / 成本 / 延迟 p95 / 燃尽率，五项各配一行「标签 + 数值」，数值用等宽数字 |
| E4  | 清空账本 | Button(destructive) + 二次确认（弹层确认，不直接删）                                   |

---

## 6. 状态与交互

### 6.1 验证状态机

```
[unverified] --点击验证--> [verifying] --成功--> [verified]
                                  |--失败--> [failed] --可重试--> [verifying]
[verified] --baseUrl/apiKey/model 任一变更--> [unverified](标记 stale)
```

- `verifying` 期间：验证按钮禁用并显示 spinner，**不**阻塞表单其它字段编辑。
- `failed`：Badge 用 `state-error-primary`，附错误码（如 `model-verify-failed`）与建议动作。
- `verified`：Badge 用 `state-success-primary` + `state-success-tertiary` 弱底，显示验证时间。
- 验证请求内容：1 条 noul 题的最小探测请求（不含用户业务数据）。

### 6.2 脏检查与保存

- 沿用 `plugins/dsh-llm-fallback/client/src/lib/settings.ts` 四件套：`readSavedSettings` / `beginDraft` / `resolveView` / `isDirty` / `buildMutations`。
- 保存走 `scope.mutate([{ op: 'set', path: ['字段名'], value }], revision)`，path 为**字符串数组**。
- revision 不一致 → 映射 `SETTINGS_CONFLICT`，提示「配置已在别处变更，请重新载入」，**不静默覆盖**。
- 提交失败**保留用户已填值**（含密文字段留空），只标记需要修改的字段；**禁止 `form.reset()`**。

### 6.3 表单校验

- **on blur** 校验（不只在提交时校验）。
- 每个输入有**可见 label**（label 在上），并带 `accessibilityLabel`；**禁止 placeholder-only**。
- 错误信息具体可操作（例如「Base URL 不能为空，填 `http://127.0.0.1:3425` 这类地址」），不只标红。
- 校验失败时错误摘要置顶（`role="alert"`, `tabindex="-1"`），焦点移到摘要标题，每条摘要链到对应字段；inline 错误同时保留。

### 6.4 无障碍清单（design_review + design_search 命中项）

| #       | 要求                                                                | 严重度来源                                |
| ------- | ------------------------------------------------------------------- | ----------------------------------------- |
| A11y-1  | 每个输入有可见 label + accessibilityLabel                           | 严重（Accessibility Form Control Labels） |
| A11y-2  | 图标按钮（显示/隐藏 key、清空、更多）有可访问名                     | 严重（Accessibility Icon Button Labels）  |
| A11y-3  | 可点区域 ≥ 24×24 CSS px（web 按 WCAG 2.5.8）                        | 严重（Touch Target Size）                 |
| A11y-4  | 失败提交保留已填输入，只标需改字段                                  | 高（Preserve Input After Failed Submit）  |
| A11y-5  | 错误摘要置顶 + 焦点转移 + 字段链接                                  | 高（Focusable Error Summary）             |
| A11y-6  | 异步状态徽标用 `role="status" aria-atomic="true"`，播报有语义的整句 | 高（Contextual Live Badge Updates）       |
| A11y-7  | 正文对比度 ≥4.5:1，次要文字 ≥3:1（浅色与深色各自达标）              | 严重（Color Contrast）                    |
| A11y-8  | 颜色不是唯一信息指示（状态同时有图标/文字/位置）                    | 通用清单                                  |
| A11y-9  | `focus-visible` 焦点环可见（`--color-ring`）                        | 通用清单                                  |
| A11y-10 | 禁用态语义清晰（`disabled` 属性 + 说明文案，非仅灰化）              | 通用清单                                  |
| A11y-11 | 禁 emoji 当结构图标；图标同族                                       | 通用清单                                  |
| A11y-12 | `cursor: pointer` 于可点元素                                        | 通用清单                                  |
| A11y-13 | 组合式取数并行（不串行 await）                                      | 严重（Server Parallel Fetching）          |

### 6.5 图表口径（预算燃尽率）

- 用 **Bullet Chart**（design_search 命中：「Performance vs Target (Compact)」）：一段量条 + 目标刻度线 + 文字标注。
- 颜色规范仅作参照，**实际取自 `--dsw-alias-state-business-primary` / `state-warn-primary` / `state-error-primary`** 三档，并与文字「正常 / 临近 / 超限」同时出现。
- 无障碍降级：图表下方必须有「指标 + 数值」文本行，颜色不单独承载信息。

---

## 7. 与 `dsh-llm-fallback` client 的复用与差异

| 复用项        | 来源                               | 说明                                                                                                                                                                                                     |
| ------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主题注入机制  | `client/src/theme.ts`              | `<style data-plugin=PKG_NAME data-plugin-css=PLUGIN_NAME>`，宿主 `claimStyles` 认领，幂等键 `data-plugin-css`                                                                                            |
| 主题 CSS 骨架 | `client/src/theme.css`             | `@layer theme, base, components, utilities` + `source(none)` + 禁 preflight + 不引 `.dark`                                                                                                               |
| 配置卡注册    | `client/src/plugin.tsx`            | `ctx.configForms.get(ENTRY_NS)` → `ctx.slots.inject(CONFIG_SLOT, ...)` 注册 `plugins.bundle.config` 卡                                                                                                   |
| 设置读写      | `client/src/lib/settings.ts`       | 四件套纯函数 + `buildMutations`                                                                                                                                                                          |
| 控件          | `client/src/components/fields.tsx` | `SwitchRow` / `NumberRow`；shadcn 组件现存 7 件（badge/button/checkbox/input/scroll-area/switch），**本行需补 `select` 与 `separator`**（Select 用原生 `<select>` + shadcn 化样式，避免新增 radix 依赖） |
| 双语字典      | `client/src/dict.ts`               | `locale.bind(DICT_NS)` + `locale.register(DICT_NS, DICT)`，缺失时回退英文静态 t                                                                                                                          |

**差异**：本行的 PKG_NAME 是 `@zhidal/dsh-decision`（组合包），配置卡 key 用包名（与 llm-fallback 同模式，宿主 PackageDetail 页按包渲染）；ENTRY_NS 用本插件行的 profile 条目 id（`decision-tools`）。

---

## 8. 自查对照（对应本卡验收清单）

| 清单条目                                                                  | 落点                                                                                                         |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [1] 设计稿定稿文档：版本号、日期、组件清单、深浅两态 token 映射表         | 本文 §0 版本/日期、§3 映射表、§5 组件清单、§3.3 两态差异                                                     |
| [2] 色值与间距映射 token，无硬编码十六进制色值                            | §3 全表均为 `var(--dsw-alias-*)`；§4 间距偏差已声明（宿主无间距 token，自有 4/8dp 刻度）；全文零十六进制色值 |
| [5] 主题风格用 ui-ux-pro-max 产出并按理由裁剪                             | §2 选型表 + §2.1 被裁剪项及原因                                                                              |
| [6] 组件清单（模型配置表单/验证按钮与状态徽标/十个开关/预算与兜底参数区） | §5 A–E 五区                                                                                                  |
| [8] locate 图像口径                                                       | 见契约书 §2.5、§2.6（本文件不重复）                                                                          |
