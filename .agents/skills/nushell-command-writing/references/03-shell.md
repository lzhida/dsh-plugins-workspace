# Nu 作为 Shell

> 本章来源：
>
> - <https://www.nushell.sh/zh-CN/book/configuration.html>
> - <https://www.nushell.sh/zh-CN/book/environment.html>
> - <https://www.nushell.sh/zh-CN/book/stdout_stderr_exit_codes.html>
> - <https://www.nushell.sh/zh-CN/book/running_externals.html>（其 zh-CN 版缺 "Passing Arguments" 一节，该节译自英文版 <https://www.nushell.sh/book/running_externals.html>）
> - <https://www.nushell.sh/zh-CN/book/background_jobs.html>
> - <https://www.nushell.sh/zh-CN/book/directory_stack.html>
> - <https://www.nushell.sh/zh-CN/book/hooks.html>

读者通过 `nu --no-config-file -c <command>`（等价 `nu -n -c`）执行命令时，本章内容按重要度排序为：**环境变量赋值/作用域语义 → 外部命令调用与重定向 → 退出码捕获 → 启动标志对配置的影响**。后台作业、目录栈、钩子属于交互式 REPL 功能，非交互场景基本不适用（见对应小节的标注）。

## 配置文件与启动过程

### 配置文件与加载顺序

Nushell 使用多个可选配置文件，按以下顺序加载：

1. `env.nu`：历史上用于覆盖环境变量。当前最佳实践是不再使用它，把所有环境变量和其他配置都放进 `config.nu`。
2. `config.nu`：覆盖默认 Nushell 设置、定义（或导入）自定义命令、运行其他启动任务。
3. `$nu.vendor-autoload-dirs` 中的 `*.nu` 文件（供应商/包管理器启动文件）。
4. `$nu.user-autoload-dirs` 中的 `*.nu` 文件（模块化配置）。
5. `login.nu`：仅在 Nushell 作为登录 shell 运行时加载。

默认从 `$nu.default-config-dir` 读取：

```nu
$nu.default-config-dir
# macOS
# => /Users/me/Library/Application Support/nushell
# Linux
# => /home/me/.config/nushell
# Windows
# => C:\Users\me\AppData\Roaming\nushell
```

首次启动时创建该目录及（除注释外为空的）`env.nu` 和 `config.nu`。

常用查看命令：

```nu
config nu --doc | nu-highlight | less -R   # 查看用户配置 + 各设置的缩略文档
config env --default | nu-highlight | less -R  # 查看内置 default_env.nu
config nu --default | nu-highlight | less -R   # 查看内置 default_config.nu
```

（`config nu` / `config env` 用于在编辑器中打开配置文件，依赖 `$env.config.buffer_editor`、`$env.VISUAL` 或 `$env.EDITOR` 之一。）

### `$env.config` 记录

更改 Nushell 行为的主要机制是 `$env.config` 记录（record：键值对集合）。虽然它像环境变量一样通过 `$env` 访问，但与大多数环境变量不同，它：

- **不从父进程继承**，由 Nushell 用内部默认值填充；
- **不导出到 Nushell 启动的子进程**。

最佳实践是逐键赋值，避免整记录覆盖（整记录覆盖会重置其他已改动的键）：

```nu
# 错误：重置所有其他设置
$env.config = { show_banner: false }

# 正确：只改这一个键
$env.config.show_banner = false

# 键本身是记录时，覆盖需写全所有值：
$env.config.history = {
  file_format: sqlite
  max_size: 1_000_000
  sync_on_enter: true
  isolation: true
}
```

### 启动标志行为（`-n` / `-c` 场景必读）

启动阶段标记：`(config files)` 指加载 env.nu/config.nu/login.nu/自动加载目录；`(default_env)` 指内置 `default_env.nu`；`(stdlib)` 指标准库；`(repl)` 指交互式 REPL 专属步骤；`(plugin)` 指读取 `plugin.msgpackz` 签名。

