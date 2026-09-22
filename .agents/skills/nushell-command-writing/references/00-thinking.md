# 设计哲学与思维方式（快速导览 · 文件系统 · Nu 思维）

> 本章来源：
>
> - <https://www.nushell.sh/zh-CN/book/quick_tour.html>
> - <https://www.nushell.sh/zh-CN/book/moving_around.html>
> - <https://www.nushell.sh/zh-CN/book/thinking_in_nu.html>

读者约定：本文面向通过 `nu --no-config-file -c <command>` 非交互执行命令的 LLM。所有示例均可直接以 `-c` 形式运行；原书中纯 REPL 交互技巧（F1 帮助菜单、行编辑、TUI 浏览器 `explore` 等）已按需裁剪，仅保留与非交互执行相关的语义。

## 一、设计哲学：命令输出的是数据，不是文本

Nushell 的核心设计决策：**命令返回结构化的、带类型的数据**，而不是文本流。运行 `ls` 时，返回的不是一个文本块，而是一个结构化的表格：

```nu
ls
# => ╭────┬─────────────────────┬──────┬───────────┬──────────────╮
# => │  # │ name                │ type │ size      │ modified     │
# => ├────┼─────────────────────┼──────┼───────────┼──────────────┤
# => │  0 │ CITATION.cff        │ file │     812 B │ 2 months ago │
# => │  1 │ CODE_OF_CONDUCT.md  │ file │   3.4 KiB │ 9 months ago │
# => │  2 │ CONTRIBUTING.md     │ file │  11.0 KiB │ 5 months ago │
# => │ ...│ ...                 │ ...  │ ...       │ ...          │
# => ╰────┴─────────────────────┴──────┴───────────┴──────────────╯
```

这个表格不只是「格式化好看的输出」，它像电子表格一样，允许后续命令交互式地处理数据。

设计哲学逐条列出：

1. **数据优先（data-first）**：每个命令的输出都是类型化数据（table / record / list / string / int / filesize ...），渲染成表格只是「显示」这一步的产物，数据本身带类型和结构。
2. **一切都是管道**：沿用 Unix「每个命令只做好一件事，一个命令的输出成为另一个命令的输入」的哲学，但管道中流动的是**结构化数据**而非字节流文本。
3. **类型化语义**：数据带类型，操作遵循类型语义。例如 `size` 列是 `filesize` 类型，Nushell 知道 `1.1 KiB`（kibibytes）比 `812 B`（bytes）大——排序、比较按类型语义进行，而不是字符串比较。
4. **数据可任意嵌套**：一个表的单元格可以是嵌套表、record 等（例如 `help commands` 输出的 `params` 和 `input_output` 列就是嵌套表）。
5. **命令尽量接受管道输入**：设计上「只要有可能，Nushell 命令都被设计为对管道输入进行操作」；确有多个位置参数的命令（如 `cp`）通过 `$in` 变量桥接管道（见下文）。
6. **帮助系统本身基于结构化数据**：`help commands` 把所有命令输出为一张大表格，可以继续用管道过滤。
7. **一门语言，也是一个 Shell**：Nushell 既是一种编程语言，也是一个 Shell，有自己的处理文件、目录、网络数据的方式；许多功能像编译型语言（静态解析、类型系统、作用域环境、默认不可变变量）。

### 管道操作数据示例

排序——把 `ls` 的输出传给内置命令 `sort-by`，再 `reverse` 让最大的文件显示在最上面：

```nu
ls | sort-by size | reverse
```

⚠ 与 bash 不同：没有向 `ls` 传递任何命令行参数或开关（bash 里等价操作是 `ls -S` 这类 flag）。排序由管道下游的 `sort-by` 完成，且按 `filesize` 类型语义排序，不是按字母顺序或字符串数值。

过滤——`where` 属于 Nushell 中「过滤器」类命令，作用于前一个命令的结构化输出：

