# 迁移对照与代码执行原理

> 本章来源（Nushell 官方书 zh-CN）：
>
> - <https://www.nushell.sh/zh-CN/book/coming_from_bash.html>（从 Bash 到 Nu）
> - <https://www.nushell.sh/zh-CN/book/coming_from_cmd.html>（从 CMD.EXE 到 Nu）
> - <https://www.nushell.sh/zh-CN/book/nushell_map.html>（从其他 Shell 或 DSL 到 Nu）
> - <https://www.nushell.sh/zh-CN/book/nushell_map_imperative.html>（从命令式语言到 Nu）
> - <https://www.nushell.sh/zh-CN/book/nushell_map_functional.html>（从函数式语言到 Nu）
> - <https://www.nushell.sh/zh-CN/book/nushell_operator_map.html>（Nushell 运算符）
> - <https://www.nushell.sh/zh-CN/book/how_nushell_code_gets_run.html>（Nushell 代码执行原理）

先读「执行模型」一节：它解释了为什么大量 bash 语法在 Nu 中不仅是习惯不同，而是**直接非法**。随后的各对照表可直接查表迁移。

## 执行模型：解析与求值严格分离

### 两阶段流水线

Nushell、Python、Bash 都是"解释型"语言。一个最小的 Nu 程序：

```nu
# hello.nu
print "Hello, World!"
```

`nu hello.nu` 按预期运行。但 Nushell 的"解释器"分为明确的两段：

```text
源代码 → 解析器 → 中间表示(IR)
IR → 评估引擎 → 结果
```

源代码先被解析器分析并转换为 IR（一组数据结构，类比 Python 的字节码），然后 IR 被传给评估引擎求值并输出结果。

编译型语言（C、C++、Rust）的流程与此在高层几乎无区别：`rustc main.rs` 把源代码编译为机器码，机器码再由 CPU 执行——可以把机器码视为另一种 IR，把 CPU 视为其"解释器"。编译-运行序列与解析-求值序列结构相同。

### 没有 eval —— 与动态 shell 的本质差异

解释型与编译型语言的一个重大区别：解释型语言通常实现 `eval` 函数，编译型语言则没有。"静态/动态"的关键判据即是否具有求值函数：

- **静态**语言在编译/解析阶段执行更多代码分析（类型检查、数据所有权等）
- **动态**语言在求值/运行时执行更多分析，包括对额外代码的求值函数调用

Python 的 `eval`/`exec`、Bash 的 `eval` 是典型求值函数：参数是"源代码中的源代码"，通常动态生成。解释器遇到它时会中断正常求值，对参数启动**新的**解析/求值过程：

```python
# hello_eval.py
print("Hello, World!")
eval("print('Hello, Eval!')")
```

运行输出两条消息。求值 `eval(...)` 时：解析器先解析字符串参数 `print('Hello, Eval!')`，再求值它——在求值过程中嵌入了"递归"解析步骤，字节码可以在求值过程中被进一步修改。

**Nushell 禁止类似 eval 的功能**。其根本设计：严格分离解析和求值阶段，并禁止求值函数。

影响示例（Python）：

```python
exec("def hello(): print('Hello eval!')")
hello()
```

直到求值第 1 行之前，解释器根本不知道存在 `hello` 函数——这使动态语言的静态分析困难：仅通过解析源代码无法检查函数是否存在，必须运行代码才能发现。若函数被有条件地定义/调用，可能直到生产环境才暴露为运行时错误。而在静态编译型语言中，缺失的函数保证在编译时被发现。

Nushell 只有两个步骤：

1. 解析整个源代码
2. 求值整个源代码

因此：

- **调用不存在的定义保证在解析时被发现**（不必等运行）
- 解析完成后 IR 在求值过程中**不会改变**——这使静态分析与 IDE 集成强大可靠

⚠ 与 bash 不同：在 Nu 中无法把字符串当代码执行（没有 `eval`/`source /dev/stdin` 式的动态求值）；语法错误、未定义的命令/变量在解析期即报错，而不是逐行跑到一半才失败。

### REPL 的独立解析-求值序列（与脚本行为差异的根源）

`nu` 不带文件参数启动 REPL（读取→求值→打印循环）。每次按 Enter，Nushell 会：

1. (读取) 读取命令行输入
2. (求值) 解析命令行输入
3. (求值) 求值命令行输入
4. (求值) 将环境（如当前工作目录）合并到 Nushell 内部状态
5. (打印) 显示结果（如果非 null）
6. (循环) 等待下一个输入

每个 REPL 调用是**独立的**解析-求值序列，通过把环境合并回状态保持调用间连续性。关键示例：

```nu
cd spam
source-env foo.nu
```

作为脚本（或单一表达式，包括传给 `nu -c`）时**不能工作**：目录更改发生在解析时 `source-env` 关键字尝试读取文件**之后**——`source-env` 解析时 `foo.nu` 相对路径还指不到 `spam/` 下。

在 REPL 中分两次 Enter 运行则成功：`cd spam` 求值后环境（含新目录）在下一步读取/解析 `source-env` 前已合并进状态。