| 模式 | 命令/标志 | 行为 |
| --- | --- | --- |
| 普通 shell | `nu`（无标志） | 除 `(login)` 外的所有启动步骤都发生 |
| 登录 shell | `nu --login` / `nu -l` | 所有启动步骤都发生 |
| 命令字符串 | `nu --commands <str>`（即 `nu -c`） | 除 `(config files)` 和 `(repl)` 外都发生；**但 `(default_env)` 和 `(plugin)` 会发生**——前者让 `default_env.nu` 中定义的 `ENV_CONVERSIONS` 生效，后者允许命令字符串使用插件 |
| 脚本文件 | `nu <script.nu>` | 与命令字符串相同 |
| 无配置 | `nu -n`（`--no-config-file`） | 无论其他标志如何，`(config files)` 阶段**全部不发生** |
| 无标准库 | `nu --no-std-lib` | `(stdlib)` 步骤不发生 |
| 强制配置 | `nu --config <file>` | 用指定文件代替用户的 `config.nu`（指定 `-n` 时无效） |
| 强制环境 | `nu --env-config <file>` | 用指定文件代替 `default_env.nu` 和 `env.nu`（指定 `-n` 时无效） |

各场景对照（✅ 发生 / ❌ 不发生）：

| 场景 | std lib | plugin.msgpackz | default_env.nu | env.nu | default_config.nu | config.nu | login.nu |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `nu` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| `nu -c "ls"` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `nu script.nu` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `nu -l -c "ls"` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `nu -n -l -c "ls"` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `nu -n --no-std-lib -c "ls"`（最快） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

对 `nu --no-config-file -c <command>` 的直接推论：

- `$env.config` 为内部默认值（用户配置从未加载）；
- `default_env.nu` **不**加载，因此其中定义的 `ENV_CONVERSIONS` 不存在；
- PATH 的 string → list 转换属于主要启动步骤（非配置文件步骤），在 `-n`、`-c` 下**仍然发生**，即 `$env.PATH` 始终是 list；
- 标准库默认可用（除非 `--no-std-lib`）。

### 启动前变量、常量与 `$nu`

`$env.XDG_CONFIG_HOME`、`$env.XDG_DATA_HOME`、`$env.XDG_DATA_DIRS`（仅 Unix）控制配置/数据目录位置，必须在 Nushell 启动**之前**由父进程设置。⚠ 注意：`XDG_*` 不是 Nushell 专用变量，应设为包含 `nushell` 子目录的上级目录（设 `XDG_CONFIG_HOME=/users/username/dotfiles` 才对，而非 `.../dotfiles/nushell`）。

`source` / `use` 是解析时关键字：参数必须在解析时已知，**不允许变量参数**。但内置常量（`$nu` 记录，如 `$nu.default-config-dir`、`$nu.data-dir`、`$nu.config-path`、`$nu.current-exe`，用 `$nu` 查看全部）在解析时已知，可以配合使用：

```nu
source ($nu.default-config-dir | path join "myfile.nu")
```

模块/脚本搜索路径也可用 `const NU_LIB_DIRS`（与 `$env.NU_LIB_DIRS` 变量并存时常量**优先**搜索）和 `const NU_PLUGIN_DIRS`：

```nu
const NU_LIB_DIRS = [
  '~/myscripts'
]
source myscript.nu

const NU_PLUGIN_DIRS = [
  ($nu.current-exe | path dirname)
  ($nu.data-dir | path join 'plugins' | path join (version).version)
  ($nu.config-path | path dirname | path join 'plugins')
]
```

（登录 shell 场景需在 `login.nu` 中设置环境变量；macOS 下用 `alias nu-open = open` 和 `alias open = ^open` 保留系统 `/usr/bin/open`。）

## 环境变量

### 赋值语义：`$env.FOO = 值`

Nushell 中环境变量可以是**任何类型**的值（不限于字符串），用 `describe` 可查看类型。设置环境变量最直接的方法是属性赋值：