```nu
ls | where size > 10kb
# => ╭───┬─────────────────┬──────┬───────────┬──────────────╮
# => │ 0 │ CONTRIBUTING.md │ file │ 11.0 KiB  │ 5 months ago │
# => │ 1 │ Cargo.lock      │ file │ 194.6 KiB │ 2 minutes ago│
# => │ ...                                                  │
# => ╰───┴─────────────────┴──────┴───────────┴──────────────╯
```

进程列表——Nushell 提供跨平台内置 `ps` 命令，以结构化数据返回结果：

```nu
ps
# => ╭───┬──────┬──────┬───────────────┬──────────┬──────┬───────────┬─────────╮
# => │ # │ pid  │ ppid │ name          │ status   │ cpu  │ mem       │ virtual │
# => ├───┼──────┼──────┼───────────────┼──────────┼──────┼───────────┼─────────┤
# => │ 0 │ 1    │ 0    │ init(void)    │ Sleeping │ 0.00 │ 1.2 MiB   │ 2.2 MiB │
# => │ 4 │ 6567 │ 6566 │ nu            │ Running  │ 0.00 │ 28.4 MiB  │ 1.1 GiB │
# => ╰───┴──────┴──────┴───────────────┴──────────┴──────┴───────────┴─────────╯

ps | where status == Running
```

⚠ 与 bash 不同：

- 传统的 Unix `ps` 默认只显示当前进程及其父进程；Nushell 的 `ps` 默认显示系统上的**所有**进程。
- 在 Nushell 中运行 `ps` 用的是其**内部的**跨平台命令。要运行 Unix/Linux 上**外部的**、依赖系统的版本，需在命令前加脱字符号（`^`）：`^ps aux`。

`describe` 命令可以显示**任何**命令或表达式的输出类型：

```nu
ps | describe
# => table<pid: int, ppid: int, name: string, status: string, cpu: float, mem: filesize, virtual: filesize> (stream)
```

`status` 列实际上只是一个 `string`，可以对它使用所有常规的字符串操作和命令（包括上面的 `==` 比较）。

### 管道输入与位置参数：`$in`

有些命令接受的是位置参数而不是管道输入。Nushell 提供 `$in` 变量，让你在参数位置引用前一个命令的输出：

```nu
ls
| sort-by size
| reverse
| first
| get name
| cp $in ~
```

- `first` 从表格中返回第一个值（即大小最大的文件）。它是表格中的一个 `record`（记录），仍包含 `name`、`type`、`size`、`modified` 字段。
- `get name` 返回该 record 的 `name` 字段值，即 `"Cargo.lock"`（一个字符串），同时演示了 `cell-path`（单元格路径）的用法。
- 最后一行 `$in` 引用第 5 行的输出。整条命令的意思是「将 'Cargo.lock' 复制到主目录」。
- 命令可以跨多行书写；上面的命令与 `ls | sort-by size | reverse | first | get name | cp $in ~` 完全等价。非交互 `-c` 模式下多行字符串同样有效。

`get` 和 `select` 是 Nushell 中最常用的两个过滤器，区别见「导航结构化数据」主题（其他章节）。

### 帮助系统

```nu
# help <command>
help ls
# 或者
ls --help
# 也可以
help operators
help escapes
```

帮助系统自带搜索功能：

```nu
help --find filesize
# 或
help -f filesize
```

帮助系统本身就是基于结构化数据的：`help -f filesize` 的输出是一个表格。每个命令的帮助作为一条 record 存储，包含：名称、类别、类型（内置、插件、自定义）、接受的参数、显示可接受和输出数据类型的签名等。

```nu
help commands   # 所有命令（外部命令除外）作为一张大表格输出
```

注意 `params` 和 `input_output` 列是嵌套表——Nushell 允许任意嵌套的数据结构。既然输出是表格，可以继续用管道过滤（如 `help commands | where name == cp`）。

（原书还介绍了交互式 TUI 浏览器 `explore`，需要在 TTY 中运行，不适用于 `nu -c` 非交互执行，此处仅备忘其存在。）

