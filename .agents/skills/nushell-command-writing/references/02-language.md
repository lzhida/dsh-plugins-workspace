# 语言核心：def 签名、变量、运算符、脚本与模块

> 本章来源：
> - https://www.nushell.sh/zh-CN/book/custom_commands.html
> - https://www.nushell.sh/zh-CN/book/aliases.html
> - https://www.nushell.sh/zh-CN/book/operators.html
> - https://www.nushell.sh/zh-CN/book/variables.html
> - https://www.nushell.sh/zh-CN/book/scripts.html
> - https://www.nushell.sh/zh-CN/book/modules.html（其实质内容位于子页 https://www.nushell.sh/zh-CN/book/modules/using_modules.html 与 https://www.nushell.sh/zh-CN/book/modules/creating_modules.html，均已覆盖）
> - https://www.nushell.sh/zh-CN/book/overlays.html
> - https://www.nushell.sh/zh-CN/book/testing.html

读者提醒：本章面向通过 `nu --no-config-file -c <command>` 非交互执行 Nushell 的场景，REPL 技巧与 config 持久化仅一笔带过。
## 自定义命令（def）
### 基本定义与隐式返回
```nu
def greet [name] {
  $"Hello, ($name)!"
}
greet "World"
# => Hello, World!
```
- 参数 `name` 在块内绑定为 `$name` 变量。
- Nushell 是**隐式返回**：命令中最后一个表达式的值就是返回值，无需 `return`/`echo`：
```nu
def eight [] {
  1 + 1
  2 + 2
  4 + 4
}
eight
# => 8   （前两个表达式求值但被丢弃，只有最后一个成为返回值）
```
- 提前退出可用 `return`，如 `if $input_length > 10_000 { return null }`。
- 要使命令"不返回值"（作为语句），在管道末尾加 `ignore`，如 `[ file1 file2 file3 ] | each {|filename| touch $filename } | ignore`；或让最后一个表达式为 `null`。
- ⚠ 陷阱：`for` 是**不返回值的语句**。`for x in [0 1 2 3] { 3 ** $x }` 作为命令体最后表达式时返回值为 `null`，什么都不显示。要产出值请用 `each` 等过滤器：`[0 1 2 3] | each {|x| 3 ** $x }`。
- `match` 也可作为最后的表达式（如按条件返回不同值）。
### 管道输入与输出
自定义命令的返回值可继续入管道，也可接受管道输入（可用时流式处理）：
```nu
def my-ls [] { ls }
my-ls | get name            # 与 ls | get name 相同；慢速文件系统上仍逐行流式返回

def double [] { each { |num| 2 * $num } }
[1 2 3] | double            # => [2 4 6]（表格形式）
# 1.. | each {||} | double  # 输入未结束时 double 仍可随到随处理（流式）
```
用 `$in` 变量把管道输入暂存供后续使用：
```nu
def nullify [...cols] {
  let start = $in
  $cols | reduce --fold $start { |col, table| $table | upsert $col null }
}
ls | nullify name size      # 将 name、size 两列置为 null
```
### 命令名与子命令
- 合法命令名示例：`greet`、`get-size`、`mycommand123`、`my command`（含空格）、`命令` 甚至 `😊`。惯例是多个单词用 `-` 分隔（`get-size` 优于 `getsize`）。
- 无法调用/应避免的名字：`1`/`"1"`/`"1.5"`（不允许数字名）、`4MiB`（不允许文件大小名）、含 `#` 或 `^` 的名字、`-a`/`"{foo}"`/`"(bar)"`（会被解释为 flag、闭包或表达式）。`"+foo"` 这类虽可能有效，但解析器规则可能变化，尽量用简单名字。
- `def` 是**解析器关键字**：命令名必须在解析时已知，不能是变量或常量——`let name = "foo"; def $name [] { ... }` 不允许。
- 子命令：用带空格的引号名定义，如 `def "str mycommand" [] { "hello" }`，之后 `str mycommand` 即可调用。
### def 签名：位置参数
参数写在 `def` 命令的 `[]`（一个 list）中，多个参数用空格、逗号或换行分隔，三种写法等价：
```nu
def greet [name1 name2] { ... }   # 空格
def greet [name1, name2] { ... }  # 逗号
def greet [
  name1
  name2
] { ... }                         # 换行
```
- 位置参数默认是**必需**的；缺参在解析期即报错（非运行期）：
```nu
greet Wei
# => Error: nu::parser::missing_positional
# =>   × Missing required positional argument.
# =>   help: Usage: greet <name1> <name2> . Use `--help` for more information.
```
- 解析器会实时检测：多输入第三个参数时，执行前就将其高亮为错误。
### 可选位置参数（`?`）
参数名后加 `?` 定义可选参数；未传时其值为 `null`：
```nu
def greet [name?: string] {
  $"Hello, ($name | default 'You')"
}
greet
# => Hello, You
```
也可直接对 `null` 分支：`match $name { null => "Hello! I don't know your name!", _ => $"Hello, ($name)!" }`。
- 注意：块内变量名不含 `?`（写 `$name` 而非 `$name?`）。
- 必需与可选位置参数混用时，必需的必须排在前面。
### 参数默认值（`=`）
```nu
def greet [name = "Nushell"] {
  $"Hello, ($name)!"
}
greet          # => Hello, Nushell!
greet world    # => Hello, World!
```
默认值可与类型标注组合：`def congratulate [age: int = 18] { ... }`。带默认值的参数在调用时同样是可选的。
### 参数类型标注
```nu
def greet [name: string] { $"Hello, ($name)" }
```
- 无类型注解的参数视为 `any` 类型。
- 标注类型后，**解析期**做类型检查，不匹配直接报错：
```nu
def greet [name: int] { $"hello ($name)" }
greet World
# => Error: nu::parser::parse_mismatch
# =>   × Parse mismatch during operation.
# =>         ╰── expected int
```
可用于参数注解的类型：
- 特殊"形状"：`number`（接受 `int` 或 `float`）、`path`（字符串，`~` 和 `.` 会自动扩展为完整路径）、`directory`（`path` 子集，tab 补全时只提供目录，扩展方式与 `path` 相同）、`error`（目前无已知有效用法）。
- 常规类型：`any`、`binary`、`bool`、`cell-path`、`closure`、`datetime`、`duration`、`filesize`、`float`、`glob`、`int`、`list`、`nothing`、`range`、`record`、`string`、`table`。
⚠ 与 bash 不同：类型检查发生在解析期——`nu -c 'greet World'` 在执行前就因类型不匹配失败，而不是运行到一半报错。
### 标志（命名参数，`--flag`）
```nu
def greet [
  name: string
  --age: int
] {
  { name: $name, age: $age }
}
```
- 位置参数（无 `?`）是必需的；命名标志是可选的，未传时为 `null`（如 `greet World` 时 `$age` 为 `null`）。
- 标志可放在位置参数之前或之后：`greet Lucia --age 23` 与 `greet --age 39 Ali` 均有效。
- 短标志：`--age (-a): int`，之后 `-a 35` 即可；⚠ 块内变量始终基于长名，是 `$age`，`$a` 无效。
- 布尔开关标志：不写类型即开关，存在为 `true`，不存在为 `false`：
```nu
def greet [name: string, --caps] {
  let greeting = $"Hello, ($name)!"
  if $caps { $greeting | str upcase } else { $greeting }
}
greet Miguel --caps        # => HELLO, MIGUEL!
greet Chukwuemeka          # => Hello, Chukwuemeka!
greet Giulia --caps=false  # => Hello, Giulia!（可显式赋 true/false）
```
- ⚠ 陷阱：`greet Gabriel --caps true` 中空格会把 `true` 当成下一个位置参数；传布尔值必须用等号 `--caps=true`。为避免混淆，**不允许**给标志注解 `bool` 类型（`--caps: bool` 非法）。
- 含连字符的标志（如 `--all-caps`）在块内用下划线访问：`$all_caps`。
### 剩余参数（rest 参数，`...`）
```nu
def multi-greet [...names: string] {
  for $name in $names {
    print $"Hello, ($name)!"
  }
}
multi-greet Elin Lars Erik   # => Hello, Elin! / Hello, Lars! / Hello, Erik!
```
- 收集任意数量（含零个）位置参数到 `$names` 列表。
- 可与位置参数混用：`def vip-greet [vip: string, ...names: string] { ... }`，第一个参数给 `$vip`，其余进 `$names`（`vip-greet Rahul Priya Arjun` 中 `Rahul` 是 `$vip`，其余依次打印）。
- 传列表给剩余参数用展开运算符：`vip-greet $vip ...$guests`（`let guests = [ Dwayne, Shanice, Jerome ]`）。
### def --wrapped：包装外部命令
`def --wrapped` 会把任何**未知**的标志和参数收进剩余参数，再经列表展开转发给外部命令，从而"包装"外部命令并保留其全部原始参数：
```nu
def --wrapped ezal [...rest] {
  eza -l ...$rest
}
ezal commands        # 长列表输出
ezal -d commands     # -d 并非 ezal 自己的参数，被收集进 $rest 转发
```
还可以检查 `$rest` 内容并改变行为，如 `if '-G' in $rest { eza ...$rest } else { eza -l --icons ...$rest }`。
### 管道输入输出签名
默认自定义命令接受/输出 `<any>`，可显式缩小：
```nu
def "str stats" []: string -> record { }
# string -> record 表示：接受 string 管道输入，输出 record
```
- 多组输入输出类型写在 `[]` 中，逗号或换行分隔：`def "str join" [separator?: string]: [ list -> string, string -> string ] { }`（可接受 `list<any>` 或 `string` 输入，输出 `string`）。
- 不需要管道输入的命令输入类型为 `nothing`；返回 `null` 的命令（如 `rm`、`hide`）输出类型也是 `nothing`：`def xhide [module: string, members?]: nothing -> nothing { }`。
- 签名显示在 `help` 中，可内省：`help commands | where name == <command_name>` 或 `scope commands | where name == <command_name>`。
- 解析期还能据此捕获两类错误：
  - 输出类型不符：`def inc []: int -> int { $in + 1; print "Did it!" }` → `nu::parser::output_type_mismatch`（`print` 返回 `nothing`，与声明的 `int` 不符）。
  - 输入类型不符：`def inc []: int -> int { $in + 1 }` 后 `"Hi" | inc` → `nu::parser::input_type_mismatch`（Command does not support string input）。
