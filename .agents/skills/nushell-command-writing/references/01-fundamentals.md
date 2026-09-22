# Nushell 基础：数据类型、字符串、管道与数据操作

> 本章来源：
> - https://www.nushell.sh/zh-CN/book/types_of_data.html
> - https://www.nushell.sh/zh-CN/book/loading_data.html
> - https://www.nushell.sh/zh-CN/book/pipelines.html
> - https://www.nushell.sh/zh-CN/book/working_with_strings.html
> - https://www.nushell.sh/zh-CN/book/working_with_lists.html
> - https://www.nushell.sh/zh-CN/book/working_with_tables.html

## Nu 数据模型：与 bash 的根本差异

- 传统 Unix shell 的命令之间通过**文本字符串**通信：一个命令把文本写入 stdout，另一个从 stdin 读取。
- Nu 继承了管道组合的思想，但命令之间传递的是**带类型的结构化值**（整数、表格、记录等），而不是纯文本。
- ⚠ 与 bash 不同：`ls`、`open` 等命令的输出不是格式化文本，而是可直接按列/行访问的 `table`；不需要 `awk`/`cut` 解析文本。

`describe` 命令返回管道中值的类型，是调试类型的第一工具：

```nu
42 | describe
# => int
```

## 数据类型总览

| 类型 | 类型标注 | 示例 |
| ---- | -------- | ---- |
| 整数 | `int` | `-65535` |
| 浮点数 | `float` | `9.9999`, `Infinity` |
| 字符串 | `string` | `"第18洞"`, `'第18洞'`, `` `第18洞` ``, 第18洞, `r#'第18洞'#` |
| 布尔值 | `bool` | `true` |
| 日期 | `datetime` | `2000-01-01` |
| 时间间隔 | `duration` | `2min + 12sec` |
| 文件大小 | `filesize` | `64mb` |
| 区间 | `range` | `0..4`, `0..<5`, `0..`, `..4` |
| 二进制数据 | `binary` | `0x[FE FF]` |
| 列表 | `list` | `[0 1 '二' 3]` |
| 记录 | `record` | `{name:"Nushell", lang: "Rust"}` |
| 表格 | `table` | `[{x:12, y:15}, {x:8, y:9}]`, `[[x, y]; [12, 15], [8, 9]]` |
| 闭包 | `closure` | `{|e| $e + 1 \| into string }` |
| 单元格路径 | `cell-path` | `$.name.0` |
| 代码块 | （无标注） | `if true { print "你好!" }` |
| 空值 | `nothing` | `null` |
| 任意类型 | `any` | `let p: any = 5` |

## 基础数据类型

### 整数 int

- 字面量：十进制、十六进制、八进制或二进制，不带小数点。如 `-100`, `0`, `50`, `+50`, `0xff`(十六进制), `0o234`(八进制), `0b10101`(二进制)。

```nu
10 / 2   # => 5
5 | describe   # => int
```

### 浮点数 float

- 字面量：带小数点的十进制数值。如 `1.5`, `2.0`, `-15.333`。

```nu
2.5 / 5.0        # => 0.5
10.2 * 5.1       # => 52.01999999999999  ⚠ 浮点数是近似值
```

### 布尔值 bool

字面量 `true` 或 `false`，通常是比较的结果，常用于控制执行流程：

```nu
let mybool: bool = (2 > 1)                    # => true
let mybool: bool = ($env.HOME | path exists)
let num = -2
if $num < 0 { print "It's negative" }         # => It's negative
```

### 日期 datetime

表示特定时间点，可格式化、可加减 duration：

```nu
date now                       # => Mon, 12 Aug 2024 13:59:22 -0400 (now)
date now | format date '%s'    # 格式化为 Unix 时间戳 => 1723485562
```

### 时间间隔 duration

表示时间段的字面量单位类型，支持分数值和算术：

```nu
3.14day        # => 3day 3hr 21min
30day / 1sec   # 30 天有多少秒 => 2592000
```

⚠ 与 bash 不同：bash 中时间单位是交给外部命令的字符串约定；Nu 的 duration 是一等类型，可直接参与运算（如 `(date now) + 1day`）。

### 文件大小 filesize

表示文件大小/字节数的特殊数值类型，支持分数值和计算。十进制(`kB`/`MB`)与二进制(`KiB`/`GiB`)单位并存：

```nu
0.5kB                    # => 500 B
1GiB / 1B                # => 1073741824
(1GiB / 1B) == 2 ** 30   # => true
```

