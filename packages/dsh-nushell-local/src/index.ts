// e2e 契约:模块装载(loader import)时输出 `[目录名] ` 前缀日志行。
// Service 为惰性实例化,constructor 在无人消费 ctx.shell 前不会执行,
// 因此装载日志必须挂在模块顶层。
console.log('[dsh-nushell-local] shell executor module loaded');

/**
 * dsh-nushell-local:本地 Nushell 执行器的组合行薄壳。
 *
 * 实现内核已上移至 `@lzhida/dsh-tool-nushell`(双模架构:执行器类由
 * tool 包内直跑模式与接缝挂载共用一份)。本包的存在意义只剩两件事:
 * 通过 bundle patch 无条件停用官方 shell 家族并把本执行器挂上
 * `ctx.shell` 接缝(完全替换模式);提供 e2e 契约的装载日志。
 * 前置:须与 `@lzhida/dsh-tool-nushell` 同时安装(peer 依赖,运行时
 * 经 profile node_modules 平铺解析)。
 */
export {
  NushellLocalExecutor as default,
  NushellLocalExecutor,
  annotateWrappedNu,
  assertServiceableNushellConfig,
  candidateNuPaths,
  DEFAULT_NUSHELL_CONFIG,
  resolveNuPath,
} from '@lzhida/dsh-tool-nushell/src/executor-local.ts';
export type {
  NushellLocalConfig,
  NuPathExists,
} from '@lzhida/dsh-tool-nushell/src/executor-local.ts';
