/**
 * nushell 执行器的运行时标记:tool 层的接缝探针据此把 `ctx.shell` 识别为
 * nushell 执行器并采用之;官方 pwsh/bash 执行器不带标记,占据接缝时保持
 * 无视——这保证 dsh-tool-nushell 单独安装时官方预设与 permission 栈
 * 原封不动(官方 shell 工具照常工作,nu 命令走本包内置执行器直跑)。
 */
export const NUSHELL_RUNTIME = 'nushell';
