/**
 * usage 查询窗口枚举（决策工具系列 5/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §3.6 入参 window。
 * 单独成文件：6/11 设置页的下拉选项直接复用同一闭集，避免两处漂移。
 */

export const USAGE_WINDOW_VALUES = ['1h', '24h', '7d', '30d', 'all'] as const;

export type UsageWindow = (typeof USAGE_WINDOW_VALUES)[number];