```nu
$env.FOO = 'BAR'

# 扩展 Windows 的 Path（prepend = 最高优先级；append = 最低优先级）：
$env.Path = ($env.Path | prepend 'C:\path\you\want\to\add')
```

⚠ **与 bash 不同**：bash 的裸 `FOO=bar` 赋值语句在 Nushell 中不成立，赋值必须写 `$env.FOO = 'BAR'`（它是语句级赋值，作用域规则见下文；`FOO=BAR cmd` 形式仅作为一次性前缀存在，见「一次性环境变量」）。

路径追加还有列表专用语法与标准库辅助命令（`path add` 默认前置目录，即更高优先级）：

```nu
$env.path ++= ["~/.local/bin"]

use std/util "path add"
path add "~/.local/bin"
path add ($env.CARGO_HOME | path join "bin")  # path join 正确处理路径分隔符
```

多个变量一次性加载：

```nu
load-env { "BOB": "FOO", "JAY": "BAR" }
```

也可通过 `def --env` 定义的自定义命令（闭包内赋值可保留到调用方作用域）或模块导出设置环境变量。

### 一次性环境变量与 `with-env`

只在执行某代码块期间生效（closure：无名的可调用代码块，可捕获参数）：

```nu
FOO=BAR $env.FOO
# => BAR

with-env { FOO: BAR } { $env.FOO }
# => BAR
```

`with-env` 把给定键值对临时设为环境变量，块在该环境下运行，结束后恢复。⚠ **与 bash 不同**：`with-env` 影响**整个块**（相当于 bash 中的作用域化 `export`），不只是单条命令。

### 读取环境变量

```nu
$env.FOO
# => BAR

# 变量可能未设置时，用问号操作符（optional cell path）避免报错：
$env.FOO | describe
# => Error: nu::shell::column_not_found  × Cannot find column 'FOO'
$env.FOO? | describe
# => nothing
$env.FOO? | default "BAR"
# => BAR

# 或用 in 检查存在性：
if "FOO" in $env {
    echo $env.FOO
}
```

**大小写不敏感**：无论操作系统，`$env` 读取/更新都不区分大小写，`$env.PATH`、`$env.Path`、`$env.path` 在任何平台都是同一变量。需要区分大小写地读取时用 `$env | get --sensitive`。⚠ **与 bash 不同**：bash 在 Linux 上环境变量大小写敏感，Nushell 永远不敏感。

### 作用域规则（非交互执行最易错处）

环境变量赋值**只在当前作用域（当前块及其内部块）生效**，块结束后恢复外层值：

```nu
$env.FOO = "BAR"
do {
    $env.FOO = "BAZ"
    $env.FOO == "BAZ"
}
# => true
$env.FOO == "BAR"
# => true
```

`cd` 等价于设置 `PWD` 环境变量，因此遵循同样的作用域规则——⚠ **与 bash 不同**：子命令/子块里的 `cd` 不会影响外层目录（bash 中 `cd` 在子 shell 外仍改变当前目录，除非套了子 shell）。

永久（整个 Nushell 运行期）环境变量只能在配置文件中设置：

```nu
# In config.nu
$env.FOO = 'BAR'
```

### `ENV_CONVERSIONS`：字符串与值的双向转换

`$env.ENV_CONVERSIONS` 是一个记录：键为变量名，值为含 `from_string` / `to_string` 两个闭包的记录。内置 `default_env.nu` 已为 `PATH`（及 Windows 的 `Path`）定义转换。

- **string → 值**：在 `env.nu` 和 `config.nu` 加载完**之后**，按 `from_string` 转换。
- **值 → string**：每次运行外部命令时按 `to_string` 转换（外部工具要求环境变量是字符串）。

