# backlog-A 设计提案：错误信封 kind 映射表 + 客户端重发现触发矩阵

> 看板卡：t-mw2eut5k-6k1elc（in_progress）。授权：用户 2026-11-05 裁决「文档缺口就不管了，
> 插件内部自行消化问题就好了，不需要提 issue，然后处理剩下的非提issue的问题吧」。
> 本文档是卡面约定的**实施前置提案**（清单第 2/3 项）：交用户圈定范围与确认决策点后，
> 才动 src/client.ts 等实现文件。**本文档本身不改任何实现代码。**

## 0. 范围

纳入：S-1（上游工具级失败被当成功透出）、S-2（客户端永不失效、401 不重发现）、
M-1（kind 词汇表缺 4 类且丢 HTTP status）、bridge.ts:112 注释不实订正（deny_unknown_fields）。

不纳入：{items} 裸数组透传（t-mw1ri0ep-8vw7ql，用户 2026-11-04 裁定维持 backlog）、
M-7 PID 校验与 L-11 upstream-deadline（归 backlog-B t-mw2evd2u-0dukch 评估）、
上游 issue（用户 2026-11-05 裁决不提）。

## 1. 现状盘点（事实，带行号）

| #        | 现状                                                                                                                                                       | 位置                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| S-1      | callTool 对 HTTP 200 响应：有 `result` 键→成功；无 `result` 键→走兼容路径 `normalizeJson` 原样返回                                                         | src/client.ts:122-127                                             |
| S-1 后果 | 上游工具级失败（HTTP 200 + `{"error": msg}`，上游 rest.rs to_rest_json 口径）被当成功透出，`{kind,message,hint}` 信封失效                                  | src/tools/standalone/bridge.ts:137,141（信封只在 catch 路径生效） |
| S-2      | `clientPromise` 首次成功后永久缓存；只有**建连失败**才复位（catch 里置 undefined）                                                                         | src/index.ts:100-109                                              |
| S-2 后果 | 实例重启换 token 后 401 永远 401；实例退出后网络错误也永远命中死连接。README.md:75「连接失败会重置缓存，下次调用自动重新探活」只对建连期为真               | src/index.ts:104-107                                              |
| M-1      | kind 词汇表 7 值封闭（no-instance/instance-incomplete/no-live-instance/http-error/timeout/tool-error/cli-error）；400/401/403/404/429 全归 `http-error`    | src/errors.ts:33-47、src/client.ts:106-112                        |
| M-1 后果 | `VictauriHttpError.status` 持有状态码（errors.ts:55-68）但 `toErrorValue` 只取 kind/message，信封不透出 status                                             | src/tools/standalone/bridge.ts:40-44                              |
| 注释不实 | bridge.ts:112「别名键总是移除(服务端拒未知字段)」——上游 0.8.8/0.10.2/0.10.3 三版 crate 全仓 `deny_unknown_fields` 命中均为 0，未知键被**静默忽略**而非报错 | src/tools/standalone/bridge.ts:112                                |

## 2. 提案一：错误 kind 映射表（M-1 + S-1）

### 2.1 kind 词汇表扩展：7 值 → 11 值

新增 4 值（与既有短横线命名风格一致），语义全部由 HTTP 状态码机械推导：

| 新 kind          | 触发           | 语义                                   |
| ---------------- | -------------- | -------------------------------------- |
| `invalid-params` | HTTP 400       | 上游参数校验失败（serde 反序列化拒绝） |
| `auth`           | HTTP 401 / 403 | token 不配对或授权不足                 |
| `not-found`      | HTTP 404       | 端点/工具不存在（多为版本差异）        |
| `rate-limited`   | HTTP 429       | 上游限流                               |

`http-error` **保留**，收窄为「其余 HTTP 非 2xx（5xx、405 等）+ 网络层 fetch 失败」；
其余 6 值不动。S-1 见 2.3，**复用既有 `tool-error`，不新增值**。

### 2.2 HTTP 状态码分流实现

在 `VictauriHttpError` 构造器内按 status 推导 kind（下游 `toErrorValue` 的
`isVictauriError(err) ? err.kind` 自动获得细分值，桥层零改动）：

