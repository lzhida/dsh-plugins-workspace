# 高级主题

> 本章来源：
>
> - https://www.nushell.sh/zh-CN/book/standard_library.html
> - https://www.nushell.sh/zh-CN/book/dataframes.html
> - https://www.nushell.sh/zh-CN/book/metadata.html
> - https://www.nushell.sh/zh-CN/book/creating_errors.html
> - https://www.nushell.sh/zh-CN/book/parallelism.html
> - https://www.nushell.sh/zh-CN/book/explore.html
> - https://www.nushell.sh/zh-CN/book/plugins.html

面向非交互执行（`nu --no-config-file -c <command>`）的导读：本章的重点是 **std 标准库**（脚本断言、日志、基准测试）、**error make 结构化错误**、**par-each 并行** 与 **metadata 元数据**；dataframes 是大数据量处理的潜力方向（附能力边界）；explore 与 plugins 为交互式/扩展场景，仅作概览。

## 标准库 (std)

Nushell 内置一个用 Nu 本身编写的标准库。**默认在启动时加载进内存，但不会自动导入**——使用前必须 `use`。要列出全部可用命令（推荐的内省方式）：

```nu
use std
scope commands
| where name =~ '^std '
| select name description extra_description
| table -e
```

注：`use std` 会加载整个标准库，仅为一次性查看所有命令时使用；脚本中应只导入需要的子模块。

### 导入方式与子模块清单

标准库子模块通过 `use` 导入，语法分三类：

1. **`use std/<submodule>`（不带 `*`）**——导入命名空间，调用时带前缀：

```nu
use std/assert   # assert 及其子命令
use std/bench    # bench 基准测试
use std/dirs     # dirs 目录栈及子命令
use std/input    # input display
use std/help     # 替代版 help（带补全）
use std/iters    # iters 前缀迭代命令
use std/log      # log warning 等
use std/math     # $math.E 等数学常量
```

2. **`use std/<submodule> *`（带 `*`）**——把定义直接展开进当前作用域，调用时不带前缀：

```nu
use std/formats *
ls | to jsonl    # 额外的 to/from 格式转换之一
```

适用于：`std/dt`（date 值的额外命令）、`std/formats`（额外格式转换）、`std/math`（不带前缀的常量如 `$E`）、`std/xml`（XML 处理命令）。

3. **`use std <submodule>`（空格分隔）**——⚠ 避免：这种形式（同 `use std *`）会**先把整个标准库加载进作用域**再导入子模块，比斜杠形式的启动开销大得多。

标准库目前包含：断言（`assert` 系列，对脚本内断言校验有用）、替代 `help` 系统、额外 JSON 变体格式（如 `to jsonl`）、XML 访问、日志记录（`log`）、基准测试（`bench`）、目录栈（`dirs`）、`input`、`iters` 迭代、数学常量（`math`）等。完整、最新的命令清单以上面 `scope commands` 查询结果为准。

`std assert` 的子命令（`use std/assert` 后可用，已实测确认）：`assert`、`assert compare`、`assert equal`、`assert not equal`、`assert length`、`assert greater`、`assert greater or equal`、`assert less`、`assert less or equal`、`assert str contains`、`assert error`、`assert not`。断言失败时抛出结构化错误（可被 `try`/`catch` 捕获），适合脚本内做前后置校验。

### 禁用标准库与启动开销

`nu --no-std-lib` 可禁用标准库启动加载，最小化子 shell 开销（原文实测数据）：

```nu
nu --no-std-lib -n -c "$nu.startup-time"
# => 1ms 125µs 10ns

nu -n -c "$nu.startup-time"
# => 4ms 889µs 576ns
```

禁用后将**无法导入标准库及其任何子模块**。若执行器关心毫秒级启动开销，可用 `--no-std-lib`；否则默认加载（约多 3-4ms）即可保留 `use std/...` 能力。

