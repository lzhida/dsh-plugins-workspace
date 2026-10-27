---
'@zhidal/dsh-anytype': minor
---

写路径暴露 Idempotency-Key 与 dry_run（审查缺口 G3+G4）。client 层 `RequestOptions` 新增 `idempotencyKey` 字段并映射为 `Idempotency-Key` 请求头；全部写类工具（`create_space` / `update_space` / `create_object` / `update_object` / `delete_object` / `create_collection` / `create_type` / `update_type` / `delete_type` / `create_property` / `update_property` / `delete_property`，以及逃生舱 `anytype_request`）新增两个可选参数：`dry_run`（预演校验，不落库；创建类预演 200 vs 提交 201，更新/删除类靠响应体 `dry_run: true` 字段区分）与 `idempotency_key`（防重；服务端按「key + 请求体」绑定，同 key 同 body 重放已存响应、同 key 换 body 返 409 `idempotency_conflict`）。工具描述与 agent 指引 section 同步写明两条语义（重试须复用同一 key）。README 补「写路径安全」段与「不做自动重试/退避」决策留白。覆盖面按活体 spec + 上游 `openapi-v2.yaml` 双源核对：`dry_run` 覆盖 26/55 operation，`Idempotency-Key` 的 spec 声明面窄于服务端实际覆盖面（实测服务端对 objects/types/properties/collections 的 mutation 同样强制执行该头）。新增 env 门控的活体冒烟测试（`ANYTYPE_LIVE_KEY` + `ANYTYPE_LIVE_SPACE`，缺 key 自动跳过）。
