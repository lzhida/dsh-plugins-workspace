# Nushell 文档提炼

来源：[Nushell Book（zh-CN）](https://www.nushell.sh/zh-CN/book/)，抓取日期 2026-09-22。

## 提炼原则

读者是**通过 dsh `nushell` 工具执行 `nu --no-config-file -c <command>` 的 LLM**，不是人类初学者：

- 保留：语法语义、类型/作用域规则、常见陷阱、可运行的代码示例
- 丢弃：安装说明、REPL 交互技巧、行编辑器/主题/提示符美化等与「非交互执行」无关的内容
- 显式标注：与 bash/POSIX shell 直觉不同的行为（模型最易踩坑处）

## 章节地图

| 文件 | 覆盖内容 | 来源章节 |
| --- | --- | --- |
| [00-thinking.md](00-thinking.md) | 设计哲学、快速导览、文件系统操作 | 入门指南 |
| [01-fundamentals.md](01-fundamentals.md) | 数据类型、加载外部数据、管道、字符串/列表/表格 | Nu 基础 |
| [02-language.md](02-language.md) | 自定义命令、别名、运算符、变量、脚本、模块、覆层、测试 | Nu 编程 |
| [03-shell.md](03-shell.md) | 配置、环境变量、stdout/stderr/退出码、外部命令、后台作业、目录栈、钩子 | Nu 作为 Shell |
| [04-migration.md](04-migration.md) | bash/CMD 迁移对照、语言对照、运算符对照、代码执行原理 | 迁移 + 设计说明 |
| [05-advanced.md](05-advanced.md) | 标准库、数据帧、元数据、自定义错误、并行、explore、插件 | 高级 |

## 与本仓库的关联

本目录是 `nushell-command-writing` skill 的参考资源，读者为 dsh `nushell` 工具的使用方（模型）。基于这些提炼已对 `packages/dsh-tool-nushell`（模型契约层）与 `packages/dsh-nushell-local`（executor 层）落地四项改进：`outputFormat` 结构化输出、系统提示增强、nu 包装层自检、`stdin` 透传。