## 二、文件系统导航

Shell 的一个决定性特征是能够在文件系统中导航和交互。以下是 Nushell 中常用的文件系统命令及其形态。

### `ls`：查看目录内容

`ls` 以表格形式返回目录内容（见第一章示例）。它接受一个可选参数来改变查看的内容：

```nu
ls *.md
# => ╭───┬────────────────────┬──────┬──────────┬──────────────╮
# => │ 0 │ CODE_OF_CONDUCT.md │ file │ 3.4 KiB  │ 9 months ago │
# => │ 1 │ CONTRIBUTING.md    │ file │ 11.0 KiB │ 5 months ago │
# => │ 2 │ README.md          │ file │ 12.0 KiB │ 6 days ago   │
# => │ 3 │ SECURITY.md        │ file │ 2.6 KiB  │ 2 months ago │
# => ╰───┴────────────────────┴──────┴──────────┴──────────────╯
```

### 通配符（wildcards / glob）

参数 `*.md` 中的星号（`*`）被称为通配符或 Glob。`*.md` 可理解为「匹配以 `.md` 结尾的任何文件名」。

- `*`：最通用的通配符，匹配所有路径；常与其他模式组合，如 `*.bak`、`temp*`。
- `**`：双星号，访问更深的目录（递归）。`ls **/*` 递归罗列当前目录下所有非隐藏路径。

```nu
ls **/*.md
# => ╭───┬───────────────────────────────┬──────┬──────────┬──────────────╮
# => │ 0 │ CODE_OF_CONDUCT.md            │ file │ 3.4 KiB  │ 5 months ago │
# => │ 4 │ benches/README.md             │ file │ 249 B    │ 2 months ago │
# => │ 5 │ crates/README.md              │ file │ 795 B    │ 5 months ago │
# => │ 6 │ crates/nu-cli/README.md       │ file │ 388 B    │ 5 hours ago  │
# => │ ...│ （"从这里开始的任何目录中"）  │      │          │              │
# => ╰───┴───────────────────────────────┴──────┴──────────┴──────────────╯
```

Nushell 通配符语法支持：`*`（任意）、`?`（匹配单个字符）、`[...]`（匹配字符组）。

⚠ 与 bash 不同（引用方式决定通配符行为）——把 `*`、`?`、`[]` 模式包含在**单引号、双引号或原始字符串**中可以将其转义为字面量；**反引号引用的字符串不会转义通配符**：

| 写法 | 行为 |
| --- | --- |
| `rm *myfile*`（裸词） | 星号被解释为通配符模式：删除当前目录中所有文件名包含 `myfile` 的文件 |
| `rm "*myfile*"`（单/双引号或原始字符串） | 星号是字面量：只删除文件名**就是** `*myfile*`（含星号）的文件 |
| `` rm `*myfile*` ``（反引号） | 与裸词相同：星号被解释为通配符模式 |

要在引用（quoted）的目录名上使用 glob，如显示名为 `[slug]` 的目录内容，用 `ls "[slug]"` 或 `ls '[slug]'`（引号转义了字符组）。

### 以编程方式构造 glob

有三种技术把字符串转换为通配符：

```nu
# 1. into glob 命令：查找文件名包含当前月份（格式为 YYYY-mm）的文件
let current_month = (date now | format date '%Y-%m')
let glob_pattern = ($"*($current_month)*" | into glob)
ls $glob_pattern
```

```nu
# 2. glob 命令（与 into glob 不同）生成一个与通配符模式匹配的"列表"文件名，
#    可用展开操作符 ... 展开后传给文件系统命令
let current_month = (date now | format date '%Y-%m')
ls ...(glob $"*($current_month)*")
```

```nu
# 3. 通过类型注解强制 glob 类型
let current_month = (date now | format date '%Y-%m')
let glob_pattern: glob = ($"*($current_month)*")
ls $glob_pattern
```

