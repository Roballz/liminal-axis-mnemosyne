# T-03 P0～P2 bounded storage prototype

状态：本增量 implemented_unverified，T-03 总任务 in_progress；停在 G1。协议与限制见 `../../docs/09-storage-provider-and-recovery.md`，证据见 `../../evals/t03/`。不是手机/生产 provider，不进入 P3。

当前R1/R2返修代码、150项Node回归和隔离TT `20260919g1` 小验证已完成；G1仍待Chat review。关闭成功后旧owner永久失效，必须经openTestStore取得替代owner；关闭失败保留同一owner，可显式recover或重试close。恢复只把原生null视为缺记录，损坏payload/root报NEEDS_RESOLUTION。证据见 `../../evals/t03/g1-repair/`。

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
