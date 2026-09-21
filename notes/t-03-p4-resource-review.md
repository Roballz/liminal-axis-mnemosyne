# T-03 P4资源阻塞与P5收尾回审

日期：2026-09-21。施工基线：`42c6624178eeb3e3826a4fee37c3fe1ad843e0f2`。状态：`in_progress`，P4 的索引/候选正确性已实现并通过 Node 回归，P5只读诊断与操作收尾已完成到`implemented_unverified`；固定TT的百万字符`1x`资源完成线未通过，因此不能进入整个T-03最终review。

## 1. 范围与停止条件

本轮依 `notes/t-03-p3-repair-review.md` 进入原 P4 → P5。开工估计实现 450～750 行、测试/harness 550～900 行；P4检查点加P5收尾累计实现约323行、测试/harness约596行，另有104行操作文档与JSON/TAP证据。没有新增依赖、付费模型、真实RP、生产手机、TT修改或T-04。

固定限制：Node `--max-old-space-size=1536`，RSS 1.4GiB、临时包 512MiB、物理节点 1,000,000、单场景 30 分钟、磁盘余量 20GiB。`1x` 未完成时不放宽阈值；5x/10x 只作容量探索。自动维护继续固定返回 `HOST_MAINTENANCE_UNSUPPORTED`。

## 2. 已完成的正确性与诊断增量

- 新增可丢弃重建的 `mnemosyne-recall-index-v1`：索引失败/丢失不改变确认正文；候选在返回前重新核对当前 checkpoint、Story、Branch、view、selection、memory fingerprint 与 `memoryStatus`。人工数值向量的内部排序分数不冒充 rerank，`rerank_score` 保持 `null`。
- 新增只读分页诊断和物理库存分类，报告格式/library/checkpoint/operation/pending、Head/view/marker、索引状态、业务页、当前可达页、不可达保留页、活动目录和陈旧目录/中间页。入口不暴露写方法。
- 新增固定 P4 合成工作负载和 Node/隔离 TT harness。相同逻辑场景为 32 轮增长、4 次深层编辑、1 次删除、固定 fork/子线追加及 1 条中文 marker 记忆；最终当前正文 976,500 字符，保留历史版本 1,069,500 字符。

完整回归：

```text
322/322 passed, 0 failed, 0 skipped
```

即原 319 项全部保留，加 3 项索引/诊断/库存测试。完整 TAP 为 `evals/t03/p4-p5/node-tests.tap`。

## 3. 资源证据与新阻塞

Node 计量内存 provider 的 `1x` 完成：工作负载 453.2 秒、冷重开 101.5 毫秒、导出 8.0 秒、空库完整恢复 262.9 秒；峰值 RSS 833,236,992 bytes，主事件循环最大延迟 320.6 毫秒，备份 20,915,028 bytes / 32,350 records。源库 333,608 个物理节点，其中活动 checkpoint 可达业务页 14,596、保留但当前不可达业务页 17,752、活动目录页 32,348、陈旧目录/中间页 268,911。恢复库为 77,692 节点，其中陈旧目录/中间页 12,995。该结果证明逻辑恢复可完成，也暴露持续发布的目录写放大；它不是 TT 或手机通过。

第一次原生运行 `20260921p4a` 受用户报告的上游网络/LLM 供应商中断污染，不作算法结论。随后部署逐文件哈希一致的进度版扩展，以新 namespace 执行 `20260921p4b`：固定 TT `367b0c7e9410`，exe SHA-256 `11a9bc110da5dc634ff8c0b7b8fe244110c360af46693e50de67968cb811f2c4`。

`p4b` 没有网络空档，宿主全程响应：

| 增长发布 | 累计耗时 | 物理节点 |
| --- | ---: | ---: |
| 4 / 32 | 401,846.6 ms | 15,769 |
| 8 / 32 | 1,078,023.6 ms | 40,651 |
| 12 / 32 | 超过 1,800,000 ms 后触发停止器 | 停止前断言，未补造数值 |

隔离 data root 从 87,906,353 增至 148,351,628 bytes，增加 60,445,275 bytes。停止后核对唯一固定路径/PID/哈希并请求普通关闭；5 秒未退出才强制结束，记录为资源停止清理，不是故障恢复实验。证据见 `evals/t03/p4-p5/native-20260921p4b*.json`。

这满足最新回执中的“发现新的资源算法缺口则带证据回审”条件。`1x` 未完成冷重开、范围读取、索引、导出和恢复，因此 S09 未通过；P4 不能完成。5x/10x 未执行：原生 1x 已超时，且 Node 1x 的 333,608 源节点按最宽松线性外推到 5x 也会超过 1,000,000 节点停止线。

## 4. 请求 review 的问题

需要 Chat 先审查写放大来源和允许的修复范围。现有证据指向每次普通增长发布产生大量陈旧目录/中间页及高 prepare 成本；不能在 P4 名义下静默提高 30 分钟/100 万节点阈值、缩小 1x、关闭 `syncMode=full`、自动 GC 或改 TT。

候选后续工作仍须留在 T-03：定位普通发布中的目录构建/重复持久写，给出保持 checkpoint、旧快照、完整恢复及崩溃语义的最小算法改动和新的代码量估计。是否允许原地目录复用、批量原生写或显式离线维护，应由 review 决定；本记录不批准任何方案。

P4受影响写路径保持冻结。所有新测试库和证据保留，不自动清理。

## 5. P5已完成的独立收尾

P4资源阻塞不影响P5只读功能。新增`mnemosyne-storage-diagnostic-v1`快照、结构化错误、空目标备份/恢复验证命令及操作/回退文档：

- `node packages/storage/native/p5-command.mjs evals/t03/p4-p5/p5-diagnostic.json` 使用小型虚构fixture，输出版本、namespace、checkpoint、Head/view、operation/pending、索引、门禁和物理库存；同时完成1,006,060 bytes / 1,622 records的空目标恢复核对，源库不变。
- 固定TT `p5-diagnostics 20260921p4b` 只读冷开此前资源停止后的源库：状态ready、12条确认operation、pending为空、71,271物理节点、marker保持`index=behind/rebuild=evaluate`，索引报告`not-configured`，无写能力、sync或archive。完成后的进程退出单列为清理，不作故障证据。
- 安装/启停、诊断、备份验证、P4故障复现和只读回退见`docs/10-t03-storage-operations.md`。旧reader不得写新分页库，失败目标不覆盖源库，自动维护门禁不变。

因此本次提交给Chat的是“P5完成 + P4资源算法阻塞”的联合回审。P5不再是未完成项；但P4的1x强制完成线仍未通过，S09和整个T-03继续`in_progress`，不创建或执行T-04。