### 区间 range

从起始值到结束值的数值范围，可选步长；`0..<5` 不含结束值，`0..`、`..4` 为开放端：

```nu
1..5       # => 1 2 3 4 5（输出为单列表格）
2..4..20   # 起始..第二个值(定步长)..结束
```

补充：`seq char` 命令可以类似区间的方式创建字符列表，`seq date` 创建日期列表。

### 二进制数据 binary

原始字节序列（如图像文件内容）。字面量：`0x[ffffffff]`(十六进制)、`0o[1234567]`(八进制)、`0b[10101010101]`(二进制)。
示例——确认 JPEG 文件以正确的标识符开头：

```nu
open nushell_logo.jpg | into binary | first 2 | $in == 0x[ff d8]
# => true
```

### 空值 nothing / null

`nothing` 类型表示值的缺失，字面量为 `null`。可选操作符 `?` 在单元格路径不存在时返回 `null`（而不是报错）：

```nu
let simple_record = { a: 5, b: 10 }
$simple_record.a?              # => 5
$simple_record.c?              # 无输出
$simple_record.c? | describe   # => nothing
$simple_record.c? == null      # => true
```

### 任意类型 any

用于类型标注或签名时匹配任何类型（其他类型的"超集"）：`let p: any = 5`。

### 闭包 closure

匿名函数（lambda），由 `{ }` 包裹、`|` 分隔参数与主体；它接受参数并"闭合"（即使用）其作用域外的变量：

```nu
let compare_closure = {|a| $a > 5 }
let original_list = [ 40 -4 0 8 12 16 -16 ]
$original_list | where $compare_closure   # => 40, 8, 12, 16（列表）
```

### 单元格路径 cell-path

用于导航到结构化值内部值的表达式：行号(整数)和列名(字符串)的**点分隔列表**，如 `name.4.5`。赋值给变量时用前导 `$.` 消除歧义：

```nu
let cp = $.2   # 索引 2
[ foo bar goo glue ] | get $cp   # => goo
```

单元格路径可深入嵌套结构，如 `$.name.0`、`$env.config.table.mode`。

## 结构化数据：list / record / table

结构化数据类型可以包含上述基本类型（也可互相嵌套），使一个值能表示多个值（如温度读数列表）。

### 列表 list

零个或多个任意类型值的**有序序列**：`[张三 李四 王五]` 输出为单列表格（0: 张三, 1: 李四, 2: 王五）。

### 记录 record

保存键值对，将字符串键与各种数据值关联：

```nu
let my_record = { name: "张三", rank: 99 }
$my_record | get name   # => 张三
```

### 表格 table（核心数据结构）

具有行和列的二维容器，每个单元格可以保存任何基本或结构化数据类型；许多命令返回表格。
⚠ 关键内部事实：**表格只是记录（record）列表**。任何提取或隔离表格特定行的命令都会产生**记录**：

```nu
[{x:12, y:5}, {x:3, y:6}] | get 0   # => 一个 record: {x: 12, y: 5}
```

表格有两种等价字面量：record 列表 `[{x:12, y:15}, {x:8, y:9}]`，或"列名; 行"形式 `[[x, y]; [12, 15], [8, 9]]`。

## 字符串

### 字符串格式一览

| 格式 | 示例 | 转义字符 | 说明 |
| ---- | ---- | -------- | ---- |
| 单引号 | `'[^\n]+'` | 无 | 字符串内不能包含单引号 |
| 双引号 | `"The\nEnd"` | C 风格反斜杠转义 | 所有字面反斜杠都必须转义 |
| 原始字符串 | `r#'Raw string'#` | 无 | 可以包含单引号 |
| 裸词 | `ozymandias` | 无 | 只能含"单词"字符；不能在命令位置使用 |
| 反引号 | `` `[^\n]+` `` | 无 | 可含空格的裸字符串；不能包含反引号 |
| 单引号插值 | `$'Captain ($name)'` | 无 | 不能包含 `'` 或不匹配的 `()` |
| 双引号插值 | `$"Captain ($name)"` | C 风格反斜杠转义 | 字面反斜杠和 `()` 都必须转义 |

单引号字符串不对文本做任何处理；双引号支持 `\` 转义：

```nu
'hello world'    # => hello world
"hello\nworld"   # => hello / world（两行）
```

双引号支持的转义：`\"` `\'` `\\` `\/` `\b`(退格) `\f`(换页) `\r`(回车) `\n`(换行) `\t`(制表符) `\u{X...}`(Unicode，1-6 位十六进制)。