### 为命令添加文档
- `def` 语句紧邻上方的注释成为 `help` 的描述：第一个空注释行之前是 `description`，其余为 `extra_description`（tab 补全时也会显示）。
- 参数后面的同行注释成为参数描述（只允许单行，且 `#` 前需要空格）：
```nu
# 问候客人和一位贵宾
#
# 用于生日、毕业派对等庆祝活动。
def vip-greet [
  vip: string        # 特别嘉宾
  ...names: string   # 其他客人
] { ... }
```
- Nushell 自动为每个自定义命令生成基本帮助并添加 `--help`/`-h` 标志。
### 自定义命令中的环境作用域
- 块内对 `$env` 的修改在块结束时**丢失**（作用域化）：`def foo [] { $env.FOO = 'After' }` 执行后外部 `$env.FOO` 仍是 `"Before"`。
- 用 `def --env`（模块中用 `export def --env`）定义的命令，环境更改保留到调用方。
- `cd` 本质是修改 `$env.PWD`，同样在命令结束后被重置（如 `def --env go-home [] { cd ~ }` 才能真正切换）。
## 别名（alias）
`alias` 提供简单的命令调用替换（含外部与内部命令），可为带默认参数的长命令建简写：
```nu
alias ll = ls -l
ll        # 等价 ls -l
ll -a     # 等价 ls -l -a（可继续传 flag/位置参数）
```
- 查看所有别名：`scope aliases` 或 `help aliases`。
- ⚠ **alias 不能包含管道**：`alias uuidgen = uuidgen | tr A-F a-f` 无效。替代方案是定义无参命令并通过 `^` 调用外部程序：`def uuidgen [] { ^uuidgen | tr A-F a-f }`。
- 覆盖内置命令时必须先用 alias "备份"，因为与 `def` 不同，**别名是位置相关的**（在其定义处展开）。直接 `def ls [] { ls }` 会导致无限递归：`Error: nu::shell::recursion_limit_reached × Recursion limit (50) reached`。
- 推荐的遮蔽（shadow）模式：
```nu
alias ls-builtin = ls          # 备份内置 ls

def ls [
  --all (-a),
  --long (-l),
  ...pattern: glob,
]: [ nothing -> table ] {
  let pattern = if ($pattern | is-empty) { [ '.' ] } else { $pattern }
  (ls-builtin --all=$all --long=$long ...$pattern) | sort-by type name -i
}
```
（示例为节选，原文还逐个转发 `--short-names`、`--full-paths`、`--du`、`--directory`、`--mime-type`、`--threads` 等全部标志，形如 `--all=$all`。）
## 运算符
Nushell 支持的常见数学、逻辑与字符串运算符（按类别归组，均为原文运算符全集）：
- 算术：`+` 加、`-` 减、`*` 乘、`/` 除、`//` 整除、`mod` 取模、`**` 幂
- 比较：`==` 等于、`!=` 不等于、`<` 小于、`<=` 小于等于、`>` 大于、`>=` 大于等于
- 正则/包含：`=~` 或 `like`（正则匹配/字符串包含）、`!~` 或 `not-like`（正则不匹配/字符串*不*包含）
- 成员：`in`（值在列表中）、`not-in`、`has`（列表包含值）、`not-has`
- 逻辑：`not`（一元取反）、`and`（两个布尔值与，短路）、`or`（短路）、`xor`
- 位运算：`bit-or` 按位或、`bit-xor` 按位异或、`bit-and` 按位与、`bit-shl` 按位左移、`bit-shr` 按位右移
- 字符串：`starts-with` 开始检测、`ends-with` 结尾检测；追加：`++`（追加列表）
圆括号可分组指定求值顺序，也可用于调用命令并在表达式中使用其结果。
### 结合顺序（优先级）
查看优先级：`help operators | sort-by precedence -r`。按优先级降序：圆括号 `()` → 幂 `**` → 乘除整除取模 `* / // mod` → 加减 `+ -` → 位移 `bit-shl`/`bit-shr` → 比较（`==` `!=` `<` `>` `<=` `>=`）与成员测试（`in` `not-in` `starts-with` `ends-with`）与正则匹配（`=~` `!~`）与列表追加 `++`（同级）→ `bit-and` → `bit-xor` → `bit-or` → `and` → `xor` → `or` → 赋值操作 → `not`。
```nu
3 * (1 + 2)
# => 9
```
⚠ 与 bash 不同：没有 `-a`/`-o` 这类 test 运算符，逻辑运算就是 `and`/`or` 关键字；位运算用 `bit-and` 等命名运算符而非 `&`/`|`（`|` 是管道）。
### 运算符与类型匹配规则
并非所有操作对所有数据类型有意义。对不兼容类型执行操作会得到解释性错误：
```nu
"spam" - 1
# => Error: nu::parser::unsupported_operation
# =>   × Types mismatched for operation.
# =>   help: Change string or int to be the right types and try again.
```
规则有时感觉严格，但换来的是更少的意外副作用。⚠ 注意这是**解析期**错误：`nu -c '"spam" - 1'` 根本不会开始执行。
### 正则 / 字符串包含运算符
- `string =~ pattern`：`string` 匹配 `pattern` 返回 `true`，否则 `false`；`!~` 相反。
- 底层是 Rust regex 包的 `is_match()` 函数。
```nu
foobarbaz =~ bar        # true
foobarbaz !~ bar        # false
ls | where name =~ ^nu  # 所有以 "nu" 开头的文件名
```
运算符通常区分大小写，三种不敏感做法：
```nu
"FOO" =~ "(?i)foo"                            # 正则 (?i) 修饰器 => true
"FOO" | str contains --ignore-case "foo"      # str contains 的 --ignore-case
("FOO" | str downcase) == ("Foo" | str downcase)  # 先转小写再比较
```
### 扩展运算符（spread，`...`）
用于解包列表和记录，可在三个位置使用：列表字面量、记录字面量、命令调用。
列表字面量中（仅可扩展 `...$变量`、`...(子表达式)`、`...[列表字面量]`，**不能**扩展字符串字面量）：
```nu
let dogs = [Spot, Teddy, Tommy]
let cats = ["Mr. Humphrey Montgomery", Kitten]
[
  ...$dogs
  Polly
  ...($cats | each { |elt| $"($elt) \(cat\)" })
  ...[Porky Bessie]
  ...Nemo
]
# 注意最后一项成为字面 "...Nemo"：列表字面量中 ... 不能扩展字符串
```
⚠ 与 `append` 链相比（`$dogs | append Polly | append ... `），`...` 不创建中间列表，反复拼接大列表时有（非常微小的）性能优势。⚠ `...` 与下一表达式之间有任何空格就不会被识别为扩展（`[ ... [] ]` 得到字面元素 `...` 与空列表），主要是避免 `mv ... $dir` 被误解。
记录字面量中（合并字段，同样只支持变量/子表达式/记录字面量，且中间不能有空格）：
```nu
let config = { path: /tmp, limit: 5 }
{
  ...$config,
  users: [alice bob],
  ...{ url: example.com },
  ...(sys mem)
}
```
命令调用中（要求命令有剩余参数或为外部命令）：
```nu
def foo [ --flag req opt? ...args ] {
  { flag: $flag, req: $req, opt: $opt, args: $args } | to nuon
}
foo "bar" "baz" ...[1 2 3]
# => { flag: false, req: bar, opt: baz, args: [1, 2, 3] }
foo "bar" "baz" [1 2 3]
# => { flag: false, req: bar, opt: baz, args: [[1, 2, 3]] }  # 不用 ... 则整个列表是单个参数
```
转发另一个命令的剩余参数（⚠ 相当于 bash 的 `"$@"`）：
```nu
def bar [ ...args ] { foo --flag "bar" "baz" ...$args }
bar 1 2 3
# => { flag: true, req: bar, opt: baz, args: [1, 2, 3] }
```
更多规则（均来自原文）：
- 一次调用可展开多个列表、穿插单个参数：`foo "bar" "baz" 1 ...[2 3] 4 5 ...(6..9 | take 2) last`。
- 标志/命名参数可以跟在扩展参数之后：`foo "bar" "baz" 1 ...[2 3] --flag 4`。
- 若扩展参数出现在可选位置参数之前，则该可选参数被视为省略：`foo "bar" ...[1 2] "not opt"` → `opt` 为 `null`，`args` 为 `[1, 2, "not opt"]`。
## 变量
Nushell 用 `let`、`const`、`mut` 三种关键字声明变量，用 `$` + 名称引用。
### 不可变变量（let）
声明后不能赋值更改；对它赋值报错：
```nu
let val = 42
$val          # => 42
$val = 100
# => Error: nu::shell::assignment_requires_mutable_variable
# =>   × Assignment to an immutable variable.
```
但可以被**遮蔽**（shadow）——重新声明后，同一作用域内旧值不再可用；内层作用域的遮蔽不影响外层：
```nu
let val = 42
do { let val = 101; $val }   # => 101（内层遮蔽）
$val                          # => 42（外层不变）
let val = $val + 1            # 外层遮蔽
$val                          # => 43，原值 42 不再可用
```
⚠ 与 bash 不同：bash 的所有变量实质可变且全局，Nushell 默认不可变，且作用域按块（`do {}`、`def {}` 等）隔离。
### 可变变量（mut）
```nu
mut val = 42
$val += 27
$val
# => 69
```
可用赋值运算符：