用分号或换行连成的一条多行命令行（`cd spam; source-env foo.nu`）在 REPL 中也作为**单个块**处理，与脚本一样失败。因此：`source`/`use` 等解析期关键字的参数不能依赖同一块内先求值的命令。

### 解析时常量求值（const 与 source/use）

虽然不能在求值阶段添加解析，但可以在**解析过程中**安全地做少量求值。术语"常量"指：

- `const` 定义的值
- 提供常量输入时输出常量值的任何命令的结果

即常量/常量值在**解析时已知**（与运行时的变量相对）。因此可作为 `source`、`use` 等解析时关键字的参数：

```nu
let my_path = "~/nushell-files"
source $"($my_path)/common.nu"    # 失败：let 的值运行时才知道，source 解析时读不到
```

```nu
const my_path = "~/nushell-files"
source $"($my_path)/common.nu"    # 成功：const 在解析期被求值
```

`const` 版本的完整流程：整个程序解析为 IR——`const` 赋值在解析期即被求值（名称与值由解析器存储）；`source` 也是解析器关键字，在解析期求值，参数已知、可检索；随后 `common.nu` 的源代码被解析（无效则报错），其 IR 进入下一阶段求值。

注意方向区别：

- `eval` 在**求值期间**添加额外的解析
- 解析时常量求值相反，在**解析器中**添加额外的求值

解析期间允许的求值**非常有限**，仅限常规求值的一小部分：

```nu
const foo_contents = (open foo.nu)   # 不允许：open 不产生常量值
```

能产生常量值的命令必须：设计为输出常量值，且所有输入也是常量值、字面量或字面量的复合类型（记录/列表/表格）；一般**没有副作用**（否则解析器可能进入不可恢复状态，如把无限流赋给常量——解析永不结束）。

查看哪些命令可返回常量值：

```nu
help commands | where is_const
```

`path join` 可输出常量值；`$nu` 常量记录提供多个有用路径，可组合出解析时常量：

```nu
const my_startup_modules = $nu.default-config-dir | path join "my-mods"
use $"($my_startup_modules)/my-utils.nu"
```

类比：C 预处理器、Rust 宏、Zig 的 comptime（Nushell 此设计的灵感来源）。

### 结论

Nushell 是"解释型"（代码立即运行，无手动编译），但**不是"动态"**（没有求值函数构造）。在这方面它与 Rust、Zig 等"静态"编译型语言更多共同点。把 Nushell 视为**编译型静态语言**是官方推荐的心智模型。

## ⚠ 与 bash/POSIX 直觉不同：高频错误源速查

以下差异全部来自官方 bash 对照表与执行原理页，按出错频率排序。写 Nu 命令时逐条自检：

