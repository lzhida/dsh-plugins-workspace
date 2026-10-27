---
'@zhidal/dsh-llm-fallback': minor
---

识别网关 408 请求超时：`isFailureRetryable` 新增结构化 `status` 判定——`failure.status === 408` 直接视为可重试/可切换（只读结构化字段，绝不解析 message），兜住 deepseek 路由下网关透传 `invalid_request_error` type 导致 `code=INVALID_REQUEST`（白名单外）的 408 形态；`DEFAULT_RETRYABLE_CODES` 增补 `HTTP_408`（deepseek 路由 408 且响应体无已知 type 的兜底码）。

- 判定先于白名单：存量自定义白名单（未列 `HTTP_408`）零迁移即获得 408 切换行为；无 `status` 的失败（含 pi-ai 路由退化为纯 code 的 408）行为完全不变，默认零回归
- 数据面差异如实写入 README：`LlmFailure.status` 仅由 deepseek 路由填充，pi-ai 路由纯文本分类不透传 status——该路由的网关 408 仍为白名单外 `INVALID_REQUEST`，插件侧无解（宿主上游缺口），README 故障排查给出「重试 5/5 后失败」分叉解释与 `INVALID_REQUEST` 白名单逃生的风险说明
