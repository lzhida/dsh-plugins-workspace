---
'@zhidal/dsh-anytype': minor
---

新增左侧栏 Anytype 状态面板（只读）：宿主 webServer 上的 `/dsh-anytype/panel/status` 与 `/dsh-anytype/panel/queue` 两个只读端点（连接状态 / wiki 待审队列 / 空间 / 最近笔记四节），客户端 main + sidebar.panellist 插槽注册面板与图标，30s 轮询 + 手动刷新，apiKey 只报是否配置、永不回显密钥值；v1 不含写操作与 SSE。