```nu
$env.ENV_CONVERSIONS = {
    # ... Path/PATH 可能已存在，追加：
    FOO : {
        from_string: { |s| $s | split row '-' }
        to_string: { |v| $v | str join '-' }
    }
}

with-env { FOO : 'a-b-c' } { nu }  # 子 Nushell 实例中 $env.FOO 变为 list [a b c]
$env.FOO
# => ╭───┬───╮
# => │ 0 │ a │
# => │ 1 │ b │
# => │ 2 │ c │
# => ╰───┴───╯

nu -c '$env.FOO'    # 子进程 nu -c 不加载配置文件 → 无转换 → 显示原始字符串 a-b-c
# => a-b-c
```

手动测试转换：`do $env.ENV_CONVERSIONS.FOO.from_string 'a-b-c'`。为其他冒号分隔变量（如 `XDG_DATA_DIRS`）添加转换用 `merge` 合入：

```nu
$env.ENV_CONVERSIONS = $env.ENV_CONVERSIONS | merge {
    "XDG_DATA_DIRS": {
        from_string: {|s| $s | split row (char esep) | path expand --no-symlink }
        to_string: {|v| $v | path expand --no-symlink | str join (char esep) }
    }
}
```

重要：string→值转换发生在 `env.nu`/`config.nu` 运行**之后**，这两个文件中的环境变量仍是字符串（除非手动设置为其他类型）。操作系统路径变量由 Nushell 自动转换，无需写入 `ENV_CONVERSIONS`。

### 删除环境变量：`hide-env`

只有当变量设置在**当前作用域**中时才能删除；隐藏本身也有作用域，可用于临时屏蔽父作用域变量、防止子作用域修改父环境：

```nu
$env.FOO = 'BAR'
hide-env FOO

$env.FOO = 'BAR'
do {
  hide-env FOO
  # $env.FOO 不存在
}
$env.FOO
# => BAR
```

## 外部命令

### 内部命令 vs 外部命令：调用规则表

Nushell 内置跨平台的「内部」命令；与外部命令同名时，**裸名称总是解析到内部命令**。用脱字符 `^` 前缀强制调用用户 `PATH` 中的外部命令：

| 写法 | 行为 |
| --- | --- |
| `ls` | 内部命令优先：解析为 Nushell 内置 `ls`（而非 `/bin/ls`） |
| `^ls` | 强制调用 `PATH` 中找到的外部命令（如 `/bin/ls`），**绕过内部命令与别名** |
| `^$program` | 执行名称/路径存于变量中的可执行文件（`let program = "git"` 后 `^$program status`） |
| `alias open = ^open` | 惯用法：为被内置命令遮蔽的系统命令建立别名（如 macOS 保留 `/usr/bin/open`） |

```nu
ls    # Nu 内部命令
^ls   # 外部命令（通常是 /usr/bin/ls）
```

### 参数传递与引号规则

- 外部命令的参数由 **Nushell 语法分隔**，不是「引号内空格切分」那一套；给含空格的参数加引号是为了让空格**留在同一个参数内**：

```nu
git commit -m "Update external command documentation"
```

- ⚠ **与 bash 不同**：Nushell **不会**把 list 自动展开为多个参数，直接传 list 会报错；必须用 spread 操作符 `...` 逐项展开：

```nu
let paths = ["file one.txt" "file two.txt"]
git add ...$paths
# git 收到两个路径参数，每个路径中的空格保留在参数内
```

- `extern` 声明可为已知外部命令添加类型检查与补全；调用时遵循与上述相同的参数规则。

### Windows 注意事项

- `ls` 在 Windows 上默认是 PowerShell 的**别名**，因此 `^ls` 找不到匹配的系统命令。
- 运行外部命令时，Nushell 会把一些 `CMD.EXE` 内部命令转发给 `cmd`，而不是尝试直接运行外部命令。

## stdout / stderr / 退出码

### 三种流的行为

- **stdout**：外部命令的 stdout 若处于管道中，默认被 Nushell 接收为输入（如 `external | str join`）；没有管道时直接打印到屏幕。
- **stderr**：默认**不做任何重定向**，直接打印到屏幕（⚠ 与 bash 不同：bash 中 `2>/dev/null` 需要显式写，而 Nushell 默认 stderr 就直通屏幕）。要把它静默/隐藏，用 `do -i { ... }`（`do` 的 `-i` 标志忽略/捕获 stderr）：