### 原始字符串

由 `r#'` 与 `'#` 包围，可包含单引号（类似 Rust）；用更多 `#` 可嵌套：

```nu
r#'原始字符串可以包含'引号'文本'#
r###'r##'这是一个原始字符串的例子'##'###
```

### 裸词字符串（⚠ 与 bash 不同）

单个"词"组成的字符串可以不加引号：`[hello] | describe` => `list<string>`。
⚠ 但**在命令位置**直接使用裸词（或放在 `(` `)` 内）会被解释为**外部命令**，不是字符串：

```nu
hello             # => Error: nu::shell::external_command (executable was not found)
trueX | describe  # => Error: nu::shell::external_command
```

且许多裸词有特殊含义：`true` 是 `bool`（`[true] | describe` => `list<bool>`），不是 string。

### 反引号字符串

可包含空格的裸字符串，在表达式第一个位置会被解释为命令或路径，适合把 glob 与含空格路径组合：

```nu
`ls`            # 运行路径中找到的外部 ls 二进制
`./my dir`      # 切换到 "my dir" 子目录
ls `./my dir/*`
```

### 用 `^` 强制执行外部命令

任何字符串（包括变量）前加 `^` 即作为外部命令执行，或使用 `run-external`：

```nu
^'C:\Program Files\exiftool.exe'
let foo = 'C:\Program Files\exiftool.exe'
^$foo
```

### 字符串插值

`$" "`（支持转义）与 `$' '`（不支持转义）两种形式；`()` 内是可执行的表达式：

```nu
let name = "Alice"
$"greetings, ($name)"   # => greetings, Alice
$"2 + 2 is (2 + 2) \(you guessed it!)"   # => 2 + 2 is 4 (you guessed it!)
```

### 字符串拼接

```nu
['foo', 'bar'] | each {|s| '~/' ++ $s}   # ~/foo, ~/bar（++ 也适用于列表拼接）
['foo', 'bar'] | each {|s| '~/' + $s}    # 字符串 + 等价于 ++
"hello" | append "world!" | str join " " # hello world!
1..10 | reduce -f "" {|elt, acc| $acc + ($elt | into string) + " + "}
# 通常 str join 更简单、更正确（reduce 版末尾会多出 " + "）
```

### 分割字符串

- `split row <分隔符>`：字符串 → **列表**。`"red,green,blue" | split row ","` => `[red green blue]`
- `split column <分隔符>`：字符串 → **表格**（每元素一列，默认列名 column1/column2/...）
- `split chars`：字符串 → 字符列表

### `str` 命令速查

许多字符串函数是 `str` 的子命令，`help str` 查看完整列表。

```nu
"hello world" | str contains "w"        # => true
'       My   string   ' | str trim      # 去两侧空白 => My   string
'=== Nu shell ===' | str trim -r -c '=' # 右侧修剪 '=' => === Nu shell
'Hello World!' | str index-of 'o'       # => 4
'Hello World!' | str substring 4..8     # => o Wo
'1234' | fill -a right -c '0' -w 10     # => 0000001234（对齐/填充）
'Nushell' | str reverse                 # => llehsuN（可作用于列表）
```

### 解析字符串 parse

把字符串解析成表格列：`{name}` 占位符或 `--regex` 命名捕获组：

```nu
'Nushell is the best' | parse '{shell} is {type}'
# => shell=Nushell, type=the best 的表格
'Bash is kinda cringe' | parse --regex '(?P<shell>\w+) is (?P<type>[\w\s]+)'
```

### 字符串比较

除 `==`/`!=` 外，还有正则与前后缀操作符：

```nu
'APL' =~ '^\w{0,3}$'             # => true（匹配正则）
'FORTRAN' !~ '^\w{0,3}$'         # => true（不匹配）
'JavaScript' starts-with 'Java'  # => true
'OCaml' ends-with 'Caml'         # => true
```

### 字符串类型转换

- 转 string：`123 | into string`，或插值 `$'(123)'`
- string 转其他：`'123' | into int`（`into <type>` 系列）

### 字符串着色

`ansi` 命令产生 ANSI 转义序列，应始终以 `ansi reset` 结束着色字符串：
`$'(ansi purple_bold)This text is a bold purple!(ansi reset)'`

## 管道

Nu 的核心设计之一。管道由三部分组成：**输入**（源/生产者，如 `open`、`ls`）、**过滤器**（处理输入，如 `update`）、**输出**（接收者，如 `save`）：

```nu
open Cargo.toml | update workspace.dependencies.base64 0.24.2 | save Cargo_new.toml
```

`$in` 变量可把管道收集成一个值，将整个流作为一个参数访问：

```nu
[1 2 3] | $in.1 * $in.2   # => 6
```

### 多行管道与分号

管道太长时可放进 `(` 和 `)`。`line1; line2 | line3`：分号使其前的命令运行到完成并在屏幕上显示，分号后是新的正常管道。⚠ 分号处不产生管道输出，紧跟分号后的 `$in` 不起作用。

### `$in` 的完整规则

- **规则 1**：在闭包/块中管道**第一个位置**使用时，`$in` 指该闭包/块的管道输入。例：`def echo_me [] { print $in }`，`true | echo_me` => true。
- **规则 1.5**：同一作用域内，闭包/块中任何行的管道第一个位置的 `$in` 都是同一个值（每次迭代内不变）。
- **规则 2**：在管道**其他位置**使用时，`$in` 指**前一个表达式**的结果：

```nu
4
| $in * $in     # $in 为 4
| $in / 2       # $in 现在为 16
| $in           # $in 现在为 8
# => 8
```

- **规则 2.5**：闭包/块内规则 2 发生在新作用域（子表达式）中，"新"的 `$in` 只在子表达式内有效，子表达式结束后原始 `$in` 恢复；规则 1 与规则 2 可在同一闭包中共存。
- **规则 3**：没有输入时 `$in` 为 null：`do { $in | describe }` => `nothing`。
- **规则 4**：分号分隔的多语句行中，`$in` 不能捕获前一**语句**的结果：

```nu
ls / | get name; $in | describe    # => nothing
ls / | get name | $in | describe   # => list<string>（继续管道才有效）
```

最佳实践：在闭包/块第一行把 `$in` 赋给变量，提高可读性（`let day = $in`）。

`$in` 可收集性：目前对流使用 `$in` 会产生"已收集"值（管道会等待流完成），但该行为未来不保证；要显式收集请用 `collect` 命令。正常管道输入足够时避免用 `$in`——它内部强制从 `PipelineData` 转换为 `Value`，可能有性能/内存开销。

过滤器闭包中的 `$in`：多数过滤器中 `$in` 与闭包参数相同（`1..10 | each {$in * 2}` 等价于 `each {|value| $value * 2}`）。例外：`update` 闭包的管道输入（`$in`）指正在更新的**列**，闭包参数指整个 record，因此 `ls | update name {str upcase}` 与 `ls | update name {|file| $file.name | str upcase}` 等价。

### 命令的输入/输出类型（单值流 vs 多值流）

Nu 命令类似函数：每个命令有**输入/输出类型签名**，`help <command>` 可查看 `Input/output types` 表。管道中流动的是零个或多个值（单值或表格流），命令签名决定了它能接什么、吐什么。

```nu
help first   # input: list<any> | binary | range → output: any | binary | any
help ls      # input: nothing → output: table（只支持输出，不支持输入）
```

⚠ `ls` 忽略管道输入：`echo .. | ls` 会忽略输入流、默认列出当前目录。要把输入接进这类命令，必须显式引用并作为参数传递：`echo .. | ls $in`。且 `$in` 需与参数类型匹配：`[dir1 dir2] | ls $in` 会失败（`can't convert list<string> to string`）。
没有输入行为的命令（如 `sleep`，签名 `nothing → nothing`）收到管道输入时直接报错（`Missing required positional argument`），而不是像 `ls` 那样静默忽略。不确定时查 `help`。

### 与外部命令交互（⚠ 与 bash 不同）

- `internal_command | external_command`：数据转换为**字符串**流向外部命令的 stdin。
- `external_command | internal_command`：字节流入 Nu，Nushell 尝试自动转换为 UTF-8 文本；成功则文本流，不成功则 binary 流。`lines` 命令便于按行接收外部数据。
- `external_command_1 | external_command_2`：与 bash 等其他 shell 相同，stdout 接 stdin。

⚠ 结构化数据传给外部命令前会先被**渲染成带边框字符（`╭` `─` `┬` `╮`）的表格文本**，通常不是你想要的。必须先显式转成字符串：

```nu
ls /usr/share/nvim/runtime/ | get name | to text | ^grep tutor | tr -d '\n' | ^ls -la $in
# 简单场景可用 find：... | find tutor | ansi strip | ^ls -al ...$in
```

### Nu 命令的输出显示（⚠ 与 bash 不同）

Nu 命令类似函数，**大多数不会向 stdout 打印任何内容，只返回数据**：

```nu
do { ls; ls; ls; "What?!" }
# 只显示 "What?!"（前三个 ls 的返回值被丢弃，不打印目录）
```

交互模式下管道结束时由 `display_output` 钩子决定显示方式（默认用 `table` 命令渲染）。若需尽早显示，可在作用域内显式 `| table` 或用 `print`。注意 `$env` 修改是作用域内的：`do { $env.config.table.mode = "none"; ls }` 块外的渲染不受影响。

## 加载数据

### open：多功能数据加载

`open` 可处理多种数据格式，Nu 支持的文件类型会被**解析成结构化数据**（表格/记录），不只是文本：

```nu
open editors/vscode/package.json | get version   # => 1.0.0
```

`open` 直接支持从以下格式加载表数据：`csv`、`eml`、`ics`、`ini`、`json`、`nuon`、`ods`、SQLite 数据库、`ssv`、`toml`、`tsv`、`url`、`vcf`、`xlsx` / `xls`、`xml`、`yaml` / `yml`。
其他文本文件（如 `open README.md`）返回其内容——本质上就是一个大字符串。
提示：`open` 底层在作用域中查找与扩展名匹配的 `from ...` 子命令；创建自定义 `from ...` 子命令即可扩展 `open`。
扩展名不匹配时，用 `from <格式>` 手动转换（如 Cargo.lock 实为 toml）：`open Cargo.lock | from toml`。每种 Nu 能打开并理解的结构化文本格式都有对应的 `from` 命令。

### 原始模式与 NUON

`--raw` 获得原始文本：`open Cargo.toml --raw`。
NUON（Nushell 对象表示法）：NUON 代码是描述数据结构的**有效 Nushell 代码**。**NUON 是 JSON 的超集**——任何 JSON 都是有效 NUON；且更"人性化"：允许注释、不需要逗号。限制：不能表示所有 Nushell 数据类型，最值得注意的是**不允许序列化代码块**。

### SQLite 与 URLs

SQLite 数据库被 `open` **自动检测，无论扩展名**：

```nu
open foo.db                                        # 整个数据库
open foo.db | get some_table                       # 特定表
open foo.db | query db "select * from some_table"  # 任意 SQL 查询
```

`http get` 从互联网加载 URL 内容（如 `http get https://blog.rust-lang.org/feed.xml` 返回解析后的结构化数据）。

### 非结构化文本 → 表格管线（惯用法）

对外部来的字符串数据，典型加载管线（逐行 → 分列 → 修剪 → 命名列 → 排序）：

```nu
open people.txt | lines                      # 每行一个元素（回到列表）
| split column "|" first_name last_name job  # 按分隔符分列，自定义列名
| str trim                                   # 去除多余空白
| sort-by first_name                         # 之后即可用表格命令处理
```

`split column` 预设默认列名 `column1`/`column2`/...，可用 `get column1` 取一列。

## 列表操作

### 创建与展开

方括号创建，元素用空格和/或逗号分隔：`[foo bar baz]` 或 `[foo, bar, baz]`。
展开运算符 `...` 把列表展开（可穿插值）拼接：

```nu
let x = [1 2]
[ ...$x  3  ...(4..7 | take 2) ]   # => 1 2 3 4 5
```

### 增删改（返回新列表）

```nu
[1, 2, 3, 4] | insert 2 10   # => [1, 2, 10, 3, 4]（在索引 2 处插入）
[1, 2, 3, 4] | update 1 10   # => [1, 10, 3, 4]（替换索引 1）
let colors = [yellow green]
let colors = ($colors | prepend red)      # 头部插入
let colors = ($colors | append purple)    # 尾部追加
let colors = ($colors ++ ["blue"])        # ++ 拼接列表
let colors = (["black"] ++ $colors)       # => [black red yellow green purple blue]
let colors = ($colors | skip 1 | drop 2)  # skip 跳过前 n 项，drop 去掉末尾 n 项
$colors | last 3   # 取末尾 n 项
$colors | first 2  # 取开头 n 项
```

### 迭代与过滤

- `each` + 代码块遍历元素；`--numbered`/`-n`（或 `enumerate`）获得 `index` 与 `item`：

```nu
let names = [Mark Tami Amanda Jeremy]
$names | each { |name| $"Hello, ($name)!" }
$names | enumerate | each { |item| $"($item.index + 1) - ($item.item)" }
```

- `where` 按条件过滤出子集（块必须求值为 boolean）：

```nu
let colors = [red orange yellow green blue purple]
$colors | where ($it | str ends-with 'e')
let scores = [7 10 8 6 7]
$scores | where $it > 7   # => [10 8]
```

- `reduce` 计算单一值：块参数为当前元素 `elt` 与累加器 `acc`；`--fold`/`-f` 设初值；`-n` 使 `elt` 含 `index`/`item`：

```nu
let scores = [3 8 4]
$scores | reduce { |elt, acc| $acc + $elt }          # => 15
$scores | math sum                                    # 更简单，结果相同
$scores | reduce --fold 1 { |elt, acc| $acc * $elt }  # => 96
$scores | reduce -n { |elt, acc| $acc.item + $elt.index * $elt.item }  # => 19
```

### 聚合判断与成员测试

```nu
$colors | any {|elt| $elt | str ends-with "e" }   # 任一匹配 => true
$colors | all {|elt| ($elt | str length) >= 3 }   # 全部匹配才 true
[red green blue] | length        # => 3
$colors | is-empty               # 字符串/列表/表格是否为空
'blue' in $colors                # => true
'gold' not-in $colors            # => true
```

### 访问列表

- 直接索引：`$names.1` => `Tami`（`$name.index` 形式）
- 索引在变量中用 `get`：`$names | get $index`

### 转换

```nu
[1 [2 3] 4 [5 6]] | flatten    # => [1 2 3 4 5 6]
[[1 2] [3 [4 5 [6 7 8]]]] | flatten | flatten | flatten   # 逐层压平
$zones | wrap 'Zone'           # 列表 → 单列表格
```

## 表格操作

### 排序 sort-by

按可比较的列排序（如 `size`、`name`、`accessed`、`modified`）：`ls | sort-by size`。

### 选取 select / 提取 get（⚠ 二者区别是高频考点）

- `select`：创建只包括指定列的**新表**（列名保留）；也可按**行号**选行（`ls | sort-by name | select 5` 返回第 5 行组成的单行表）。
- `get`：以**列表**形式返回指定列内的**值**（列名消失）；且可深入单元格内部的数据路径。

```nu
ls | select name size   # 两列表格
ls | get name           # 文件名列表
```

缩小行范围用 `first`/`skip`：`ls | sort-by size | first 5 | skip 2`。

### 拼接与合并

- `append` 拼接列名相同的表（行追加）：`$first | append $second`。
- `merge` 合并表（列合并，接受闭包/记录参数）：`$first | merge { $second }`；多表可链式或用 reduce 动态合并：

```nu
[$first $second $third] | reduce {|elt, acc| $acc | merge { $elt }}
```

### 修改数据：insert / update / upsert

⚠ 函数式语义：本节所有命令在管道中返回**新表**，不修改原表/原文件；要持久化需 `save`：

```nu
open rustfmt.toml | insert next_edition 2021    # 新列（已存在则报错）
open rustfmt.toml | update edition 2021         # 改已有列
open rustfmt.toml | upsert edition 2021         # 列存在则更新，不存在则插入
open rustfmt.toml | insert next_edition 2021 | save rustfmt2.toml
```

`update` 的闭包形式可基于原值计算：`ls | update name {str upcase}`（`$in` 指该列）。

### 列操作：move / rename / reject

```nu
ls | move name --after size                   # 移动列位置
ls | rename filename filetype filesize date   # 重命名列
ls -l / | reject readonly num_links inode created accessed modified   # 删除列
```

### 索引列 `#`

每个表格默认有一个 `#` 标题的索引列：内部从 0 开始的连续索引，对应单元格路径行号（`select 0` 取第一项）；它只是显示，不能通过列名访问。若创建名为 "index" 的列会取代 `#` 显示；若部分行有 `index` 键而其他没有，结果不再是 `table` 而是 `list<any>`。
有用模式：

```nu
ls | enumerate | flatten   # 把内部 # 转换为保留原始编号的索引列
let totals_row = ($table | math sum | insert index {"Totals"})   # 借 index 列加"合计"行标题
```

### table 渲染命令

`table` 用于渲染结构化数据（表格/列表/记录/区间），结果实际是 `string`（`... | table | describe` => `string (stream)`）。选项：`-e` 展开折叠数据；`-i false` 隐藏索引列；`-a 5` 缩写为只显示前 5 项和后 5 项。
（改变交互输出默认渲染可配置 `display_output` 钩子，默认即 `table`。）