1. **命令替换** `$(cmd)` 不存在 → `(cmd)`。bash 的 `$()` 在 Nu 中是语法错误。
2. **命令输出作多参数**需 spread：`stat $(which git)` → `stat ...(which git).path`。
3. **字符串插值**必须用 `$"..."`：`echo /tmp/$RANDOM` → `$"/tmp/(random int)"`；选项值同理：`cargo b --jobs=$(nproc)` → `cargo b $"--jobs=(sys cpu | length)"`。普通 `"..."` 内不做插值。
4. **`&&` 不存在**：`command1 && command2` 的官方 Nu 对应写法是 `command1; command2`。
5. **逻辑运算用关键字** `and`/`or`，不是 `&&`/`||`（见运算符对照表）。
6. **退出码** `$?` → `$env.LAST_EXIT_CODE`。
7. **重定向语法完全不同**：`>` → `out>` 或 `o>`；`>>` → `out>>` 或 `o>>`；`> /dev/null` → `ignore`；`> /dev/null 2>&1` → `out+err>| ignore` 或 `o+e>| ignore`；`cmd 2>&1 | less` → `cmd out+err>| less`。结构化输出存文件用 `save`（不用 `>`）。
8. **tee**：`cmd1 | tee log.txt | cmd2` → `cmd1 | tee { save log.txt } | cmd2`。
9. **cat** → `open --raw`（按文本）或 `open`（按结构化数据解析）。
10. **head/tail** → `first 5` / `last`；`command | head -5` → `command | first 5`。
11. **find/grep** → 递归找文件用 glob：`find . -name *.rs` → `ls **/*.rs`；过滤文本用 `where $it =~ <substring>` 或 `find <substring>`。
12. **sed** → `str replace`。
13. **mkdir 默认递归**（等价 bash `mkdir -p`，无需 `-p`）。
14. **rm**：递归删除用 `rm -r`（对应 `rm -rf`）；`rm -t` 把文件移入系统垃圾箱。
15. **遍历文件**：`for f in *.md; do echo $f; done` → `ls *.md | each { $in.name }`（`ls` 产出结构化表格，`$in` 是当前行）。
16. **`ls -d */`**（只列目录）→ `ls | where type == dir`。
17. **环境变量赋值**：`export FOO=BAR` → `$env.FOO = BAR`；`unset FOO` → `hide-env FOO`；`${FOO:-fallback}` → `$env.FOO? | default "ABC"`；临时单命令前缀 `FOO=BAR ./bin` 在 Nu 中同样可用。
18. **PATH 追加**：`export PATH=$PATH:/x` → `$env.PATH = ($env.PATH | append '/x')`（放前面用 `prepend`）。Windows 上变量名是 `$env.Path`。
19. **alias 语法**：`alias s="git status -sb"` → `alias s = git status -sb`（`=` 两侧有空格、值不加引号）。
20. **type FOO** → `which FOO`。
21. **脚本调用**：`bash -c <commands>` → `nu -c <commands>`；`bash <script>` → `nu <script>`。
22. **续行符 `\` 不存在**：用 `( ... )` 包裹表达式即可跨多行。
23. **交互读入**：`read var` → `let var = input`；`read -s secret`（不回显）→ `let secret = input -s`。
24. **无 eval**：任何"拼字符串再执行"的思路都不成立；解析期即报未定义错误。
25. **Windows + Git Bash**：`ln`、`grep`、`vi` 等外部命令默认不可用（除非已在 Windows PATH 中），需 `$env.Path = ($env.Path | prepend 'C:\Program Files\Git\usr\bin')` 才能用。

## Bash → Nu 逐模式对照表

官方"命令等价物"全表（来源：coming_from_bash）。左列是 bash 直觉写法，右列是 Nu 正确写法——模型写 Nu 命令前先查此表：

| Bash | Nu | 任务 |
| --- | --- | --- |
| `ls` | `ls` | 列出当前目录中的文件 |
| `ls <dir>` | `ls <dir>` | 列出给定目录中的文件 |
| `ls pattern*` | `ls pattern*` | 列出匹配给定模式的文件 |
| `ls -la` | `ls --long --all` 或 `ls -la` | 列出包含所有可用信息的文件，包括隐藏文件 |
| `ls -d */` | `ls \| where type == dir` | 列出目录 |
| `find . -name *.rs` | `ls **/*.rs` | 递归地查找匹配给定模式的所有文件 |
| `find . -name Makefile \| xargs vim` | `ls **/Makefile \| get name \| vim ...$in` | 将值作为命令参数传递 |
| `cd <directory>` | `cd <directory>` | 切换到给定目录 |
| `cd` | `cd` | 切换到用户主目录 |
| `cd -` | `cd -` | 切换到前一个目录 |
| `mkdir <path>` | `mkdir <path>` | 创建给定的路径 |
| `mkdir -p <path>` | `mkdir <path>` | 创建给定的路径，父目录不存在则自动创建 |
| `touch test.txt` | `touch test.txt` | 新建文件 |
| `> <path>` | `out> <path>` 或 `o> <path>` | 保存命令输出到文件 |
| | `save <path>` | 将命令输出作为结构化数据保存到文件 |
| `>> <path>` | `out>> <path>` 或 `o>> <path>` | 追加命令输出到文件 |
| | `save --append <path>` | 将命令输出作为结构化数据追加到文件 |
| `> /dev/null` | `ignore` | 丢弃命令输出 |
| `> /dev/null 2>&1` | `out+err>\| ignore` 或 `o+e>\| ignore` | 丢弃命令输出，包括 stderr |
| `command 2>&1 \| less` | `command out+err>\| less` 或 `command o+e>\| less` | 将外部命令的 stdout 和 stderr 通过管道传给 less（内部命令的分页输出请用 `explore`） |
| `cmd1 \| tee log.txt \| cmd2` | `cmd1 \| tee { save log.txt } \| cmd2` | 将命令输出 tee 到日志文件 |
| `command \| head -5` | `command \| first 5` | 将内部命令的输出限制为前 5 行（另见 `last` 和 `skip`） |
| `cat <path>` | `open --raw <path>` | 显示给定文件的内容 |
| | `open <path>` | 将文件作为结构化数据读取 |
| `mv <source> <dest>` | `mv <source> <dest>` | 移动文件到新的位置 |
| `for f in *.md; do echo $f; done` | `ls *.md \| each { $in.name }` | 遍历列表并返回结果 |
| `for i in $(seq 1 10); do echo $i; done` | `for i in 1..10 { print $i }` | 遍历列表并对结果运行命令 |
| `cp <source> <dest>` | `cp <source> <dest>` | 复制文件到新的位置 |
| `cp -r <source> <dest>` | `cp -r <source> <dest>` | 递归地将目录复制到一个新的位置 |
| `rm <path>` | `rm <path>` | 删除给定的文件 |
| | `rm -t <path>` | 将给定的文件移到系统垃圾箱 |
| `rm -rf <path>` | `rm -r <path>` | 递归地删除给定的路径 |
| `date -d <date>` | `"<date>" \| into datetime -f <format>` | 解析日期 |
| `sed` | `str replace` | 查找和替换一个字符串中的模式 |
| `grep <pattern>` | `where $it =~ <substring>` 或 `find <substring>` | 过滤包含特定字符串的字符串 |
| `man <command>` | `help <command>` | 获得特定命令的帮助信息 |
| | `help commands` | 列出所有可用的命令 |
| | `help --find <string>` | 在所有可用的命令中搜索 |
| `command1 && command2` | `command1; command2` | 运行一条命令，成功的话再运行第二条 |
| `stat $(which git)` | `stat ...(which git).path` | 使用命令输出作为其他命令的参数 |
| `echo /tmp/$RANDOM` | `$"/tmp/(random int)"` | 在字符串中使用命令输出 |
| `cargo b --jobs=$(nproc)` | `cargo b $"--jobs=(sys cpu \| length)"` | 在选项中使用命令输出 |
| `echo $PATH` | `$env.PATH`（非 Windows）或 `$env.Path`（Windows） | 查看当前路径 |
| `echo $?` | `$env.LAST_EXIT_CODE` | 查看最后执行命令的退出状态 |
| `<update ~/.bashrc>` | `vim $nu.config-path` | 永久地更新 PATH |
| `export PATH = $PATH:/usr/other/bin` | `$env.PATH = ($env.PATH \| append /usr/other/bin)` | 临时更新 PATH |
| `export` | `$env` | 列出当前的环境变量 |
| `<update ~/.bashrc>` | `vim $nu.config-path` | 永久地更新环境变量 |
| `FOO=BAR ./bin` | `FOO=BAR ./bin` | 临时修改环境变量 |
| `export FOO=BAR` | `$env.FOO = BAR` | 为当前会话设置环境变量 |
| `echo $FOO` | `$env.FOO` | 使用环境变量 |
| `echo ${FOO:-fallback}` | `$env.FOO? \| default "ABC"` | 在未设置变量时使用备用值 |
| `unset FOO` | `hide-env FOO` | 取消对当前会话的环境变量设置 |
| `alias s="git status -sb"` | `alias s = git status -sb` | 临时定义一个别名 |
| `type FOO` | `which FOO` | 显示一个命令的信息（内置、别名或可执行） |
| `<update ~/.bashrc>` | `vim $nu.config-path` | 永久添加和编辑别名（新开 Shell 会话生效） |
| `bash -c <commands>` | `nu -c <commands>` | 运行一组命令 |
| `bash <script file>` | `nu <script file>` | 运行一个脚本文件 |
| `\`（续行） | `( <command> )` | 当命令被 `(` 和 `)` 包裹的时候可以跨多行 |
| `pwd` 或 `echo $PWD` | `pwd` 或 `$env.PWD` | 显示当前目录 |
| `read var` | `let var = input` | 从用户获取输入 |
| `read -s secret` | `let secret = input -s` | 从用户获取秘密值而不打印按键 |

### 历史替换（仅 REPL，不可用于脚本/`nu -c`）

`!!`（上一条命令行）、`!$`（上一条最后一个空格分隔标记）、`!<n>`（如 `!5`，历史开头第 n 条）、`!<-n>`（如 `!-5`，历史末尾第 n 条）、`!<string>`（如 `!ls`，最近以该字符串开头的历史项）；`history | enumerate | last 10` 显示最近的记录。⚠ 与 bash 不同：bash 在按 Enter 后立即执行历史替换；Nushell 是把替换**插入**到命令行中让你确认后再执行——这纯粹是 REPL 交互行为，程序化执行时不存在。

## 从 CMD.EXE 到 Nu（精简对照）

下表为 coming_from_cmd 全表中存在 Nu 对应物的行（此表最后更新于 Nu 0.67.0）：

| CMD.EXE | Nu | 任务 |
| --- | --- | --- |
| `CALL <filename.bat>` | `<filename.bat>` | 运行批处理程序 |
| | `nu <filename>` | 在新上下文中运行 nu 脚本 |
| | `source <filename>` | 在此上下文中运行 nu 脚本 |
| | `use <filename>` | 将 nu 脚本作为模块运行 |
| `CD` 或 `CHDIR` | `$env.PWD` | 获取当前工作目录 |
| `CD <directory>` | `cd <directory>` | 更改当前目录 |
| `CD /D <drive:directory>` | `cd <drive:directory>` | 更改当前目录（跨盘符） |
| `CLS` | `clear` | 清除屏幕 |
| `COPY <source> <destination>` | `cp <source> <destination>` | 复制文件 |
| `COPY <file1>+<file2> <destination>` | `[<file1>, <file2>] \| each { open --raw } \| str join \| save --raw <destination>` | 将多个文件追加到一个文件中 |
| `DATE /T` | `date now` | 获取当前日期 |
| `DEL` 或 `ERASE <file>` | `rm <file>` | 删除文件 |
| `DIR` | `ls` | 列出当前目录中的文件 |
| `ECHO <message>` | `print <message>` | 将给定值打印到标准输出 |
| `ENDLOCAL` | `export-env` | 在调用者中更改环境 |
| `EXIT` | `exit` | 关闭提示符或脚本 |
| `FOR %<var> IN (<set>) DO <command>` | `for $<var> in <set> { <command> }` | 为集合中的每个项目运行命令 |
| `IF ERRORLEVEL <number> <command>` | `if $env.LAST_EXIT_CODE >= <number> { <command> }` | 退出码 >= 指定值时运行命令 |
| `IF <string> EQU <string> <command>` | `if <string> == <string> { <command> }` | 字符串匹配时运行命令 |
| `IF EXIST <filename> <command>` | `if (<filename> \| path exists) { <command> }` | 文件存在时运行命令 |
| `IF DEFINED <variable> <command>` | `if '$<variable>' in (scope variables).name { <command> }` | 变量已定义时运行命令 |
| `MD` 或 `MKDIR` | `mkdir` | 创建目录 |
| `MOVE` | `mv` | 移动文件 |
| `PATH` | `$env.Path` | 显示当前路径变量 |
| `PATH <path>;%PATH%` | `$env.Path = ($env.Path \| append <path>)` | 编辑路径变量（追加） |
| `PATH %PATH%;<path>` | `$env.Path = ($env.Path \| prepend <path>)` | 编辑路径变量（前置） |
| `PAUSE` | `input "Press any key to continue . . ."` | 暂停脚本执行 |
| `PROMPT <template>` | `$env.PROMPT_COMMAND = { <command> }` | 更改终端提示符 |
| `PUSHD <path>` / `POPD` | `enter <path>` / `dexit` | 临时更改工作目录 |
| `REM` | `#` | 注释 |
| `REN` 或 `RENAME` | `mv` | 重命名文件 |
| `RD` 或 `RMDIR` | `rm` | 删除目录 |
| `SET <var>=<string>` | `$env.<var> = <string>` | 设置环境变量 |
| `SETLOCAL` | （默认行为） | 将环境更改本地化到脚本 |
| `START <path>` | 部分由 `start <path>` 覆盖 | 在系统默认应用程序中打开路径 |
| `TIME /T` | `date now \| format date "%H:%M:%S"` | 获取当前时间 |
| `TYPE` | `open --raw` | 显示文本文件的内容 |
| | `open` | 将文件作为结构化数据打开 |