另注：`std/log` 会导出环境变量，在自己的模块中引用它有特殊注意事项（见官方"创建模块"章节 export-env 条目）；标准库候选命令放在 `std-rfc` 模块（nushell 仓库 `crates/nu-std/std-rfc`），成熟后才进入 `std`。

## 元数据 (metadata)

流经管道的每个值都可以携带额外信息（元数据，tag）。元数据**不影响数据本身**，但 Nu 用它改善错误提示等体验。

典型用途：错误消息能标出值在源代码中的位置。例如 `open Cargo.toml | from toml` 报错时，不仅说 `from toml` 需要字符串输入，还指出该对象 originates from here（源自哪里）。

用 `metadata` 命令查看值的元数据：

```nu
metadata (open Cargo.toml)
# => ╭──────┬───────────────────╮
# => │ span │ {record 2 fields} │
# => ╰──────┴───────────────────╯

metadata (open Cargo.toml) | get span
# => ╭───────┬────────╮
# => │ start │ 212970 │
# => │ end   │ 212987 │
# => ╰───────┴────────╯
```

`span.start` / `span.end` 是该值**在源文本中的字节偏移区间**（对应错误提示中下划线的起止位置）。⚠ 与 bash 不同：bash 没有值级来源追踪；Nu 中每个值的 span 可被程序读取，这是 `error make` 精确标注错误位置的基础。目前元数据追踪的就是 span 这一项。

## 自定义错误 (error make)

`error make` 用一条结构化记录创建自定义错误。错误信息由两部分构成：

- **`msg`**：错误的标题文本
- **`label`**：错误标签记录，包含 `text`（标签文本）和 `span`（要标注下划线的范围）

基础用法：

```nu
error make {msg: "this is fishy", label: {text: "fish right here", span: $span} }
```

结合 `metadata` 从参数来源取 span，让错误精确指向调用方传入的值：

```nu
def my-command [x] {
    let span = (metadata $x).span;
    error make {
        msg: "this is fishy",
        label: {
            text: "fish right here",
            span: $span
        }
    }
}
```

调用后的输出：

```nu
my-command 100
# => Error:
# =>   × this is fishy
# =>    ╭─[entry #5:1:1]
# =>  1 │ my-command 100
# =>    ·            ─┬─
# =>    ·             ╰── fish right here
# =>    ╰────
```

⚠ 与 bash 不同：bash 脚本的自定义错误只是往 stderr 打任意文本；Nu 的 `error make` 产生**带结构（msg + label + span）的错误对象**，span 直接映射回源代码位置，且错误会使当前管道按错误语义中止（而不是靠 `exit 1` 约定）。

## 并行 (par-each)

Nu 支持并行处理流的各个元素。并行命令以 `par-` 前缀命名，且都存在对应的串行版本——先把代码按串行风格写好，再把 `each` 换成 `par-each` 即完成并行化。

`par-each` 是 `each` 的并行搭档：同样对管道中流入的每个元素运行一个代码块，但**并行执行**。原文实测：统计每个子目录的文件数，`each` 耗时 21ms，`par-each` 耗时 6ms。

```nu
ls | where type == dir | each { |elt|
    { name: $elt.name, len: (ls $elt.name | length) }
}
```

换成并行（仅改动命令名）：

```nu
ls | where type == dir | par-each { |row|
    { name: $row.name, len: (ls $row.name | length) }
}
```

### ⚠ 与 bash 不同：结果顺序不确定

`par-each` **每次运行返回元素的顺序可能不同**（取决于硬件线程数，随任务完成先后聚合）。若需要确定顺序，必须在之后补排序，例如按 `name` 字段 `sort-by name`，使 `each` 与 `par-each` 版本产出一致结果。bash 没有原生并行遍历结构，也就不存在此差异；这更接近 `xargs -P` 的乱序聚合，但作用于任意值流。

### par-each 中的作用域环境

环境变量是有作用域的，因此可以在 `par-each` 闭包内用 `cd` 切换目录并行工作，互不污染：