### `mkdir`：创建目录

⚠ 与 bash 不同：Nushell 内置 `mkdir` 默认像 Unix/Linux 的 `mkdir -p` 一样工作——自动创建多级目录，且目录已存在时不报错：

```nu
mkdir modules/my/new_module   # 即使 modules、my、new_module 都不存在，也会创建全部三级

mkdir modules/my/new_module
mkdir modules/my/new_module   # 第二次执行：没有错误
```

⚠ 与 bash 不同：写 `mkdir -p <directory>` 会产生 `Unknown Flag` 错误。重复执行不带 `-p` 的命令即可达到幂等效果。

### `cd`：改变当前目录

```nu
cd cookbook
```

⚠ 与 bash 不同：**省略 `cd`、只给出一个路径本身，也可以改变当前工作目录**：

```nu
cookbook/   # 等价于 cd cookbook
```

可以使用目录名，或 `..` 快捷方式进入父目录。还可以添加额外的点进入更上层的目录：

```nu
# 切换到父目录
cd ..
# 或者
..
# 上移两层（父目录的父目录）
cd ...
# 或者
...
# 上移三层（父目录的父目录的父目录）
cd ....
# 等等
```

⚠ 与 bash 不同：`...`、`....` 多点快捷方式对**外部命令**同样生效。例如在 Linux/Unix 上运行 `^stat ....` 会显示路径被扩展为 `../../..`。

相对目录级别可与目录名结合：

```nu
cd ../sibling
```

**作用域语义（重要）**：用 `cd` 改变目录会改变 `PWD` 环境变量，目录的改变**只保留到当前代码块（block 或闭包）结束**。一旦退出该代码块，就会返回以前的目录（详见环境作用域，见本章「环境是作用域的」小节）。

### `mv` / `cp` / `rm`：文件系统命令

Nushell 提供跨平台的基础文件系统命令：

- `mv`：重命名或将文件/目录移动到新位置
- `cp`：将项目复制到新位置
- `rm`：从文件系统中删除项目

⚠ 与 bash 不同：在 Bash 和许多其他 shell 中，大多数文件系统命令（`cd` 除外）是系统中的**独立二进制文件**（如 Linux 上 `cp` 是 `/usr/bin/cp`）。在 Nushell 中这些命令是**内置的**，优点：

1. 在可能没有二进制版本的平台（例如 Windows）上行为一致，允许创建跨平台的脚本、模块和自定义命令。
2. 与 Nushell 更紧密集成，理解 Nushell 类型和其他构造。
3. 在 Nushell 帮助系统中有文档：`help <command>` 或 `<command> --help`。

虽然通常建议使用内置版本，但仍可通过 `^` 前缀访问 Linux 二进制文件（如 `^ls`）。

## 三、用 Nu 的方式思考：与典型 Shell 的核心差异

新用户最常见的错误源于带着其他 Shell/语言的思维习惯。以下逐条列出核心差异。

### 差异 1：「Bash 样」但不是 Bash

Nushell 与 bash 有相似之处——管道组合命令的方式一致，很多命令行在两者中都能工作：

```nu
curl -s https://api.github.com/repos/nushell/nushell/contributors | jq -c '.[] | {login,contributions}'
# => 返回 Nushell 的贡献者
```

但 Nushell 根本不需要 `curl` 和 `jq`——它有内置的 `http get` 命令并原生处理 JSON 数据：

```nu
http get https://api.github.com/repos/nushell/nushell/contributors | select login contributions
```

Bash 主要是一个**运行外部命令的命令解释器**；Nushell 把许多这类功能做成了跨平台的内置命令。

### 差异 2：`>` 是比较运算符，不是重定向

⚠ 与 bash 不同：Bash 中 `>` 重定向、`test`/`-gt` 比较；Nushell 中 `>` 就是比较的「大于」运算符，更符合现代编程期望：

