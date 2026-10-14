---
'@zhidal/dsh-llm-fallback': patch
---

默认白名单新增失败码 `UNSUPPORTED_REASONING_EFFORT`:deepseek/pi-ai 适配器在请求构建期发现模型不支持所请求的 reasoning effort 时抛出该码(消息形如 `provider "X" model "Y" does not support reasoning effort "Z"`),此前不在白名单导致不触发回退、对话以该错误中断。该失败对同一模型是确定性的(同 provider 重试必复现),现命中后按回退时机切下一候选;system-prompt 协议文本与 README 失败码表同步更新。