```nu
ls | where type == dir | par-each { |row|
    { name: $row.name, len: (cd $row.name; ls | length) }
}
```

## 数据帧 (dataframes / Polars)

> 概述章节，保留能力定位与核心用法；此功能需要 `polars` 插件（安装见本章插件小节），可用 `help polars` 验证是否正确安装。

### 能力定位

`Lists`/`Tables` 按行循环处理值，方便但**不是处理大型数据的最有效方式**——对大型数据集的 `group-by` 或 `join`，行式布局会占用大量内存与计算时间。`DataFrame` 以**列格式**存储数据，基于 Apache Arrow 规范，用 Polars 作为引擎执行极快的列式操作。

原文性能实测（5,429,252 行 CSV，按 `year` 分组对 `geo_count` 求和，M1 pro / 32GB，Nushell 0.97 + nu_plugin_polars 0.97）：

| 方式 | 耗时 |
| --- | --- |
| Nushell 原生管道（`group-by` + `update` + `math sum`） | 3sec 268ms |
| Python pandas（`groupby().sum()`） | 1sec 322ms |
| Nushell dataframes（polars 惰性聚合） | 135ms |

即 polars 插件比 pandas/python 快约 10 倍。基准测试用 `use std/bench` 的 `bench -n 10 --pretty {...}` 度量；测完可 `plugin stop polars` 清掉 dataframe 缓存。

### 打开文件与存储管理

```nu
let df_0 = polars open --eager Data7602DescendingYearOrder.csv
polars store-ls | select key type columns rows estimated_size
# => key(UUID) | type(DataFrame) | columns(5) | rows(5429252) | estimated_size(184.5 MB)

$df_0 | polars first     # 预览第一行
$df_0 | polars schema    # 推断的列类型：anzsic06/str, Area/str, year/i64, ...
```

- `polars open` 支持 **csv、tsv、parquet、json(l)、arrow、avro** 格式。
- 自 Nushell 0.97 起 `polars open` **默认按惰性 (lazy) dataframe 打开**；`--eager` 才立即加载为即时 dataframe。
- `polars store-ls` 列出内存中所有 dataframes（含 `LazyGroupBy` 等其他对象）；配 `polars store-get` / `polars store-rm` 从插件缓存取用/删除。
- 查看全部可用 dataframe 命令：`scope commands | where category =~ dataframe`。

### 基本聚合与列选择

```nu
$df_1 | polars sum | polars collect                          # 所有列求和（文本列留空）
$df_1 | polars sum | polars select int_1 int_2 float_1 float_2 | polars collect
let res = $df_1 | polars sum | polars select int_1 int_2 float_1 float_2   # 结果可存为变量
```

### 连接 (join)

```nu
$df_1 | polars join $df_2 int_1 int_1           # 左表 int_1 列 join 右表 int_1 列
$df_1 | polars join $df_2 [int_1 first] [int_1 first]   # 多列 join：方括号 [] 包裹，类型需相同
```

默认**内连接**（只保留两表都有相同值的记录）；可选左连接保留左表缺失行。结果可存变量供后续操作。

### GroupBy 与聚合

`polars group-by` 创建可存储、可复用的 `GroupBy` 对象（创建分组对是最昂贵的运算，复用可避免重复计算）：

```nu
let group = ($df_1 | polars group-by first)
$group | polars agg (polars col int_1 | polars sum)
$group
| polars agg [
    (polars col int_1 | polars n-unique)
    (polars col int_2 | polars min)
    (polars col float_1 | polars sum)
    (polars col float_2 | polars count)
  ] | polars sort-by first
```

`polars col <列名>` 构造列表达式；同一/不同列上可定义多个聚合。

### 创建 dataframe 与加列

```nu
let df_3 = [[a b]; [1 2] [3 4] [5 6]] | polars into-df      # 从 Nu 表构造
let df_4 = $df_3 | polars with-column $df_3.a --name a2 | polars with-column $df_3.a --name a3
```

