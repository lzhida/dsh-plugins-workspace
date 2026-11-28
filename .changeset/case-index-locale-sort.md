---
'@zhidal/dsh-patent': patch
---

修复案件索引排序依赖运行环境默认 locale（localeCompare）导致的跨平台不一致：本机 zh-CN 按拼音序、CI 的 en 环境按码元序，中文案件名在两侧顺序不同并使 CI 单元测试失败。改为 UTF-16 码元比较（与 locale 无关的跨平台确定序），测试断言同步改为确定性全序列表。
