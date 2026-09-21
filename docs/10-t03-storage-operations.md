# T-03 隔离存储诊断、备份验证与回退

版本：v0.1，2026-09-21。状态：P5 `implemented_unverified`；仅覆盖T-03已建模对象、隔离合成库和当前分页格式。P4固定TT百万字符1x仍有资源算法阻塞，因此本文不是手机或生产运维手册。

## 1. 安全范围

- 只使用 `D:\Mnemosyne\.t03-local\tt-367b0c7`、固定exe哈希及 `mnemo-t03-*` 合成namespace。
- 不安装到现用TT，不读取真实RP、令牌、模型配置或生产备份，不触发sync/archive。
- 自动外部维护固定拒绝为 `HOST_MAINTENANCE_UNSUPPORTED`。合作式维护必须先由同一owner执行`suspend()`并等待排空。
- 诊断入口只读；恢复验证只写入明确证明为空的新目标。没有自动清理或GC。

## 2. 快速状态诊断

Node合成诊断与空目标恢复验证：

```powershell
node packages/storage/native/p5-command.mjs evals/t03/p4-p5/p5-diagnostic.json
```

成功输出包含：

- `format=mnemosyne-storage-diagnostic-v1`
- 当前namespace、分页格式、library、checkpoint、operation/pending
- 指定Branch的Story、Head、view及持久marker
- sidecar索引状态、明确错误数组和维护门禁
- 只读能力声明，以及合成备份的bytes/records与空目标恢复核对

命令使用小型纯虚构fixture和内存provider，适合检查代码/格式，不代表TT性能。失败时保留原错误code/message/cause，不把异常降级为空库。

## 3. 固定TT只读冷开

先确保没有其他TT进程，部署源码与隔离扩展的逐文件SHA-256一致。诊断现有P4库时，run必须对应已存在的 `mnemo-t03-paged-<run>-p4-source`：

```powershell
node packages/storage/native/collector.mjs p5-diagnostics 20260921p4b
& ./packages/storage/native/isolated-tt.ps1 -Action Start
```

collector收到`done`后才执行：

```powershell
& ./packages/storage/native/stop-isolated-complete.ps1 -Phase p5-diagnostics -Run 20260921p4b
```

退出脚本核对固定路径、exe哈希、run、phase、done时间和namespace。完成后的强制进程退出只属于清理，不是崩溃恢复证据。`20260921p4b`实测冷开为ready，12条确认operation、pending为空、71,271物理节点，marker保持`index=behind/rebuild=evaluate`，没有写入口或sync/archive。

## 4. 备份与空目标恢复验证

产品代码只使用分页 `handle.export()` 的固定目录流；标准v2小包不是分页辅助账本的完整替代。验证函数为：

```js
await verifyPagedBackupRestore(sourceHandle, async stream => {
  return restorePagedIntoEmpty(emptyTargetIO, stream);
}, { branchId });
```

它使用只读source facade，统计bytes/records，只允许调用方提供的空目标恢复入口，并核对operation数量、Branch状态和完整audit。目标验证后关闭；源库不得发生变化。恢复失败保留staging目标和源库，不重试到同一非空目标。

完整分页包仍受1GiB、100万页、单行1MiB等09协议限制；P5合成命令不是P4百万字符性能替代。

## 5. P4资源故障复现

Node计量provider：

```powershell
node --max-old-space-size=1536 packages/storage/native/p4-resource.mjs 1 evals/t03/p4-p5/resource-1x.json
```

固定TT必须使用新run，先启动collector再启动副本：

```powershell
node packages/storage/native/collector.mjs p4-resource <new-run>
& ./packages/storage/native/isolated-tt.ps1 -Action Start
```

固定停止条件：30分钟、100万物理节点、512MiB传输包、至少20GiB剩余磁盘。不要提高阈值、缩小1x、关闭full flush或在失败namespace上续跑。当前已知结果见 `notes/t-03-p4-resource-review.md`；在算法review前不重复高成本原生1x。

## 6. 只读回退

1. 停止加载隔离扩展/harness，保留源码版本、完整分页包和所有测试namespace。
2. 不删除root、checkpoint、旧快照、纠错、pending或目录中间页来“修复”库；不按前缀批量清理。
3. 需要查看状态时只使用 `readOnlyPagedHandle()` / `collectPagedDiagnostic()`；不要把原生低级IO暴露给产品调用方。
4. 旧P2/intent读者应拒绝分页身份；不能修改root格式伪装降级。读取分页库必须保留相应分页读者。
5. 若未来撤回新代码，先保留提交后的新库和分页包。没有经过迁移验证时，不让旧writer写入新格式库。

## 7. 当前明确状态

| 项 | 状态 |
| --- | --- |
| P3分页发布/恢复语义 | 受控高难review通过 |
| P4索引丢失重建/最终过滤 | Node回归通过 |
| P4固定TT百万字符1x | `P4 native elapsed-time safety stop`，未通过 |
| P5只读诊断与合成空库恢复命令 | implemented_unverified；Node与固定TT证据通过 |
| 自动外部维护 | `HOST_MAINTENANCE_UNSUPPORTED` |
| 5x/10x、手机、生产准入 | pending |
| T-03最终状态 | in_progress，等待P4算法回审与修复 |

完整测试命令：

```powershell
node --test --test-reporter=tap packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js
```

证据目录为 `evals/t03/p4-p5/`。不创建或执行T-04。