**内存优化**：每列是一个 Arrow 数组；只要可能，列会在多个 dataframes 之间共享（`$df_3` 与 `$df_4` 共享同两列）。⚠ 因此**不能改变 dataframe 中某一列的值**——只能基于已有列创建新列（与 pandas 可就地赋值不同）。另外，并非所有 Nu 基本类型都可转换为 dataframe（该功能仍在成熟中）。

### Series（系列）

`Series` 是 DataFrame 的基本组成（同类型的一列）。可独立创建与运算：

```nu
let df_5 = [9 8 4] | polars into-df    # 从整数列表创建系列
let df_6 = $df_5 * 3 + 10              # 系列基本运算 → 新系列
let df_7 = $df_6 | polars rename "0" memorable
$df_5 - $df_7                          # 同类型系列间运算
let df_8 = $df_3 | polars with-column $df_5 --name new_col   # 把系列加进 dataframe
$df_8.a * $df_8.b                      # 直接取用 dataframe 中的列运算
```

### 布尔掩码 (mask)

```nu
let mask_0 = $df_5 == 8                       # 等于运算产生布尔掩码系列
$df_9 | polars filter-with $mask_0            # 掩码过滤 dataframe
let mask_1 = ([true true false] | polars into-df)   # 掩码也可从 Nu 列表创建
$mask_0 and $mask_1                           # AND 组合
$mask_0 or $mask_1                            # OR 组合
let mask_2 = ($df_1 | polars col first | polars is-in [b c])   # is-in 生成掩码
$df_1 | polars get first | polars set new --mask ($df_1.first =~ a)   # 掩码为真处替换值
```

### 系列作为索引

```nu
let indices_0 = ([1 4 6] | polars into-df)
$df_1 | polars take $indices_0                       # 按索引提取行
let indices_1 = ($df_1 | polars get first | polars arg-unique)
$df_1 | polars take $indices_1                       # arg-unique：首个唯一元素所在行
let indices_2 = ($df_1 | polars get word | polars arg-sort)
$df_1 | polars take $indices_2                       # arg-sort：排序索引（同 sort 命令效果）
$df_1 | polars get int_1 | polars set-with-idx 123 --indices ([0 2] | polars into-df)
```

### 唯一值

```nu
$df_1 | polars get first | polars value-counts   # 各唯一值出现次数（返回新 DataFrame）
$df_1 | polars get first | polars unique         # 仅唯一值
$df_1 | polars filter-with ($in.word | polars is-unique)       # 保留 word 唯一的行
$df_1 | polars filter-with ($in.word | polars is-duplicated)   # 保留 word 重复的行
```

### 惰性 Dataframe (lazyframe)

惰性 dataframe 通过**逻辑计划**查询数据：在你提取数据之前计划**永远不会被求值**，可把聚合、连接、选择串在一起，满意后再收集。

```nu
let lf_0 = [[a b]; [1 a] [2 b] [3 c] [4 d]] | polars into-lazy
$lf_0        # 显示 plan / optimized_plan 字段，尚未求值
$lf_0 | polars collect    # collect 执行计划，生成 Nushell 表
```

链式惰性操作（`expression` 定义惰性操作；组合起来构成查询指令集）：

```nu
$lf_0
| polars reverse
| polars with-column [
     ((polars col a) * 2 | polars as double_a)
     ((polars col a) / 2 | polars as half_a)
]
| polars collect
```

惰性聚合 + 惰性 join（未 collect 的 lazyframe 可直接参与 join）：

```nu
let lf_1 = [[name value]; [one 1] [two 2] [one 1] [two 3]] | polars into-lazy
$lf_1
| polars group-by name
| polars agg [
     (polars col value | polars sum | polars as sum)
     (polars col value | polars mean | polars as mean)
]
| polars collect

let group = $lf_1 | polars group-by name | polars agg [...]
$lf_1 | polars join $group name name | polars collect
```