```ts
constructor(status: number, bodyPreview: string, context: string) {
  const kind: VictauriErrorKind =
    status === 400 ? 'invalid-params'
    : status === 401 || status === 403 ? 'auth'
    : status === 404 ? 'not-found'
    : status === 429 ? 'rate-limited'
    : 'http-error';
  super(kind, `...`); // message 格式不变（HTTP <status>: ...）
}
```

`status` 字段照旧持有数值（供 2.4 透出与测试断言）。

### 2.3 S-1：工具级失败识别规则

在 `callTool` 的 200 分支（现 src/client.ts:113-127）加一步识别：

- 触发条件（全部满足）：`parsed` 是 object 且非数组，且 `'error' in parsed`，
  且 `!('result' in parsed)`。
- 动作：抛 `VictauriError('tool-error', "callTool(<tool>): upstream tool-level failure: <error 摘要>")`。
- `error` 值为 string 直接用；非 string 用 `JSON.stringify` 摘要并 `slice(0, 500)`。
- **kind 复用 `tool-error`**：词汇表注释（errors.ts:44-45「工具执行被 victauri 拒绝(工具级错误响应)」）
  本就是为此预留的语义位，现在才真正接上——不新增词汇值。
- 兼容路径（无 `result` 也无 `error`，如顶层数组/标量）**保持现状**原样返回。

误伤面评估：上游成功信封固定 `{"result": ...}`（rest.rs 单块→对象、多块→数组），
顶层 `{"error": ...}` 只在失败时出现；活体冒烟（smoke 10 项）+ 单测矩阵双护栏。

### 2.4 status 透出（信封可选键）

`toErrorValue` 对 `VictauriHttpError` 附加可选键：
`{ error: { kind, message, hint, status } }`；非 VictauriHttpError 不带 `status`
（新增可选键，向后兼容——既有消费者不受影响）。docs/TOOLS.md 错误信封表格行
与「三套 kind 词汇表」小节同步为 11 值 + status 可选键说明。

### 2.5 需用户确认的决策点

1. **kind 命名**：`invalid-params` / `auth` / `not-found` / `rate-limited` 四个新值是否认可？
2. **403 归 `auth`**（与 401 同值）：本桥语境下 403 属「token/授权」域，不单列 `forbidden`。
3. **S-1 复用 `tool-error`**（而非新增 `upstream-error` 之类）是否认可？
4. **信封新增可选键 `status`** 是否认可（不加则是纯 kind 细分）？

## 3. 提案二：客户端重发现触发矩阵（S-2）

### 3.1 触发矩阵

| 错误形态                                                         | 判别                            | kind                                             | 复位 clientPromise              | 理由                                                                                      |
| ---------------------------------------------------------------- | ------------------------------- | ------------------------------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------- |
| VictauriHttpError 401/403                                        | instanceof                      | `auth`                                           | **是**                          | token 失配=实例重启过/换 token；重扫必得新 token 文件                                     |
| VictauriHttpError 400/404/429/5xx                                | instanceof                      | invalid-params/not-found/rate-limited/http-error | 否                              | 服务在线，重扫无益；复位反而放大故障（404 循环重扫）                                      |
| VictauriError('http-error')（fetch 网络失败，client.ts:184-187） | 非 instanceof VictauriHttpError | http-error                                       | **是**                          | 实例可能已退出/换端口，必须重扫描 discovery                                               |
| VictauriTimeoutError                                             | instanceof                      | timeout                                          | 否                              | eval 长任务超时常见（上游默认 30s）；复位徒增下次调用延迟；实例真死会走上一行网络失败路径 |
| no-instance / no-live-instance（建连期）                         | —                               | —                                                | 已复位（现状 index.ts:104-107） | 保持                                                                                      |

### 3.2 实现机制（两案，推荐 A）

- **方案 A（推荐）**：index.ts 包装层。新增小包装类
  `ReconnectingVictauriClient`（显式转发 `callTool/listTools/info/health` 四个公开方法），
  包装 `callTool`：catch 后按 3.1 矩阵 `shouldResetClient(err)` 判定，命中则
  `clientPromise = undefined` 再重抛。优点：复位逻辑集中一处、bridge 38 工具路径零改动、
  可直接单测；client 本体（readonly baseUrl/token）不动。
