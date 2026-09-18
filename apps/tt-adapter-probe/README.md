# Mnemosyne TT Adapter Probe

T-01 的隔离桌面 TT 探针。它只验证宿主接入能力，不实现 Memory Engine、数据库、检索或 Workbench。

## 运行边界

- 默认不参与生成、不写聊天、不写 IndexedDB、不调用真实记忆服务。
- 面板勾选 `arm` 后，下一次生成拦截器才会运行可控假 prepare。
- 诊断记录只保留时间、状态、角色顺序、长度和短哈希；不保存 prompt 或响应正文。
- `Clear`、取消、切聊天、消息变化和旧响应失效时都会清空探针槽。

## 本地加载

将本目录作为扩展放入 TauriTavern 的 local 扩展目录：

`data/default-user/extensions/mnemosyne-tt-adapter-probe`

重启或重新加载扩展后，右下角出现 `Mnemosyne TT Probe` 面板。只在隔离测试聊天中勾选 `arm`。

## 验证顺序

1. 点击 `Refresh host`，记录 `api.chat.current`、`windowInfo`、`history.tail` 和 `api.dev.llmApiLogs` 的可用性。
2. 先用 `Prepare` 验证 immediate、delay、timeout、fail 和 Cancel。
3. 勾选 `arm`，手动触发一次测试生成；检查日志是否先出现 `prepare-complete`，再出现 LLM 请求记录。
4. 点击 `LLM raw summary`，只记录请求的 role 顺序、消息数量、内容长度、探针标记和哈希。
5. 分别检查 `before_history`、`user @d0`、`system @d0` 是否在最终 payload 中出现；无法表示的位置记录为 unsupported/degraded。
6. 在 `HTTPS` 输入框填入用户批准的 HTTPS 测试地址，点击 `Test HTTPS`；只记录 origin、path、状态、响应类型、长度和耗时，不保存正文。

## T-02A 事件验证

探针同时监听 `CHAT_CHANGED`、`CHAT_LOADED`、`MESSAGE_EDITED`、`MESSAGE_UPDATED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED`、`GENERATION_STARTED`、`GENERATION_STOPPED` 和 `GENERATION_ENDED`。事件日志只保留：

- 脱敏后的 stableId、`chat_metadata.integrity`、chat ref 和当前 chat id；
- `windowInfo.chatRef` 的类型及标识符长度／短哈希，不保留角色显示名或文件名；
- 事件参数的类型／数字候选；正文只保留长度和哈希；
- 事件前、立即读取、下一 tick 后的消息数、邻近消息指纹、`history.tail`／`summary` 摘要；
- `swipe_id`、候选数量、active swipe 的长度和哈希。

在隔离测试聊天中用 `T02A_TEST_*` marker 做 Branch、深层 Edit、Delete、Swipe 和 Regenerate。点击 `Refresh host` 后可用 `Copy host` 复制当前身份／状态摘要；点击 `T-02A trace` 展开脱敏 JSON，或点击 `Copy trace` 复制事件记录。不要复制 `context.chat`、完整 ref 或 prompt。控制台仍可读取 `mnemosyneProbe.t02aTrace()`。

## 测试

在仓库根目录执行：

```powershell
node --test apps/tt-adapter-probe/tests/probe.test.js
```