内省命令：惰性操作列表 `scope commands | where category =~ lazyframe`；表达式命令列表 `scope commands | where category =~ expression`。`polars select` 时部分场景可推断 `polars col`，直接传字符串 `polars select a` 与 `polars select (polars col a)` 等价。

所有 dataframe 操作都兼容惰性/非惰性输入（后台自动转换），但**要利用惰性优化建议只对惰性 dataframe 用惰性操作**。

### 命令清单与能力边界

`polars` 命令分 `dataframe`、`lazyframe`、`expression`、`dataframe or lazyframe` 类别，原文给出约 90 个命令对照表（如 `polars agg/append/arg-max/cast/col/collect/columns/concat-str/contains/count-null/cumulative/drop/drop-duplicates/drop-nulls/dummies/explode/fill-nan/fill-null/filter/filter-with/first/flatten/get/get-year...get-nanosecond/group-by/implode/into-df/into-lazy/into-nu/is-duplicated/is-in/is-null/is-not-null/is-unique/join/last/lit/lowercase/max/mean/median/melt/min/n-unique/not/open/otherwise/quantile/query/rename/replace/replace-all/reverse/rolling/sample/save/schema/select/set/set-with-idx/shape/shift/slice/sort-by/std/store-get/store-ls/store-rm/str-lengths/str-slice/strftime/sum/summary/take/unique/uppercase/value-counts/var/when/with-column`），其中 `polars query` 支持**用 SQL 查询 dataframe**（from 子句中 dataframe 固定命名为 `'df'`）。注意：**原文声明此列表可能已过时**，最新清单以 `scope commands` 按类别查询为准。

能力边界（选型判断用）：

- 功能仍属**实验性**，命令与工具随版本演化；依赖 polars 插件的注册与版本兼容。
- 并非所有 Nu 基本类型都能 `into-df`。
- 列不可变（Arrow 共享存储），只能新建列，不能就地修改。
- 小数据量（几十/几百行）用原生 `Lists`/`Tables` 更简单；dataframe 的收益在**大数据量的列式聚合/join**场景。
- `polars save` 保存到磁盘；惰性 dataframe 且格式支持时（parquet、ipc/arrow、csv、ndjson）使用 sink 操作。

## explore（概览）

`explore` 是类似 `less` 的表格分页器，用于**交互式**浏览结构化数据：

```nu
ls | explore -i        # -i 显示行索引
$nu | explore --peek   # --peek：退出时输出光标所在单元格的值
```

签名：`explore --head --index --reverse --peek`（另有 `--tail`）。方向键/Vim 键/Emacs 键移动，`<i>` 或 `<Enter>` 进入光标模式查看底层值，`<:>` 触发内置命令（`:table`、`:try`、`:help` 等），样式可在 `default-config.nu` 中配置。

⚠ 对本仓库读者（`nu -c` 非交互执行）：explore 是全屏交互 TUI，**在非交互管道/脚本中不可用也无意义**；需要"看一眼数据结构"时，用 `table`、`first`、`schema` 等命令替代。

## 插件 (plugins, 概览)

Nu 通过插件扩展命令。插件是独立可执行文件，运行方式与内置命令类似，好处是**可与 Nu 本身分开添加和更新**。插件通过 `nu-plugin` 协议与 Nu 通信（进程以 stdin/stdout 交换 JSON 或 MessagePack 序列化消息，协议已版本化）。插件**必须先注册才能使用**。

### 快速入门（以 Polars 插件为例）

1. 安装插件二进制。多数包管理器自动安装核心插件；Cargo 是显著例外，需 `cargo install nu_plugin_polars`。
2. 可选：设置插件搜索目录 `const NU_PLUGIN_DIRS = [($nu.current-exe | path dirname)]`（`$NU_PLUGIN_DIRS` 常量 / `$env.NU_PLUGIN_DIRS` 环境变量；`$nu.current-exe | path dirname` 指向 nu 可执行文件所在目录）。
3. 注册（只需一次）：`plugin add <插件文件路径含扩展名>`；若插件可执行文件位于 `$NU_PLUGIN_DIRS` 列出的目录中，可直接用文件名（如 `plugin add nu_plugin_cool`）。注册信息写入 `$nu.plugin-path` 指向的文件。示例：`plugin add ~/<path_to_plugin>/nu_plugin_cool`（Unix/macOS）；`plugin add E:\nu_plugins\nu_plugin_cool.exe`（Windows）。
4. 导入：`plugin use cool`。**使用插件名（而非文件名），不带 `nu_plugin_` 前缀**。