```nu
# Bash:
echo "hello" > output.txt
test 4 -gt 7
echo $?   # => 1

# Nushell:
4 > 10
# => false
"hello" | save output.txt   # 重定向由专门的 save 命令处理
```

### 差异 3：`echo` 返回值，不直接写 stdout

`echo "Hello, World"` 在 Bash、Nushell（甚至 PowerShell、Fish）中**看起来**输出相同，但机制完全不同：

- 其他 Shell 把 `Hello, World` 直接发送到标准输出；
- Nushell 的 `echo` **只是返回一个值**，然后 Nushell 渲染该表达式（命令）的返回值。

因此字符串 `"Hello, World"` 与 `echo "Hello, World"` 的输出值是等价的：

```nu
"Hello, World" == (echo "Hello, World")
# => true
```

写 stdout 用 `print`；写文件用 `save`。

### 差异 4：隐式返回（implicit return）

Nushell 隐式返回表达式的值（类似 PowerShell 或 Rust）。表达式可以不只是管道——自定义命令（类似其他语言中的函数）也自动隐式返回最后一个值，不需要 `echo` 甚至 `return`：

```nu
def latest-file [] {
    ls | sort-by modified | last
}
```

该管道的输出（其「值」）就成了 `latest-file` 的返回值。在 Nushell 中，你可能写 `echo <something>` 的地方，大多数情况下可以直接写 `<something>`。

### 差异 5：每个表达式只有一个返回值

一个表达式只能返回一个值；若含多个子表达式，只有**最后一个**值被返回：

```nu
def latest-file [] {
    echo "Returning the last file"   # 第 2 行：echo 返回的值被丢弃！
    ls | sort-by modified | last     # 第 3 行：只有这个值被返回
}
```

新用户可能期望第 2 行输出文本、第 3 行返回文件；实际上第 2 行的值被丢弃了。要确保显示，用 `print`：

```nu
def latest-file [] {
    print "Returning last file"
    ls | sort-by modified | last
}
```

分号在 Nushell 表达式中与换行符相同：

```nu
40; 50; 60
# 等价于：
# 40
# 50
# 60
```

以上情况中：第一个值求值为整数 40 但不返回；50 求值但不返回；60 是最后一个值，被返回并显示（渲染）。调试意外结果时注意：子表达式输出了一个（非 `null`）值，而该值没有从父表达式返回——这往往是问题来源。

### 差异 6：没有「语句」，每个命令都返回一个值

有些语言有「语句」（不返回值）的概念，Nushell 没有。每个命令都返回一个值，即使该值是 `null`（`nothing` 类型）：

```nu
let p = 7
print $p
$p * 6
```

- 第 1 行：`7` 被赋给 `$p`，但 `let` 命令**本身**的返回值是 `null`；因为它不是表达式最后一个值，不会被显示。
- 第 2 行：`print` 本身的返回值是 `null`，但 `print` 强制其参数（`$p`，即 7）被显示；`null` 返回值同样被丢弃。
- 第 3 行：求值为整数 42，作为最后一个值被返回并显示。

熟悉常用命令的输出类型有助于组合命令：`help <command>` 会显示每个命令的签名，包括输出类型。

### 差异 7：把 Nushell 当作编译型语言——解析与求值分离

Nushell 运行代码有两个独立的高级阶段：

1. **阶段 1（解析器 parser）**：解析**整个**源代码
2. **阶段 2（引擎 engine）**：评估**整个**源代码

可以把解析阶段类比为静态语言（如 Rust、C++）中的编译：所有将在阶段 2 评估的代码，必须在解析阶段已知且可用。

基于静态解析构建的功能：准确且富有表现力的错误消息、更早更稳健的错误检测（语义分析）、IDE 集成、类型系统、模块系统、自动补全、自定义命令参数解析、语法高亮、实时错误高亮、分析和调试命令、（未来）格式化与 IR 编译加速。

⚠ 与 bash 不同（关键限制）：