无 Nu 对应物的 CMD.EXE 命令：`ASSOC`、`BREAK`、`COLOR`、`DATE`（设置）、`ECHO ON`、`FTYPE`、`GOTO`、`MKLINK`、`START`（启动独立窗口运行内部命令/批处理）、`TIME`（设置）、`TITLE`、`VER`、`VERIFY`、`VOL`。

### 转发的 CMD.EXE 内部命令

Nu 通过 `cmd.exe` 接受并运行**一些** CMD.EXE 内部命令：`ASSOC`、`CLS`、`ECHO`、`FTYPE`、`MKLINK`、`PAUSE`、`START`、`VER`、`VOL`。这些内部命令**优先于**外部命令：例如当前目录有 `ver.bat` 时，`^ver` 执行的是 CMD.EXE 内部 `VER` 而非本地 `ver.bat`；而 `./ver` 或 `ver.bat` 会执行本地 bat 文件。Nushell 有自己的 `start` 命令且优先级更高，需用外部命令语法 `^start` 才能调用 CMD.EXE 的内部 `START`。

## 从其他 Shell 或 DSL 到 Nu

Nu 命令与 SQL / .NET LINQ (C#) / PowerShell（不含外部模块）/ Bash 的映射（来源：nushell_map）。空单元格表示该语言没有直接对应物：

| Nushell | SQL | .NET LINQ (C#) | PowerShell | Bash |
| --- | --- | --- | --- | --- |
| `alias` | | | `alias` | `alias` |
| `append` | | `Append` | `-Append` | |
| `math avg` | `avg` | `Average` | `Measure-Object`, `measure` | |
| Math operators | Math operators | `Aggregate`, `Average`, `Count`, `Max`, `Min`, `Sum` | | `bc` |
| `cd` | | | `Set-Location`, `cd` | `cd` |
| `clear` (Ctrl/⌘+L) | | | `Clear-Host` (Ctrl/⌘+L) | `clear` (Ctrl/⌘+L) |
| `config` + `$nu.default-config-dir` | | | `$Profile` | `~/.bashrc`, `~/.profile` |
| `cp` | | | `Copy-Item`, `cp`, `copy` | `cp` |
| `date` | `NOW()`, `getdate()` | `DateTime` class | `Get-Date` | `date` |
| `du`, `ls --du` | | | | `du` |
| `each`, `for` | Cursors | | `ForEach-Object`, `foreach`, `for` | `for` |
| `exit` (Ctrl/⌘+D) | | | `exit` (Ctrl/⌘+D) | `exit` (Ctrl/⌘+D) |
| `http` | | `HttpClient`, `WebClient`, `HttpWebRequest/Response` | `Invoke-WebRequest` | `wget`, `curl` |
| `first` | `top`, `limit` | `First`, `FirstOrDefault` | `Select-Object -First` | `head` |
| `format`, `str` | | `String.Format` | `String.Format` | `printf` |
| `from` | `import flatfile`, `openjson`, `cast(variable as xml)` | | `Import/ConvertFrom-{Csv,Xml,Html,Json}` | |
| `get` | | `Select` | `(cmd).column` | |
| `group-by` | `group by` | `GroupBy`, `group` | `Group-Object`, `group` | |
| `help` | `sp_help` | | `Get-Help`, `help`, `man` | `man` |
| `history` | | | `Get-History`, `history` | `history` |
| `is-empty` | `is null` | `String.IsNullOrEmpty` | `String.IsNullOrEmpty` | |
| `kill` | | | `Stop-Process`, `kill` | `kill` |
| `last` | | `Last`, `LastOrDefault` | `Select-Object -Last` | `tail` |
| `str length` | `count` | `Count` | `Measure-Object`, `measure` | `wc` |
| `lines` | | | `File.ReadAllLines` | |
| `ls` | | | `Get-ChildItem`, `dir`, `ls` | `ls` |
| `mkdir` | | | `mkdir`, `md`, `New-Item -ItemType Directory` | `mkdir` |
| `mv` | | | `Move-Item`, `mv`, `move`, `mi` | `mv` |
| `open` | | | `Get-Content`, `gc`, `cat`, `type` | `cat` |
| `print` | `print`, `union all` | | `Write-Output`, `write` | `echo`, `print` |
| `transpose` | `pivot` | | | |
| `ps` | | | `Get-Process`, `ps`, `gps` | `ps` |
| `pwd` | | | `Get-Location`, `pwd` | `pwd` |
| `range`（命令） | `limit x offset y`, `rownumber` | `ElementAt` | `[x]` 索引运算符, `ElementAt` | |
| `range`（类型） | | `Range` | `1..10`, `'a'..'f'` | |
| `reduce` | | `Aggregate` | | |
| `rename` | | | `Rename-Item`, `ren`, `rni` | `mv` |
| `reverse` | | `Reverse` | `[Array]::Reverse($var)` | |
| `rm` | | | `Remove-Item`, `del`, `erase`, `rd`, `ri`, `rm`, `rmdir` | `rm` |
| `save` | | | `Write-Output`, `Out-File` | `> foo.txt` 重定向 |
| `select` | `select` | `Select` | `Select-Object`, `select` | |
| `shuffle` | | `Random` | `Sort-Object {Get-Random}` | |
| `skip` | `where row_number()` | `Skip` | `Select-Object -Skip` | |
| `skip until` | | `SkipWhile` | | |
| `skip while` | | `SkipWhile` | | |
| `sort-by` | `order by` | `OrderBy`, `OrderByDescending`, `ThenBy`, `ThenByDescending` | `Sort-Object`, `sort` | `sort` |
| `str` | String functions | `String` class | `String` class | |
| `str join` | `concat_ws` | `Join` | `Join-String` | |
| `str trim` | `rtrim`, `ltrim` | `Trim`, `TrimStart`, `TrimEnd` | `Trim` | |
| `math sum` | `sum` | `Sum` | `Measure-Object`, `measure` | |
| `uname`, `sys host` | | | `Get-ComputerInfo` | `uname` |
| `sys disks` | | | `Get-ComputerInfo` | `lsblk` |
| `sys mem` | | | `Get-ComputerInfo` | `free` |
| `table` | | | `Format-Table`, `ft`, `Format-List`, `fl` | |
| `take` | `top`, `limit` | `Take` | `Select-Object -First` | `head` |
| `take until` | | `TakeWhile` | | |
| `take while` | | `TakeWhile` | | |
| `timeit` | | | `Measure-Command` | `time` |
| `to` | | | `Export/ConvertTo-{Csv,Xml,Html,Json}` | |
| `touch` | | | `Set-Content` | `touch` |
| `uniq` | `distinct` | `Distinct` | `Get-Unique`, `gu` | `uniq` |
| `update` | | | `ForEach-Object` | |
| `upsert` | `As` | | `ForEach-Object` | |
| `version` | `select @@version` | | `$PSVersionTable` | |
| `$env.FOO = "bar"`, `with-env` | | | `$env:FOO = 'bar'` | `export FOO "bar"` |
| `where` | `where` | `Where` | `Where-Object`, `where`, `?` 运算符 | |
| `which` | | | `Get-Command` | `which` |

## 从命令式语言到 Nu

Nu 内置命令与 Python / Kotlin (Java) / C++ / Rust 的映射（来源：nushell_map_imperative；此表针对 Nu 0.94 或更高版本）：

| Nushell | Python | Kotlin (Java) | C++ | Rust |
| --- | --- | --- | --- | --- |
| `append` | `list.append`, `set.add` | `add` | `push_back`, `emplace_back` | `push`, `push_back` |
| `math avg` | `statistics.mean` | | | |
| Math operators | Math operators | Math operators | Math operators | Math operators |
| `cp` | `shutil.copy` | | | `fs::copy` |
| `date` | `datetime.date.today` | `java.time.LocalDate.now` | | |
| `drop` | `list[:-3]` | | | |
| `du`, `ls --du` | `shutil.disk_usage` | | | |
| `each`, `for` | `for` | `for` | `for` | `for` |
| `exit` | `exit()` | `System.exit`, `kotlin.system.exitProcess` | `exit` | `exit` |
| `http get` | `urllib.request.urlopen` | | | |
| `first` | `list[:x]` | `List[0]`, `peek` | `vector[0]`, `top` | `Vec[0]` |
| `format` | `format` | `format` | `format` | `format!` |
| `from` | `csv`, `json`, `sqlite3` | | | |
| `get`（按 key） | `dict["key"]` | `Map["key"]` | `map["key"]` | `HashMap["key"]`, `get`, `entry` |
| `group-by` | `itertools.groupby` | `groupBy` | | `group_by` |
| `headers` | `keys` | | | |
| `help` | `help()` | | | |
| `insert` | `dict["key"] = val` | | `map.insert({ 20, 130 })` | `map.insert("key", val)` |
| `is-empty` | `is None`, `is []` | `isEmpty` | `empty` | `is_empty` |
| `take` | `list[:x]` | | | `&Vec[..x]` |
| `take until` | `itertools.takewhile` | | | |
| `take while` | `itertools.takewhile` | | | |
| `kill` | `os.kill` | | | |
| `last` | `list[-x:]` | | | `&Vec[Vec.len()-1]` |
| `length` | `len` | `size`, `length` | `length` | `len` |
| `lines` | `split`, `splitlines` | `split` | `views::split` | `split`, `split_whitespace`, `rsplit`, `lines` |
| `ls` | `os.listdir` | | | `fs::read_dir` |
| `match` | `match` | `when` | | `match` |
| `merge` | `dict.append` | | | `map.extend` |
| `mkdir` | `os.mkdir` | | | `fs::create_dir` |
| `mv` | `shutil.move` | | | `fs::rename` |
| `get`（按索引） | `list[x]` | `List[x]` | `vector[x]` | `Vec[x]` |
| `open` | `open` | | | |
| `transpose` | `zip(*matrix)` | | | |
| `http post` | `urllib.request.urlopen` | | | |
| `prepend` | `deque.appendleft` | | | |
| `print` | `print` | `println` | `printf` | `println!` |
| `ps` | `os.listdir('/proc')` | | | |
| `pwd` | `os.getcwd` | | | `env::current_dir` |
| `range`（类型） | `range` | `..`, `until`, `downTo`, `step` | `iota` | `..` |
| `reduce` | `functools.reduce` | `reduce` | `reduce` | `fold`, `rfold`, `scan` |
| `reject` | `del` | | | |
| `rename` | `dict["key2"] = dict.pop("key")` | | | `map.insert("key2", map.remove("key").unwrap())` |
| `reverse` | `reversed`, `list.reverse` | `reverse`, `reversed`, `asReversed` | `reverse` | `rev` |
| `rm` | `os.remove` | | | |
| `save` | `io.TextIOWrapper.write` | | | |
| `select` | `{k:dict[k] for k in keys}` | | | |
| `shuffle` | `random.shuffle` | | | |
| `str length`（`str stats`） | `len` | | | `len` |
| `skip` | `list[x:]` | | | `&Vec[x..]`, `skip` |
| `skip until` | `itertools.dropwhile` | | | |
| `skip while` | `itertools.dropwhile` | | | `skip_while` |
| `sort-by` | `sorted`, `list.sort` | `sortedBy`, `sortedWith`, `Arrays.sort`, `Collections.sort` | `sort` | `sort` |
| `split row` | `str.split{,lines}`, `re.split` | `split` | `views::split` | `split` |
| `str` | `str` functions | `String` functions | `String` functions | `&str`, `String` functions |
| `str join` | `str.join` | `joinToString` | | `join` |
| `str trim` | `strip`, `rstrip`, `lstrip` | `trim`, `trimStart`, `trimEnd` | `Regex` | `trim`, `trim*{start,end}`, `strip*{suffix,prefix}` |
| `math sum` | `sum` | `sum` | `reduce` | `sum` |
| `to` | `import csv, json, sqlite3` | | | |
| `touch` | `open(path, 'a').close()` | | | |
| `uniq` | `set` | `Set` | `set` | `HashSet` |
| `upsert` | `dict["key"] = val` | | | |
| `version` | `sys.version`, `sys.version_info` | | | |
| `with-env`（`$env.FOO = "bar"`） | `os.environ` | | | |
| `where` | `filter` | `filter` | `filter` | `filter` |
| `which` | `shutil.which` | | | |
| `wrap` | `{ "key" : val }` | | | |

## 从函数式语言到 Nu

Nu 命令与 Clojure / Tablecloth (OCaml / Elm) / Haskell 的映射（来源：nushell_map_functional；此表针对 Nu 0.43 或更高版本）：

| Nushell | Clojure | Tablecloth (OCaml / Elm) | Haskell |
| --- | --- | --- | --- |
| `append` | `conj`, `into`, `concat` | `append`, `(++)`, `concat`, `concatMap` | `(++)` |
| `into binary` | `Integer/toHexString` | | `showHex` |
| `count` | `count` | `length`, `size` | `length`, `size` |
| `date` | `java.time.LocalDate/now` | | |
| `each` | `map`, `mapv`, `iterate` | `map`, `forEach` | `map`, `mapM` |
| `exit` | `System/exit` | | |
| `first` | `first` | `head` | `head` |
| `format` | `format` | | `Text.Printf.printf` |
| `group-by` | `group-by` | | `group`, `groupBy` |
| `help` | `doc` | | |
| `is-empty` | `empty?` | `isEmpty` | |
| `last` | `last`, `peek`, `take-last` | `last` | `last` |
| `lines` | | | `lines`, `words`, `split-with` |
| `match` | | `match` (OCaml), `case` (Elm) | `case` |
| `nth` | `nth` | `Array.get` | `lookup` |
| `open` | `with-open` | | |
| `transpose` | `(apply mapv vector matrix)` | | `transpose` |
| `prepend` | `cons` | `cons`, `::` | `::` |
| `print` | `println` | | `putStrLn`, `print` |
| `range`, `1..10` | `range` | `range` | `1..10`, `'a'..'f'` |
| `reduce` | `reduce`, `reduce-kv` | `foldr` | `foldr` |
| `reverse` | `reverse`, `rseq` | `reverse`, `reverseInPlace` | `reverse` |
| `select` | `select-keys` | | |
| `shuffle` | `shuffle` | | |
| `size` | `count` | | `size`, `length` |
| `skip` | `rest` | `tail` | `tail` |
| `skip until` | `drop-while` | | |
| `skip while` | `drop-while` | `dropWhile` | `dropWhile`, `dropWhileEnd` |
| `sort-by` | `sort`, `sort-by`, `sorted-set-by` | `sort`, `sortBy`, `sortWith` | `sort`, `sortBy` |
| `split row` | `split`, `split-{at,with,lines}` | `split`, `words`, `lines` | `split`, `words`, `lines` |
| `str` | `clojure.string` functions | `String` functions | |
| `str join` | `join` | `concat` | `intercalate` |
| `str trim` | `trim`, `triml`, `trimr` | `trim`, `trimLeft`, `trimRight` | `strip` |
| `sum` | `apply +` | `sum` | `sum` |
| `take` | `take`, `drop-last`, `pop` | `take`, `init` | `take`, `init` |
| `take until` | `take-while` | `takeWhile` | `takeWhile` |
| `take while` | `take-while` | `takeWhile` | `takeWhile` |
| `uniq` | `set` | `Set.empty` | `Data.Set` |
| `where` | `filter`, `filterv`, `select` | `filter`, `filterMap` | `filter` |

## Nushell 运算符对照

Nu 运算符与 SQL / Python / .NET LINQ (C#) / PowerShell / Bash 的映射（来源：nushell_operator_map；此表针对 Nu 0.14.1 或更高版本）：

| Nushell | SQL | Python | .NET LINQ (C#) | PowerShell | Bash |
| --- | --- | --- | --- | --- | --- |
| `==` | `=` | `==` | `==` | `-eq`, `-is` | `-eq` |
| `!=` | `!=`, `<>` | `!=` | `!=` | `-ne`, `-isnot` | `-ne` |
| `<` | `<` | `<` | `<` | `-lt` | `-lt` |
| `<=` | `<=` | `<=` | `<=` | `-le` | `-le` |
| `>` | `>` | `>` | `>` | `-gt` | `-gt` |
| `>=` | `>=` | `>=` | `>=` | `-ge` | `-ge` |
| `=~` | `like` | `re`, `in`, `startswith` | `Contains`, `StartsWith` | `-like`, `-contains` | `=~` |
| `!~` | `not like` | `not in` | `Except` | `-notlike`, `-notcontains` | `! "str1" =~ "str2"` |
| `+` | `+` | `+` | `+` | `+` | `+` |
| `-` | `-` | `-` | `-` | `-` | `-` |
| `*` | `*` | `*` | `*` | `*` | `*` |
| `/` | `/` | `/` | `/` | `/` | `/` |
| `**` | `pow` | `**` | `Power` | `Pow` | `**` |
| `in` | `in` | `re`, `in`, `startswith` | `Contains`, `StartsWith` | `-In` | `case in` |
| `not-in` | `not in` | `not in` | `Except` | `-NotIn` | |
| `and` | `and` | `and` | `&&` | `-And`, `&&` | `-a`, `&&` |
| `or` | `or` | `or` | `\|\|` | `-Or`, `\|\|` | `-o`, `\|\|` |

⚠ 与 bash 不同（从表可直接读出）：

- 相等/比较：bash 的 `-eq`/`-ne`/`-lt` 等字符串运算符在 Nu 中统一为 `==`/`!=`/`<`/`<=`/`>`/`>=`
- 正则/子串匹配：bash `=~` → Nu `=~`；取反是 `!~`（bash 无对应简写，需 `! "str1" =~ "str2"`）
- 成员判断：Nu 用 `in`/`not-in`（bash 需 `case ... in` 构造）
- 逻辑与/或：Nu 用关键字 `and`/`or`，**没有** `&&`/`||`（bash 的 `-a`/`-o` 或 `&&`/`||` 都映射到这里）