```nu
do -i { external }
```

- **退出码**：Nushell 记录最近完成的外部命令的退出码，两种方式：

```nu
do -i { external }
$env.LAST_EXIT_CODE   # 最近一次外部命令的退出码

do -i { cat unknown.txt } | complete
# => ╭───────────┬─────────────────────────────────────────────╮
# => │ stdout    │                                             │
# => │ stderr    │ cat: unknown.txt: No such file or directory │
# => │ exit_code │ 1                                           │
# => ╰───────────┴─────────────────────────────────────────────╯
```

`complete` 运行外部程序至结束，把 stdout、stderr、exit_code 收进一条记录。

⚠ **实测注**（nu 0.115，`nu -n -c` 下验证）：外部命令失败（非零退出/找不到文件）默认会使管道**直接报错中断**，读不到后续语句；`do -i` 的现代语义是「忽略该错误、让管道继续」，此时 stderr 仍直通屏幕、`$env.LAST_EXIT_CODE` 可能为 `0`。因此**拿退出码的可靠方式是 `do -i { ... } | complete | get exit_code`**（实测返回 `1`）。另外，命令完全不存在时 Nushell 抛 `nu::shell::external_command` 硬错误，而非设置非零退出码。

### 重定向操作符

**文件重定向**（作用于**整个表达式**，表达式内所有外部命令都受影响）：

| 操作符 | 全称 | 效果 |
| --- | --- | --- |
| `out>` | `o>` | stdout → 文件 |
| `err>` | `e>` | stderr → 文件 |
| `out+err>` | `o+e>` | stdout 与 stderr → 同一文件 |

```nu
cat unknown.txt out> out.log err> err.log   # 或 o> / e>
cat unknown.txt o+e> log.log

# 任何 string 值表达式都可作路径：
use std
cat unknown.txt o+e> (std null-device)

# 作用于整个表达式：
let text = "hello\nworld"
($text | head -n 1; $text | tail -n 1) o> out.txt
# out.txt 包含 hello\nworld
```

表达式**内部**的管道和额外的文件重定向会**覆盖**外部套用的文件重定向。

**管道重定向**（只影响**表达式中最后一个命令**）：

| 操作符 | 全称 | 效果 |
| --- | --- | --- |
| `\|` | — | stdout → 下一个命令的输入 |
| `e>\|` | `err>\|` | stderr → 下一个命令的输入 |
| `o+e>\|` | `out+err>\|` | stdout 与 stderr 合并 → 下一个命令的输入 |

```nu
cat unknown.txt e>| str upcase
nu -c 'print output; print -e error' o+e>| str upcase

# 只有 cmd2 的 stdout+stderr 被重定向，cmd1 不受影响：
(cmd1; cmd2) o+e>| cmd3
```

### `echo`、`print` 与 `log`

- `echo` 主要用于管道：返回其参数，忽略管道传入的值。通常没有理由用它代替直接写值。
- `print` 把值以纯文本打到 stdout（`print -e` 打到 stderr）；**不返回值**（`print | describe` 为 nothing），因此再接管道没有意义。要让中间结果显示而不参与返回值，用 `print` 而非 `echo`。
- 标准库 `std/log` 提供分级日志：`log debug` / `log info` / `log warning` / `log error` / `log critical`；级别由 `$env.NU_LOG_LEVEL` 控制（如 `NU_LOG_LEVEL=DEBUG nu std_log.nu`）。

### 原始流与 `decode`

stdout/stderr 都是「原始流」（字节流），而非 Nushell 内部命令使用的结构化流。Nushell 尝试把字节流转成 UTF-8 文本；一旦转换失败，流的剩余部分按字节处理。需要控制解码时用 `decode`：

```nu
0x[8a 4c] | decode shift-jis
# => 貝
```

