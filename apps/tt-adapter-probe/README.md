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

## 测试

在仓库根目录执行：

```powershell
node --test apps/tt-adapter-probe/tests/probe.test.js
```
