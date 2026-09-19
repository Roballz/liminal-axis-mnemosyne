# T-03 storage diagnostics

状态：P0～P2已通过G1；P3请求/维护前置增量implemented_unverified，自动外部维护隔离受阻，有界存储/完整恢复未实现。T-03仍in_progress。见 `../../notes/t-03-p3-handoff.md`。

当前R1/R2返修代码、150项Node回归和隔离TT `20260919g1` 小验证已完成；G1已由最终回执放行；这些为原P0～P2证据。关闭成功后旧owner永久失效，必须经openTestStore取得替代owner；关闭失败保留同一owner，可显式recover或重试close。恢复只把原生null视为缺记录，损坏payload/root报NEEDS_RESOLUTION。证据见 `../../evals/t03/g1-repair/`。

运行自动测试：

```powershell
node --test packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js
```

原型 API：以契约函数得到 before/after，再调用 `prepareTransaction`，保存生成的完整编译请求；`openTestStore(api.db, namespace)` 返回共享 owner，使用 `owner.handle().commit/read/export`。不要绕过 handle 直接并发调用内部方法。失败进入 recovery-required，待原生 promise settle 后调用 `owner.recover()` 并获取新 handle；重试使用原请求。

所有本次 namespace 都是 `mnemo-t03-*`，固定向量只承载 JSON，不做召回。restore 只接受空 namespace，恢复材料独立版本化。临时上限、外部维护/跨 wrapper 限制、生产 durable intent 缺口均在协议中明示。

## 原生复现

只在核对过的 `D:\Mnemosyne\.t03-local\tt-367b0c7` 便携副本复现。不要把 harness 安装到现用 TT。

1. `portable.flag`、exe SHA 和独立 WebView profile 要与任务卡一致；正常退出其他 TT，单实例插件不允许并行副本。
2. 将 native 的 `index.js/manifest.json` 放到隔离 data/extensions/third-party/mnemosyne-t03-storage；将 contracts/storage 复制到其 packages/ 下。
3. 启动 collector，再启动副本或刷新其前端。例如 `node packages/storage/native/collector.mjs p0 <new-run>`；run 只用小写字母/数字，使用新值避免碰到已有测试库。
4. 断点顺序：collector `before` → 收到 kill-ready → `isolated-tt.ps1 -Action Crash -Phase before -Run <run>` → collector `recover-before` → `isolated-tt.ps1 -Action Start`。`after/recover-after` 同理。Crash 脚本只接受匹配的本轮断点、固定哈希和唯一精确副本路径。
5. `roundtrip <new-run>` 完成小库备份/空库恢复/竞争/中断导入。`reopen-check <same-run>` 只核对已有 restored 库与重试账本。所有结果先落 `.t03-local/evidence`，人工检查仅含合成信息后才放 evals。
6. `g1-repair <new-run>` 只做本轮 owner 生命周期和损坏 root/payload 小验证；结果需核对 `OWNER_CLOSED`、`STALE_HANDLE`、`NEEDS_RESOLUTION` 及物理材料未减少后再归档。

collector 仅监听 127.0.0.1:19374，完成/错误/kill-ready 后自行停止；无需远程调试端口。未实现生产操作面板。首次引导只需进入主界面，不配模型或导入聊天。

原始两个失败 namespace 保留：物理 ID 0 被 TT 拒绝。最终 adapter 把逻辑槽 0 映射为物理 ID 1；不能在旧失败库上直接套新映射。

没有新依赖或复制第三方实现源码；不执行安装、自动 GC 或清理。

## P3 prerequisite diagnostics

新入口：`openIntentTestStore(api.db, 'mnemo-t03-p3-<run>-intent', { create: true })`，仅用于空的隔离库；重开省略create。`handle().prepare({operation_id,kind,payload})`先持久准备，再以`execute(operation_id)`发布；调用方丢失请求后用`pending()/lookup()`找回。失败显式recover后换handle，不能换随机operation盲重试。

`kind`为history（payload是标准command）、binding（完整binding）或memory（archives/action/branch_id/revision_id/old_revision_id/expected_view/mode全部显式字段）；编译仅复用contracts，不调用模型。示例与错误路径见 `tests/intent-prototype.test.mjs`。

`suspend()/resume(ticket)`是合作式维护诊断；不能接管TT自行开始的同步/归档。当前自动维护原语缺口已在固定版本源码和真实旧handle反例确认，见交接。`requireExternalMaintenanceFence()`固定拒绝此未支持路径。当前仍是P2规模小原型，未交付P3块树/完整备份。

原生复现：`node packages/storage/native/collector.mjs p3-intent <new-run>` 后启动独立副本。只使用新namespace；结果记录准备重开、记忆去重、维护身份拒绝以及原生namespace换代反例，**不等于真实sync/archive或进程强杀测试**。
