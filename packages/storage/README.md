# T-03 storage diagnostics

状态：P0～P2已通过G1；P3有界结构基元/v1完整辅助恢复增量implemented_unverified；普通领域编译仍用有P2上限的全库oracle，分页发布/checkpoint与规模化恢复未实现。自动外部维护门禁保留。T-03仍in_progress。见 `../../notes/t-03-p3-handoff.md`。

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

`suspend()/resume(ticket)`是合作式维护诊断；不能接管TT自行开始的同步/归档。当前自动维护原语缺口已在固定版本源码和真实旧handle反例确认，见交接。`requireExternalMaintenanceFence()`固定拒绝此未支持路径。业务入口仍是P2规模小原型；新结构基元和完整v1恢复接口见下节，不能据此宣称业务路径S05完成。

原生复现：`node packages/storage/native/collector.mjs p3-intent <new-run>` 后启动独立副本。只使用新namespace；结果记录准备重开、记忆去重、维护身份拒绝以及原生namespace换代反例，**不等于真实sync/archive或进程强杀测试**。

## P3 bounded primitives and complete v1 recovery

`Pages`提供精确持久目录/游标、计数序列树及结构审计；`PagedJSON`提供`write/read/at/set/splice`。独立Node测试验证局部路径和旧根共享，原生harness验证精确大整数NodeId与重开。4caa326时它们尚未接入普通领域编译/发布；本轮分页业务入口见末节，旧intent入口仍保留P2上限。

现有intent入口增加：

```js
const byteStream = await source.handle().export();
const target = await openIntentTestStore(api.db, 'mnemo-t03-p3-<new-run>-restored', { restore: byteStream });
const prepared = await target.handle().pending();
```

新目标必须为空；传输保存全部已建模逻辑对象与ledger/journal/markers/intents。恢复目标有独立身份格式和激活标记，拒绝旧读者与半成品。流式传输有字节/记录/深度上限，领域校验仍受P2小库上限约束，详见协议v0.5。不要用旧P2 bundle替代此包。

最终原生命令：`collector.mjs p3-recovery <run>`；`p3-before`→精确Crash→`recover-p3-before`；`p3-after`→精确Crash→`recover-p3-after`。恢复collector读取同run的kill-ready独立证据，验证原operation/生成ID/结果；缺证据不能当恢复成功。正常完成后的`stop-isolated-complete.ps1 -Phase <phase> -Run <run>`只记录退出清理，不计作故障实验。每次启动仍通过`isolated-tt.ps1 -Action Start`的固定哈希/独立路径/无其他TT实例检查。

所有原生实验仍要求无未经协调的同步/归档/其他调用方替换库。自动维护门禁不变，生产准入未放宽。

## P3 paged end-to-end path

`openPagedTestStore(api.db, 'mnemo-t03-paged-<run>-<case>', {create:true})` 是本轮受控分页入口。历史/记忆/绑定经 `prepare` → `execute`，`pending/lookup` 恢复原请求、生成ID与结果；普通重开读取持久checkpoint，不重放全库。旧intent入口保留为兼容测试路径。

```js
const store = await openPagedTestStore(api.db, 'mnemo-t03-paged-example-source', { create: true });
const h = store.handle();
await h.prepare({ operation_id, kind: 'history-delta', payload: {
  ...commandWithoutEntries,
  splice: { start, delete_count, entries: changedSourceRefs },
} });
const result = await h.execute(operation_id);
const entries = await h.range(result.snapshot_id, 0, 16);
const stream = await h.export();
const restored = await openPagedTestStore(api.db, 'mnemo-t03-paged-example-restored', { restore: stream });
```

示例变量须由调用方提供真实已校验的合成命令；范围读取不能超过实际消息数。完整`history`命令、`memory`和`binding`输入形状与intent入口一致。`read(table,id)`读取单个逻辑对象；`enumerate(table,after,limit,checkpoint)`逐页枚举，提供checkpoint时拒绝跨提交混读；`memoryStatus`核对当前分支和cutoff。`logical()`是有显式物化上限的v2互操作输出；完整辅助恢复必须用`export()`分页包。

新文件分工：`paged-history/memory/domain`局部编译与语义，`paged-coordinator`单写/检查点，`paged-directory/transport/recovery`有界目录、文本流和激活前审计。完整恢复先staging，逐页验证引用，再用持久ID重编译对照全部确认结果/候选；成功才active。无原文、旧版本、未选记忆、纠错和pending均不因恢复被丢弃。

验证入口：

- 全量：`node --test packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js`
- P3增长正确性：`node --max-old-space-size=1536 packages/storage/native/paged-growth.mjs`；虚构样本，输出到`evals/t03/p3-integration/`，临时分页包仅在`.t03-local/`。
- 原生：collector的`paged-roundtrip`、`paged-before`→Crash→`recover-paged-before`、`paged-after`→Crash→`recover-paged-after`；`paged-reopen-check`复核同run已完成往返的库。只通过既有精确隔离脚本启停。

协议见09第10节；测试边界见原task与高难项交接。新格式没有迁移真实档案；自动维护仍`HOST_MAINTENANCE_UNSUPPORTED`，不授权手机或生产使用。P4/P5未进入，T-03未完成。