## 后台作业（交互式 REPL 为主）

Nushell 对基于线程的后台任务有实验性支持。⚠ **与 bash 不同**：任务是**后台线程**而非独立进程，shell 进程退出时所有后台任务随之终止；没有 `disown`。

```nu
job spawn { sleep 10sec; ' inevitable' | save --append status.txt }
# => 1   (唯一整数 ID)

job list    # 活动任务表（# / id / type / pids）
job kill $id          # 中断线程并杀死任务的全部子进程
job unfreeze          # 把 Ctrl+Z 冻结的任务带回前台（仅 Unix；可指定 id）
job send $jobId 'hi'  # 向任务发数据；任务用 job recv 接收
job recv              # 主线程任务 ID 为 0，后台任务也可反向发给主线程
```

交互会话在有后台任务时运行 `exit`，shell 会先警告再确认。非交互 `nu -c` 场景上述命令意义有限。

## 目录栈（标准库 `std/dirs`）

```nu
use std/dirs
```

栈以 `list` 表示。命令对照：

| 命令 | 描述 | 类比其他 shell |
| --- | --- | --- |
| `dirs` | 列出栈中目录（含 active 列） | `dirs`/`pushd`/`popd` 家族 |
| `dirs add <dir>` | 添加目录并切换，第一个列出的成为新的活动目录 | `pushd` |
| `dirs drop` | 移除当前目录，前一个目录成为活动目录 | `popd` |
| `dirs goto <n>` | 按索引跳转 | — |
| `dirs next` / `dirs prev` | 循环切换到下一个/上一个目录 | — |

`cd` 只改活动目录，不动栈。另有 `use std/dirs shells-aliases *` 导入别名：`shells`（=dirs）、`enter`（=add）、`dexit`（=drop）、`g`（=goto）、`n`（=next）、`p`（=prev）。

## 钩子

钩子（hooks）在预定义情形下运行代码片段。⚠ **关键限制**：钩子**只在交互式 REPL 模式可用**——`nu script.nu` 或 `nu -c "print foo"` 下**不起作用**。在 `nu -n -c` 非交互执行场景中，钩子永远不会被触发；但配置里定义的钩子也不会报错。

五种钩子及 REPL 执行周期中的触发点：

| 钩子 | 触发时机 |
| --- | --- |
| `pre_prompt` | 命令提示显示之前 |
| `pre_execution` | 输入行开始执行前 |
| `env_change` | 环境变量变化时（按变量名分组，闭包收 `before`/`after` 参数） |
| `display_output` | 输出被传递给它打印（外部命令的输出**不**经过它） |
| `command_not_found` | 命令未找到时；返回字符串则显示 |

基本形态：

```nu
$env.config.hooks = {
    pre_prompt: [{ print "pre prompt hook" }]
    pre_execution: [{ print "pre exec hook" }]
    env_change: {
        PWD: [{|before, after| print $"changing directory from ($before) to ($after)" }]
    }
}
```

要点：

- 每个触发器可以是单个钩子或钩子列表（依次运行）；追加用 `$env.config.hooks.pre_execution = $env.config.hooks.pre_execution | append { ... }`。
- **钩子保留环境**：钩子块内定义的环境变量以类似 `def --env` 的方式保留下来；块内定义的命令/别名等则遵循一般作用域规则，块结束后丢弃。
- **记录形式 + `condition`**：闭包内 `if` 里赋值环境不外泄，改用 `{ condition: {|before, after| ... }, code: {...} }`；`condition` 返回 `true` 才执行 `code`，返回 `false` 什么都不发生，返回其他值报错。`condition` 可省略（总是执行）。`pre_prompt`/`pre_execution` 的条件钩子不接受 `before`/`after` 参数。
- **字符串形式**：`code` 可为字符串（相当于在 REPL 输入该串回车），可借此定义命令/别名并按目录条件 `def`/`hide`。
- `pre_execution` 中可用 `commandline` 命令取得将要执行的命令行内容。