| 运算符 | 描述 |
| --- | --- |
| `=` | 赋新值 |
| `+=` | 加一个值 |
| `-=` | 减一个值 |
| `*=` | 乘一个值 |
| `/=` | 除一个值 |
| `++=` | 将列表或值附加到变量 |

注意：`+=` 等只在根操作可行的上下文有效（如加法会失败的上下文就不能用 `+=`）；`++=` 要求变量**或**参数是列表。
⚠ 与 bash 不同：Nushell 赋值是 `let`/`mut` 声明 + `=`，不存在 bash 的 `FOO=bar`（无关键字裸赋值）语法；赋值只对 `mut` 变量合法。
### mut 的捕获限制（重要陷阱）
**闭包和嵌套 `def` 不能从其环境中捕获可变变量**：
```nu
mut x = 0
[1 2 3] | each { $x += 1 }   # 错误：$x 在闭包中被捕获
```
需要此类行为时官方鼓励使用循环，或函数式方案（更常用）：
- 循环计数器内置在迭代命令中：`ls | enumerate | each { |elt| $"Item #($elt.index) is size ($elt.item.size)" }`。
- 累积用 `reduce`（求最长字符串）：
```nu
[one, two, three, four, five, six] | reduce {|current_item, max|
  if ($current_item | str length) > ($max | str length) {
    $current_item
  } else {
    $max
  }
}
# => three
```
- `generate` 可对接任意源（如 REST API），也无需可变变量。
### 为什么优先不可变
- 大多数 `mut` 用例有函数式替代：只用不可变变量、性能更好、支持流式处理、支持 `par-each` 并行（`each` 换 `par-each` 即可并行，这是 Nushell 设计依赖不可变性、组合与流水线的成果）。
- 性能实测（原文数据）：`for` + `mut` 追加构建 50,000 个随机数列表耗时约 **1 分 4 秒**；`1..50_000 | each { random int }` 仅 **19 毫秒**；`each` 做 10,000,000 次迭代约 4.2 秒。`each` 等过滤器还流式输出，下游无需等待收集。
- `const` 常量：解析时即可完全求值的不可变变量，用于需要解析期已知参数值的命令（`source`、`use`、`plugin use`）：
```nu
const script_file = 'path/to/script.nu'
source $script_file
```
### 变量名规则
变量名不能包含这些字符：`. [ ( { + - * ^ / = ! < > & |`。
以 `$` 开头声明是允许的：`let $var = 42` 与 `let var = 42` 等价。
## 脚本
用 `nu` 运行脚本文件（新实例中运行至完成）：`nu myscript.nu`；也可用 `source` 在**当前**实例中运行：`source myscript.nu`。
### 处理顺序：定义先行
```nu
# myscript.nu
def greet [name] { ["hello" $name] }
greet "world"
```
脚本中所有定义**先**运行（无论写在文件何处），然后从文件顶部一条条运行其余命令。因此 `greet "world"` 写在 `def greet` 之前也有效。
脚本行视角：`a` 与 `b; c | d` 两行——Nushell 先运行 `a` 至完成；分号将多个命令串在一行依次执行，非最后一个命令的输出不打印（分号语义见 pipelines 一章）。
### main 命令与参数传递
脚本可包含特殊 `main` 命令，在其他 Nu 代码之后运行，用于接收脚本名后的参数（`nu <script> <args>`）：
```nu
# myscript.nu
def main [x: int] {
  $x + 10
}
```
```nu
nu myscript.nu 100
# => 110
```
参数类型：未注解时按 `Type::Any` 处理，按表观类型解析；显式注解则按注解类型解析：
```nu
# implicit_type.nu: def main [x] { $"Hello ($x | describe) ($x)" }
nu implicit_type.nu +1
# => Hello int 1

# explicit_type.nu: def main [x: string] { $"Hello ($x | describe) ($x)" }
nu explicit_type.nu +1
# => Hello string +1
```
### 脚本子命令
```nu
# myscript.nu
def "main run" [] { print "running" }
def "main build" [] { print "building" }
def main [] { print "hello from myscript!" }
```
```nu
nu myscript.nu          # => hello from myscript!
nu myscript.nu build    # => building
nu myscript.nu run      # => running
```
- 与模块不同，脚本中的 `main` **不需要导出**即可执行；但若把该文件当模块 `use`，`myscript` 命令不存在（未导出）。
- ⚠ 陷阱：必须定义 `main` 命令，`main` 的子命令才能被正确暴露。只写 `def "main run"` / `def "main build"` 而没有 `main`，`nu myscript.nu run` 无法访问子命令（这是当前脚本处理方式的限制）。只有子命令的脚本可加空 `main`：`def main [] {}`。
### Shebang
Linux/macOS 可用 `#!/usr/bin/env nu` 使文件被 Nu 解释；需要读标准输入时用 `#!/usr/bin/env -S nu --stdin`（块内经 `$in` 取输入）。
## 模块
模块是定义的"容器"，可容纳：自定义命令、别名、常量、外部命令（extern）、环境变量、其他模块（子模块）。
### 模块文件形式
- `mod.nu` 文件：其**目录名**成为模块名（目录形式，适合较大项目，子模块可映射到子目录）。
- `<module_name>.nu` 文件：文件名成为模块名（文件形式，适合简单模块）。
- 导入后两种形式行为相同，只有路径不同。技术上也可显式 `use increment/mod.nu *`，但用 `mod.nu` 时首选目录简写。
### use：导入语法
```nu
use <路径/到/模块> <成员...>
```
模块路径可为：含 `mod.nu` 的绝对/相对路径、`.nu` 模块文件路径、虚拟目录（如内置标准库 `std`）、`module` 命令创建的模块名（不常见，主要用于模块作者定义子模块）。相对路径先从当前目录查找，找不到再搜索 `$env.NU_LIB_DIRS` 列表中的目录。
导入模式（`use` 后的内容）决定导入方式：
```nu
use std/log                       # 整个子模块作为命令导入：log info "..." 等子命令可用
use std                            # 则命令变成 std log info
use std/formats *                  # 导入所有定义直接进当前作用域（如 to jsonl，不再是 formats 的子命令）
use std/math PI                    # 只导入单个定义（常量 PI）
use std/formats [ 'from ndjson' 'to ndjson' ]  # 导入列表（不常见）
```
- ⚠ 性能提示：`use <模块> <子模块>`（如 `use std help`）会把整个父模块及所有定义都*解析*；将子模块作为*模块*加载（`use std/help`）会得到更快的代码。
- 导入常量：整模块导入时经同名记录访问，全量导入时直接可见：
```nu
use std/math
$math.PI        # => 3.141592653589793
use std/math *
$PI             # => 3.141592653589793
```
### 隐藏（hide）
任何自定义命令/别名（无论是否来自模块）都可用 `hide` 恢复之前的定义。`hide` 接受类似 `use` 的导入模式：名字是命令则直接隐藏；是模块名则隐藏所有以该模块名为前缀的导出。也可选择性隐藏：`hide assert main`（隐藏 `assert` 命令本身但保留其子命令；`main` 表示"与模块同名的命令"）。
### 创建模块与导出
模块（及子模块）两种创建方式：最常见的是创建包含一系列 `export` 语句的文件；或用 `module` 命令（主要用于定义子模块）。导出语句种类：
- `export def` 命令、`export alias` 别名、`export const` 常量、`export extern` 已知外部命令声明
- `export module` 子模块（及其成员）、`export use` 从其他模块导入的符号（重导出）、`export-env` 环境设置块
- 只有带 `export` 的定义在导入时可见；不带 `export` 的是模块内**私有/本地**定义（如 `alpha-num-range` 只在模块内被 `"str is-alphanumeric"` 使用，导入后无法访问）。
- ⚠ **导出名不能与模块同名**：`increment.nu` 文件（模块名 `increment`）里 `export def increment` 会报 `nu::parser::named_as_module`。解法是导出为 `main`，导入时自动采用模块名：
```nu
# increment.nu
export def main []: int -> int { $in + 1 }
```
```nu
use ./increment.nu
2024 | increment    # => 2025
```
- `main` 导入规则：`use <module>`、`use <module> *`、`use <module> main`（或 `[main]`）会导入 `main` 定义；`use <module> <其他定义>` 不会。`main` 可用于 `export def` 和 `export extern`。
### 模块内子命令
两种方式等价地产生 `increment by` 子命令：
```nu
export def "increment by" [amount: int]: int -> int { $in + $amount }  # 带全名（配合 use increment *）
export def by [amount: int]: int -> int { $in + $amount }              # 简名（配合 use increment 导入整个模块后即成为 increment by）
```
### 子模块：export module 与 export use
```nu
# my-utils/mod.nu 形式一：导出子模块及其成员（scope modules 中父模块本身无命令、只有子模块）
export module ./increment.nu
export module ./range-into-list.nu
```
```nu
# 形式二：把子模块的定义重导出为父模块自身成员（命令成为 my-utils 的直接成员）
export use ./increment.nu
export use ./range-into-list.nu
```
- `export module` 是推荐且最常见的形式；`export use` 的独特价值是**选择性导出**子模块中的定义（`export module` 做不到）：
```nu
export use ./go.nu [home, modules]   # 只重导出 home 与 modules，不带前缀
export module go {                    # 带前缀的选择性导出：产生 go home / go modules
  export use ./go.nu [home, modules]
}
```
- 不带 `export` 的 `module` 只定义本地模块，不导出子模块。
### 模块文档与环境
- 模块文件开头的注释行成为模块文档，`help <module_name>` 可查看（`export use` 重导出的命令也显示在主模块帮助中）。
- `export-env` 块在 `use` 导入时**求值**并合并进当前作用域：
```nu
export-env {
  $env.NU_MODULES_DIR = ($nu.default-config-dir | path join "scripts")
}
# use my-utils 后 $env.NU_MODULES_DIR 即可用
```
- ⚠ 陷阱：`export-env` 只在 `use` 调用被*求值*时运行。在模块 A 中 `use my-utils` 只是*解析*了 my-utils，其 `export-env` 不会运行——A 的命令里 `$env.NU_MODULES_DIR` 会找不到。解法：在需要的命令体内 `use my-utils`（命令运行时求值）；或在 A 的 `export-env { use my-utils [] }` 中只取环境（`use my-utils []` 除环境外不导入任何内容，且会随 A 的 export-env 求值而执行）。
- 模块内命令默认使用自己的环境作用域（如命令内 `cd` 不外泄到用户作用域），与 `def --env` 规则一致。
- ⚠ `.nu` 文件不能与其模块目录同名（如 `spam/spam.nu`），否则定义名二义。Windows 上建议模块内一律用正斜杠 `/`。
## 覆层（overlay，精简）
覆层是定义（命令、别名、环境变量）的"层"，可按需激活/停用，类似 Python 虚拟环境，构建在模块之上。非交互执行场景低频，掌握以下要点即可：
- 默认覆层为 `zero`；`overlay list` 查看活动覆层栈。
- `overlay use <module>` 激活（等价导入模块全部定义并求值其 `export-env`）；`overlay hide [name]` 移除（无参数移除最后活动的覆层）。
- 覆层有作用域：`do { overlay use spam; foo }` 中覆层仅在块内活动。
- 新定义被记录到最后活动覆层，hide 后可 `overlay use` 找回；`overlay new <name>` 创建空的记录用覆层（如 scratchpad，避免污染被引入的覆层）。
- `--prefix` 使命令保留 `模块名 命令` 前缀形式（不适用于环境变量）；`as` 可重命名覆层（如给通用的 `activate.nu` 一个描述性名字）；`--keep-custom` / `--keep-env [ VAR ]` 在 hide 时保留自定义定义/指定环境变量。
- 多个覆层含同名定义时，最后活动的覆层优先（栈顶）；把某覆层放回栈顶可再次 `overlay use` 它。
## 测试（std 标准库测试，精简）
标准库提供断言命令，先 `use std/assert` 导入：
- `assert (1 == 2)` 条件不真时抛 `Assertion failed.` 错误；可附加消息：`assert ($a == 19) $"The lockout code is wrong, received: ($a)"`。
- 专用断言给出更好的错误信息，如 `assert str contains $b $a`（提示 value: "haystack" 不包含 'a needle'）、`assert equal` 等。
- 自定义断言经 `--error-label` 定制错误标签：
```nu
def "assert even" [number: int] {
  assert ($number mod 2 == 0) --error-label {
    text: $"($number) is not an even number",
    span: (metadata $number).span,
  }
}
```
运行测试的三种方式：
1. **Nupm 包**：在包的 `nupm.nuon` 旁建 `tests/` 目录并加 `mod.nu` 使其为有效模块；从 `tests` 模块**完全导出**的命令即测试（`export def some-test` 会运行，普通 `def` 不会；`export use spam.nu *` 时 `spam.nu` 中的导出也会运行），调用 `nupm test`。
2. **独立脚本**：写一个 `tests.nu`（`use math.nu fib` + `use std/assert`，用 for 循环对 `[input, expected]` 表逐个 `assert equal (fib $t.input) $t.expected`），以 `nu tests.nu` 调用，可挂 Makefile/CI。
3. **基本测试框架**：以 `test <名字>` 命名测试函数（描述以 `# ignore` 开头可跳过），脚本 `main` 里用 `scope commands | where ($it.type == "custom") and ($it.name | str starts-with "test ") and not ($it.description | str starts-with "ignore")` 发现测试，并在第二个 `nu --commands` 实例中运行；可扩展出 setup/teardown 与跨文件发现。
## 与 bash 直觉差异速查
- 命令是隐式返回，最后一个表达式的值即输出；`for`/分号等语句无值。
- 变量必须经 `let`/`mut`/`const` 声明，引用必须带 `$`；无 `FOO=bar` 裸赋值；`mut` 不能被闭包/嵌套 `def` 捕获。
- 类型不匹配（含运算符类型、参数类型、管道 I/O 签名）大多在**解析期**报错，`nu -c` 执行前即失败。
- 脚本参数进 `main` 命令签名（`nu script.nu 100`），不是 `$1`/`$@`；转发剩余参数用 `...$args` 展开语法。
- 管道 `|` 是唯一的数据流通道；位与/位或是 `bit-and`/`bit-or`，`|` 永远是管道。
- alias 不能含管道且位置相关；覆盖内置命令需先 alias 备份再 def 遮蔽。
