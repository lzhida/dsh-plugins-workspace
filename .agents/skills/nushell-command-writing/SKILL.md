---
name: nushell-command-writing
description: 在 dsh 的 nushell 工具（nu --no-config-file -c）里写出正确 nu 命令的核心规则与 bash 陷阱速查。当要写、审查或调试 nushell 命令/脚本（管道、$env、外部命令、stderr/退出码捕获、结构化数据）时使用。
---

# 写 nu 命令：核心规则与 bash 陷阱速查

执行环境是 `nu --no-config-file -c <command>`：非交互、无用户配置、每次全新进程、无状态残留（跨调用状态用 `workdir` 参数与环境变量传递）。

## 执行模型（先记三条）

1. **解析-求值严格分离**：语法错误、未定义命令/变量在解析期即报错——nu 是「静态语言」，不是逐行动态执行。
2. **没有 eval**：任何「拼字符串再执行」的思路都不成立。
3. **`-c` 整串是单一表达式**：`cd spam; source-env foo.nu` 模式会失败；`source`/`use` 等解析期关键字的参数不能依赖同一块内先求值的命令（用 `const` 提供常量路径）。

## bash 直觉 → nu 正确写法（高频错误源）

| bash 直觉 | ❌ 在 nu 中 | ✅ nu 写法 |
| --- | --- | --- |
| 命令替换 `$(cmd)` | 语法错误 | `(cmd)`；作多参数需 spread：`stat ...(which git).path` |
| 字符串插值 `"$VAR"` | `"..."` 不插值 | `$"...(表达式)"`，如 `$"/tmp/(random int)"` |
| `cmd1 && cmd2` | 不存在 | `cmd1; cmd2`（无短路语义） |
| 逻辑与/或 `&&`/`\|\|` | 不存在 | 关键字 `and` / `or` |
| 退出码 `$?` | 不存在 | `$env.LAST_EXIT_CODE` |
| `>` `>>` `2>&1` | 语法错误 | `out>` `out>>` `o+e>\|`；丢弃用 `ignore`；结构化数据落盘用 `save` |
| `tee file` | | `tee { save file }` |
| `cat f` | | `open f`（结构化）/ `open --raw f`（纯文本） |
| `head -5` / `tail` | | `first 5` / `last` |
| `find . -name '*.rs'` | | `ls **/*.rs`；过滤文本 `where $it =~ pat` 或 `find pat` |
| `sed` | | `str replace` |
| `mkdir -p` | `-p` 报未知 flag | `mkdir`（默认递归） |
| `rm -rf` | | `rm -r`（`rm -t` 进垃圾箱） |
| `for f in *.md; do …` | | `ls *.md \| each { \|it\| … }`（`ls` 产出结构化表格） |
| `ls -d */` | | `ls \| where type == dir` |
| `export FOO=BAR` / `unset FOO` | | `$env.FOO = BAR` / `hide-env FOO` |
| `${FOO:-fallback}` | | `$env.FOO? \| default "ABC"` |
| `PATH=$PATH:/x` | | `$env.PATH = ($env.PATH \| append '/x')`（Windows 是 `$env.Path`） |
| `alias s="git status"` | 引号错 | `alias s = git status -sb`（`=` 两侧空格、值不加引号） |
| 续行 `\` | 不存在 | 用 `( ... )` 包表达式跨行 |

## 环境变量与作用域

- 读取 `$env.NAME`（不是 `$env:NAME`）；可能不存在的键用 `$env.NAME?`。
- 赋值 `$env.FOO = ...` 是作用域内的，**不会**像 bash 一样自然外泄到「全局」；`def` 体内改环境对外不可见，需要环境外泄用 `def --env`。
- 单命令临时环境：`with-env { FOO: "bar" } { … }`；批量：`load-env`。
- 每次工具调用是全新进程：环境改动天然不跨调用。

## stdout / stderr / 退出码

- 非 0 退出不是异常：工具结果以 `[exit code: N]` marker 报告。
- 外部命令 stderr 捕获：`do -i { ^cmd } | complete` → `{exit_code, stdout, stderr}` 记录（推荐）；或管道重定向 `e>|`（仅 stderr）、`o+e>|`（合并）。
- ⚠ 实测注（nu 0.115）：`do -i {…}; $env.LAST_EXIT_CODE` 已不可靠（恒 0），用 `do -i {…} | complete | get exit_code`。

## 结构化数据（nu 的强项，优先利用）

- 管道传递的是**类型化数据**（list/record/table），不是文本：`ls | where size > 10mb | sort-by modified | get name`。
- 表格列操作：`select`（选列成新表）vs `get`（取值）；`first/skip` 分页、`uniq`、`length`。
- 解析文本为表格：`lines | split column ':' a b | sort-by a`。
- 机器可读输出：`| to json` / `to nuon` / `to jsonl`；读外部数据 `open`（json/toml/yaml/csv/xml/sqlite 自动检测）。
- 并行：`each` 换 `par-each`（结果无序，需要时 `sort-by`）。

## Windows 注意

- 路径用单引号 `'C:\Users\AI'` 或正斜杠 `C:/Users/AI`；双引号字符串处理转义，`\U` 等是解析错误。
- `dir/copy/move/del/type/findstr` 等 cmd 语法不存在：对应 `ls/cp/mv/rm/open/where`。

## 详查索引（references/，按需 read）

写复杂命令或遇到上表未覆盖的语义时，先 `read` 对应参考文件再动手：

| 文件 | 内容 |
| --- | --- |
| `references/00-thinking.md` | 设计哲学、文件系统导航、与典型 shell 的 9 大差异 |
| `references/01-fundamentals.md` | 完整类型系统、open/from/to、管道 $in 规则、字符串/列表/表格操作全集 |
| `references/02-language.md` | def 签名、变量三类与闭包捕获、运算符与优先级、脚本 main、模块 |
| `references/03-shell.md` | 配置文件、$env 全规则、重定向操作符表、外部命令调用规则、后台作业 |
| `references/04-migration.md` | 执行原理、bash/CMD/SQL/Python 等五方对照全表 |
| `references/05-advanced.md` | std 标准库、error make、par-each、Polars 数据帧、插件 |
