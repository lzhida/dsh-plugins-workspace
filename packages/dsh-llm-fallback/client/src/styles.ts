/**
 * 配置卡主题 token 与内联样式。
 *
 * 颜色一律走 dsh web 主题 token `--dsw-alias-*`（明/暗双模式各有定义，
 * 由客户端 Theme inspect 提供方列出）：文本用 label-primary/secondary，
 * 边框用 border-l1/l2，抬升表面用 bg-layer-1，强调色用 brand-primary。
 * 不硬编码半透明灰阶（旧边框/徽标配色）——那是暗色模式下文字与背景混色
 * 的根因；token 缺失时按 CSS var 规则退回继承色/初始值，不会渲染崩溃。
 *
 * 样式用内联 style 对象，不依赖 dsh 的 CSS modules 哈希类名（版本升级
 * 不失效）。主题 token 存在性由 client-bundle.test.ts 断言。
 *
 * @module dsh-llm-fallback/client/styles
 */

import type { CSSProperties } from 'react';

/** 主题 token 别名（全部为 CSS var 引用）。 */
export const T = {
  text: 'var(--dsw-alias-label-primary)',
  textSecondary: 'var(--dsw-alias-label-secondary)',
  border: 'var(--dsw-alias-border-l1)',
  borderStrong: 'var(--dsw-alias-border-l2)',
  surface: 'var(--dsw-alias-bg-layer-1)',
  brand: 'var(--dsw-alias-brand-primary)',
} as const;

/** 旧硬编码灰阶（暗色模式混色根因，测试防回归）。 */
export const LEGACY_GRAY_PREFIX = 'rgba(128,128,128';

/** 配置卡全部内联样式（键与旧版手写 S 对象一一对应）。 */
export const S = {
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
    padding: '4px 0',
    // 卡片根节点显式设置文本色：不依赖宿主容器的继承链，暗色模式下
    // 也不会退回 UA 默认的近黑前景。
    color: T.text,
  },
  section: { display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontWeight: 600, fontSize: 13, color: T.text },
  hint: { fontSize: 12, color: T.textSecondary },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  queueRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    border: '1px solid ' + T.border,
    borderRadius: 6,
  },
  badge: {
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 999,
    border: '1px solid ' + T.border,
    color: T.textSecondary,
    whiteSpace: 'nowrap',
  },
  btn: {
    cursor: 'pointer',
    padding: '3px 8px',
    borderRadius: 6,
    border: '1px solid ' + T.borderStrong,
    background: 'transparent',
    color: T.text,
    fontSize: 12,
  },
  primaryBtn: {
    cursor: 'pointer',
    padding: '5px 14px',
    borderRadius: 6,
    border: '1px solid transparent',
    background: T.brand,
    color: '#fff',
    fontSize: 13,
  },
  group: { display: 'flex', flexDirection: 'column', gap: 4 },
  groupTitle: { fontSize: 12, color: T.textSecondary, marginTop: 4 },
  // accent-color 会被勾选框继承,明暗模式下勾选态都用品牌色渲染。
  check: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 13,
    cursor: 'pointer',
    accentColor: T.brand,
  },
  input: {
    width: 90,
    padding: '3px 6px',
    borderRadius: 6,
    border: '1px solid ' + T.borderStrong,
    background: T.surface,
    color: T.text,
  },
  searchInput: {
    width: '100%',
    boxSizing: 'border-box',
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid ' + T.borderStrong,
    background: T.surface,
    color: T.text,
    fontSize: 13,
  },
  // 可用模型列表容器：限高 + 内部滚动，模型再多也不撑长外层滚动条。
  catalogScroll: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    maxHeight: 280,
    overflowY: 'auto',
    padding: 8,
    border: '1px solid ' + T.border,
    borderRadius: 8,
    background: T.surface,
  },
  noMatch: { fontSize: 12, color: T.textSecondary, padding: '8px 2px' },
  notice: { fontSize: 13, color: T.textSecondary },
  // 时段计划：规则盒（纵向容器）与星期 chips（选中 = 品牌底色）。
  ruleBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 8,
    border: '1px solid ' + T.border,
    borderRadius: 6,
  },
  chip: {
    cursor: 'pointer',
    padding: '2px 7px',
    borderRadius: 999,
    border: '1px solid ' + T.borderStrong,
    background: 'transparent',
    color: T.textSecondary,
    fontSize: 11,
  },
  chipOn: {
    cursor: 'pointer',
    padding: '2px 7px',
    borderRadius: 999,
    border: '1px solid transparent',
    background: T.brand,
    color: '#fff',
    fontSize: 11,
  },
  /** 窗口行（起止输入 + 星期 chips 换行）。 */
  windowRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  /** 队列/规则行的伸展中段（占满剩余宽度）。 */
  grow: { flex: 1, fontSize: 13 },
  /** 操作按钮组（保存/放弃）。 */
  actions: { display: 'flex', gap: 8 },
} satisfies Record<string, CSSProperties>;