- **不支持 `eval`** 这样的动态结构（Bash、Python 等动态语言有）。
- `source`、`use`、`overlay use`、`hide`、`source-env` 都是**解析器关键字**，在解析（阶段 1）期间就要求目标文件存在且可用。

对 `nu -c` 的影响：整个 `-c` 字符串作为单个表达式一起解析——「先运行生成文件、再 source 它」在同一条命令串里必然失败（在 REPL 中分行输入才可行，因为每行独立解析+求值）。

**示例：动态生成源代码**

```nu
"print Hello" | save output.nu
source output.nu
# => Error: nu::parser::sourced_file_not_found
# =>   × File not found: output.nu
# =>   help: sourced files need to be available before your script is run
```

原因：第 1 行被解析但未求值（`output.nu` 在求值阶段才被创建）；第 2 行解析时 `source` 试图读取 `output.nu`，此时文件还不存在。

**示例：动态创建要加载的文件名**

```nu
let my_path = "~/nushell-files"
source $"($my_path)/common.nu"
# => Error: nu::shell::not_a_constant
# =>   × Not a constant.
# =>   help: Only a subset of expressions are allowed constants during parsing.
# =>         Try using the 'const' command or typing the value literally.
```

`let` 赋值到求值时才生效，所以 `source` 遇到变量会在解析期失败。这与编译型语言一致——如同 C++ 不能写 `#include <my_path + "/common.h">`、Rust 不能写 `use format!("{}::common", my_path)`：编译型语言要求所有源文件预先准备好。

**修复**：用 `const` 定义常量（常量可在解析期间求值）：

```nu
const my_path = "~/nushell-files"
source $"($my_path)/common.nu"   # 正常工作
```

**示例：`cd` 后 `source` 相对路径**

```nu
if ('spam/foo.nu' | path exists) {
    cd spam
    source-env foo.nu   # 解析期错误！
}
```

解析期间 `source-env` 尝试解析 `foo.nu`，但 `cd` 到求值时才发生——于是在*当前*目录中找不到该文件。修复：直接使用完整路径 `source-env spam/foo.nu`。

### 差异 8：变量默认不可变

Nushell 变量默认不可变（immutable；可选的可变变量存在，见变量章节）。Nushell 的许多命令基于函数式编程风格，要求不可变性。不可变变量也是 `par-each` 命令的关键——它允许用线程并行处理多个值。如果习惯依赖可变变量，需要重新学习以更函数化的风格编写代码；用 `par-each` 并行运行部分代码还可获得性能提升。

### 差异 9：环境是作用域的（scoped environment）

Nushell 从编译型语言借鉴了「语言应避免全局可变状态」的理念。Shell 通常用全局突变更新环境，Nushell 试图避免这种方法：**块控制自己的环境，对环境的更改仅限于它们发生的块的作用域**。

实际收益示例——在每个子目录中构建项目：

```nu
ls | each { |row|
    cd $row.name
    make
}
```

`cd` 更改 `PWD` 环境变量，但该更改不会在块结束时保留。每次迭代都从当前目录开始，进入下一个子目录。作用域环境使命令更可预测、更易读、更易调试，也是 `par-each` 的另一个关键特性。

- `load-env` 命令可一次性加载多个环境更新。
- ⚠ 例外规则：`def --env` 允许创建一个更改父环境（parent environment）的自定义命令。

## 本章小结

以 Nushell 的方式思考的三条主线：

1. **数据流**：命令输出结构化类型数据；管道组合过滤器（`sort-by` / `where` / `get` / `select`）而非文本工具（`grep` / `awk` / `cut`）。
2. **表达式语义**：一切皆表达式、一切皆有返回值（可能是 `null`）；只有最后一个值被隐式返回；要副作用显示用 `print`，落盘用 `save`。
3. **静态编译模型**：先解析后求值，两阶段严格分离——`source` 类解析器关键字、`const` 常量、不可变变量、作用域环境都是这个模型的推论。