- **方案 B**：`BridgeDeps` 加可选 `onClientError` 回调，bridge execute 的 catch 里调用。
  缺点：改 BridgeDeps 签名、compound 路径同改、复位逻辑散在桥层。

### 3.3 防抖与安全性

- 无循环风险：每次工具调用至多一次「复位→下次调用重扫」；同一调用内不复位不重试。
- 不做时间窗防抖（重扫为本机毫秒级，收益不值复杂度）。
- token 刷新路径：discovery 重扫自然读到新 token 文件，无需额外逻辑。
- M-7 联动：重发现**不引入** PID 存活校验（backlog-B 评估范围）；死实例候选由
  探活失败自然跳过，行为不变。

### 3.4 文档同步

README.md:75 改为如实口径：「连接失败、`auth`(401/403)、网络层失败会重置缓存并在下次
调用重新发现；`invalid-params`/`not-found`/`rate-limited`/5xx/超时/工具级失败不复位」。

## 4. 改动文件清单（实施阶段，供用户预览）

| 文件                                     | 改动                                                               |
| ---------------------------------------- | ------------------------------------------------------------------ |
| src/errors.ts                            | 词汇表 7→11 值 + VictauriHttpError 按 status 推导 kind + 注释更新  |
| src/client.ts                            | callTool 加 S-1 识别（约 +15 行）                                  |
| src/index.ts                             | 新增包装类 + shouldResetClient + getClient 接线                    |
| src/tools/standalone/bridge.ts           | toErrorValue 透出可选 status + :112 注释订正（行为不变）           |
| README.md                                | :75 故障排查行改如实口径                                           |
| docs/TOOLS.md                            | 三套 kind 词汇表小节 11 值 + 信封 status 可选键 + S-1 行为变更说明 |
| src/client.test.ts / 新增 reconnect 测试 | 见 §5                                                              |
| src/tools/contract.test.ts               | 词汇表护栏 11 值同步（既有范式）                                   |

## 5. 测试方案

1. **S-1 矩阵**：假 fetch 200 `{"error":"eval timed out"}` → 抛 kind=`tool-error`、message 含摘要；
   200 `{"result":1}` 正常；200 多块 `{"result":[{type:'text',...}]}` 正常；
   200 顶层数组/标量走兼容路径原样返回；`error` 非 string 走 JSON 摘要截断。
2. **分流矩阵**：直接构造 VictauriHttpError(400/401/403/404/429/500) 断言 kind 与 status 保留。
3. **toErrorValue**：VictauriHttpError → `{kind:'auth', status:401, message, hint}`；
   普通 VictauriError → 无 status 键；非 Error → `unknown`。
4. **复位矩阵**：计数器 fake `makeClient`；触发 callTool 抛各形态错误 → 断言复位
   （下次 getClient 重建）或不复位（复用同一实例）；401→复位、404→不复位、
   网络失败→复位、timeout→不复位。
5. **桥集成**：createRestBridgeTool + fake getClient 抛 401 → execute 返回
   `{error:{kind:'auth',status:401,...}}`，且 getClient 计数 +1（复位生效）。
6. **护栏**：errors.ts 词汇表值集 ↔ docs/TOOLS.md 小节同步断言（既有同源范式扩展）。

## 6. 兼容性与行为变更说明

- kind 新增 4 值：本插件内无 `switch(kind)` 类消费者（信封只透传）；
  外部若硬编码 7 值枚举需跟进（护栏会同步更新）。
- **S-1 是行为变更**：200 `{"error"}` 从「当数据返回」变为「结构化错误」——这正是修复目的；
  文档与护栏同步标注。
- bridge.ts:112 注释订正只改注释文字，别名键移除行为保留（防模型混淆，与上游静默忽略不冲突）。

## 7. 纪律声明（实施阶段遵循）

只 dev 分支提交、Conventional Commits 中文、不 push、不自行移 done、
失败步骤 ≤3 次并记录、V1（typecheck+test+lint+format）全绿 + 独立 V2 审阅后才提交、
残余风险落盘 docs/audit/2026-11-05/risk-<cardId>.md。