注意：注册过的插件在下次启动 nu 时**自动加载**，配置文件中无需写 `plugin use`；`plugin use` 用于在**当前会话**立即导入/重新加载。⚠ `plugin use` 是解析器关键字（解析期求值），脚本中位于它上方的代码不会在它生效前执行，应放在脚本开头。

**插件名取自文件名**：必须以 `nu_plugin_` 开头，Nu 以文件名识别插件；例如注册 `./cargo-bin/nu_plugin_gstat` 后其名称为 `gstat`。

### 管理与生命周期

```nu
plugin list          # 已安装插件表：name | version | status | pid | filename | shell | commands
plugin stop query    # 手动停止插件（名称取自 plugin list）
```

`status` 取值如 `loaded`（已注册未运行）/ `running`。原文示例流程：运行 `http get http://example.com | query web --document --query body` 后，`plugin list | where name == query | select name status` 显示 `running`；`plugin stop query` 后变为 `loaded`。

插件在使用时保持运行，**一段时间不活动后默认自动停止**，由插件垃圾回收器（plugin garbage-collector）管理，可配置：

```nu
$env.config.plugin_gc = {
    default: {
        enabled: true      # 设 false 不自动停止插件
        stop_after: 10sec  # 默认不活动 10 秒后停止
    }
    plugins: {
        gstat:   { stop_after: 1min }
        inc:     { stop_after: 0sec }    # 总是停止
        example: { enabled: false }      # 永不自动停止
    }
}
```

（键为 `plugin list` 中的插件名。）注意：本仓库执行器以 `--no-config-file` 启动 nu，config 不加载，垃圾回收走上述**默认值**（10sec）。

### 更新与第三方插件

更新插件版本后需**再次运行 `plugin add`** 加载新签名（重写 `$nu.plugin-path`），再 `plugin use` 获取当前会话的新签名。

第三方插件可从 crates.io、GitHub、awesome-nushell 列表获得；安装前须**确保插件 Nu 版本与系统 Nu 版本匹配**：用 `version` 命令确认本机版本，检查插件 `Cargo.toml` 所需版本，然后 `cargo install nu_plugin_<plugin_name> --locked` 安装（二进制通常落在 `~/.cargo/bin`）。

### 核心插件清单

Nushell 附带一组官方维护的核心插件（应已与 nu 可执行文件同目录安装）：

- **polars**：基于 Polars 库的 DataFrame 极快列式操作（见本章数据帧小节）
- **formats**：额外数据格式：EML、ICS、INI、plist、VCF
- **gstat**：以 Nu 结构化格式显示 Git 仓库状态
- **query**：查询 SQL、XML、JSON、HTML（选择器/网页信息提取）
- **inc**：版本号递增（最初作为插件编写示例）
- **example**、**custom_values**、**stress_internals**：参考/示例实现

系统缺少某核心插件或版本不匹配时，用 `cargo install nu_plugin_<plugin_name> --locked`（crates.io）或 `cargo install --path . --locked`（Nushell 源码检出版）安装。

### 创建插件（简）

插件协议是语言无关的：只要实现 Nu 插件协议并支持 JSON 或 MessagePack 序列化，任何语言都可编写（官方主仓库提供 Rust 与 Python 示例）。调试最简单的方式是打印到 stderr（Nu 会将其重定向并显示给用户）；`nu-plugin-test-support` crate 支持在 Rust 中为插件编写测试。对 LLM 非交互执行的直接价值有限，需要时再深入官方 plugin protocol reference。
