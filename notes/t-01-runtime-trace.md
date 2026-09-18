# T-01 运行时证据（第一批）

日期：2026-09-18。数据来源：TT 探针面板导出的脱敏摘要。未保存 prompt、响应正文、密钥或完整日志。

## 宿主能力

- TT API 可用：`layout`、`chat`、`chatSurface`、`characterCards`、`agent`、`llmConnections`、`mcp`、`skill`、`dev`、`extension`、`worldInfo`。
- 当前聊天引用可读，`stableId()` 可用。
- `windowInfo()` 可读：character chat，窗口模式 `off`，本次观察 `totalCount=27`。
- `history.tail()` 可用，返回 3 条尾部记录并标记存在更早历史。
- `setExtensionPrompt` 可用。
- `api.dev.llmApiLogs.index/getPreview/getRaw/subscribeIndex` 均可用。

## 正常生成

本次请求 token：仅保留面板中的 request token，不记录正文。

事件顺序：

1. `prepare-start`：`1789732816167`
2. `prepare-complete`：`1789732816167`
3. `probe-applied`：`1789732816170`
4. LLM log `id=4`，索引时间：`1789732816297`
5. `generation-ended`：`1789732835257`

最终请求摘要：32 条消息，已解析；探针标记存在。

| 语义位置 | 最终 role | 消息索引 | 结果 |
| --- | --- | ---: | --- |
| `before_history` | `system` | 0 | observed |
| `user @d0` | `user` | 30 | observed |
| `system @d0` | `system` | 31 | observed |

响应正文未保存；raw 摘要只保留长度和哈希。

## 已确认与未确认

- 已确认：假 prepare 在模型请求前完成；三类 placement 均进入最终请求；最新日志索引可刷新；当前 chat/head 快照可读取。
- 待验证：延迟期间取消、切聊天／head 变化后的旧响应丢弃、连续请求乱序、无 arm 时无残留、失败／超时清槽、获准 HTTPS 请求。

## 第二批：延迟 prepare 期间取消

时间线（2026-09-18，脱敏面板日志）：

1. `generation-started`：`1789734161425`
2. `prepare-start`：`1789734161503`，模式 `delay`，延迟 `30000 ms`
3. `probe-cancelled` 与 `prepare-cancelled`：`1789734187537`
4. LLM 请求 `id=8`：`1789734187631`，距取消约 `94 ms`
5. `generation-ended`：`1789734220500`

请求 `id=8` 的脱敏摘要中 `containsProbeMarker=false`，`beforeHistory/userD0/systemD0` 均为 `false`。本次只有一次 `generation-started` 与一次 `generation-ended`，因此后续生成是同一轮在探针取消后继续放行，不是第二次误触发。

当前探针 `Cancel` 的语义是取消 Mnemosyne 假 prepare 并清空探针槽，不调用 TT 原生 `abort(true)`；宿主随后继续生成，但不应收到探针注入。TT 原生 Stop 导致的宿主级中止仍待单独验证。

## 第三批：TT 原生 Stop

时间线（2026-09-18，脱敏面板日志）：

1. `generation-started`：`1789735387838`
2. `prepare-start`：`1789735387863`，请求类型 `continue`
3. `generation-ended`、两次 `generation-stopped`：`1789735390764`
4. `prepare-cancelled`：`1789735390764`，原因 `generation-ended`

截至面板观察时，LLM 日志仍为 `id=1..9`，没有新的 provider 请求；没有 `prepare-complete` 或 `probe-applied`。因此 TT 原生 Stop 能在假 prepare 完成前取消本轮探针并阻止正文模型请求。TT 本次将 `generation-ended` 与重复的 `generation-stopped` 事件集中发出；探针清槽可重复执行且无敏感数据影响。

## 宿主限制：生成期间切聊天

用户现场确认 TT 在模型生成期间不能切换聊天窗口或聊天文件。本批日志中 `generation-ended` 为 `1789735102263`，`chat-changed` 为 `1789735108886`，相隔约 `6.6 s`；因此这不是生成期间切聊天，不能作为旧响应丢弃证据。该场景按宿主限制记录为受限验证，不将生成后的普通切换误记为通过。

## 第四批：失败与超时

### `fail`

- `prepare-start`：`1789735496630`
- `prepare-failed`：`1789735496631`，错误 `fake_prepare_failed`
- LLM 请求 `id=10`：`1789735496718`
- raw 摘要：三类探针标记均为 `false`
- `generation-ended`：`1789735526918`

### `timeout`

- `prepare-start`：`1789735594862`
- `prepare-failed`：`1789735595876`，错误 `fake_prepare_timeout`
- LLM 请求 `id=11`：`1789735595966`
- raw 摘要：三类探针标记均为 `false`
- `generation-ended`：`1789735619328`

两种失败路径均在探针注入前完成，宿主按 fail-open 继续正文生成；最终请求无探针残留，且生成结束后清槽。

## 第五批：HTTPS 能力

测试地址：`https://example.com/`（用户批准）。

- 结果：`https-failed`
- origin：`https://example.com`
- pathname：`/`
- 错误：`Failed to fetch`
- 耗时：`1056 ms`

探针没有保存响应正文、凭证或查询参数。请求使用了自定义头 `X-Mnemosyne-TT-Probe: 1`；对未声明该头的跨源页面，浏览器/Tauri fetch 通常会在 CORS 预检阶段拒绝，并向扩展暴露通用 `Failed to fetch`。因此本次记录为可解释的宿主/CORS 限制：未证明该地址在 TT 中可完成跨源读取，也未证明目标站点不可达。未来 Memory API 需要提供允许 TT 来源和所需请求头的 CORS 配置，或改用宿主侧代理/后端请求。

## 第六批：Tailscale VPS HTTPS

测试地址：用户批准的 Tailscale 组网 VPS HTTPS endpoint（具体主机名不写入仓库）。用户确认浏览器在服务开启时可以打开 VPS 页面，并在测试结束后关闭本机 Tailscale 组网服务。

探针记录了三次失败：

| 结果 | 耗时 |
| --- | ---: |
| `https_timeout` | `5004 ms` |
| `Failed to fetch` | `3759 ms` |
| `Failed to fetch` | `252 ms` |

服务关闭时无法把这三次结果唯一归因于网络、TLS 或 CORS；浏览器页面可打开也不能替代带自定义请求头的扩展 `fetch` 证据。本次不标记 HTTPS 成功，保留为受测试时服务状态影响的未判定记录。

## 第七批：运行时请求门控

末尾 manual prepare 记录实际包含三次请求：

1. `request-10ca6a60-461f-42ba-ba99-c17fd856bf2f`：开始 `1789736850886`，以 `superseded` 失败；
2. `request-9b4c9ed9-ef4e-49c1-b94a-35d425b3ac5e`：开始 `1789736851140`，以 `superseded` 失败；
3. `request-9aff9743-ed55-4777-a7e9-fad0ec20e81c`：开始 `1789736852709`，完成 `1789736882710`。

这批没有触发正文模型请求，也没有注入探针；它证明 TT 运行时的请求 gate 会让新 prepare 取消旧 prepare。由于 TT 在一次生成期间不允许并发触发第二次生成，provider 层面的重叠响应乱序仍不能在该宿主 UI 中直接复现。
