# T-02 Chat 二次 review：R1～R4 复核与剩余导入一致性问题

日期：2026-09-19。
审核提交：`d99e1d50785a7a3dfb3173741c187f09016c7fe3`。
返修基线：`a679a20da7344cd5aa840c748606c1e221984ac3`。
前轮记录：`notes/t-02-chat-review.md`。本记录是原 T-02 的后续 review，不是新任务卡。

## 1. 结论

**R1～R4 的返修路径与原有回归已通过本轮独立测试，但 T-02 暂不升为 verified。** 当前仅保留下述 R5：逻辑导入对 corrections 与 selections 的交叉一致性校验遗漏，可能使已声明被纠正的旧摘要继续获准注入。

任务保持 `implemented_unverified`；T-03 保持 `proposal`，不修改、不执行。已接受的 Head/快照方案不变，不要求重做 TT 真机实验或扩建数据库。

## 2. 实际执行证据与范围

本轮确实在隔离运行目录执行了测试，与前轮撤回的无日志复跑声明分开记录。

- 环境：Linux / Node `v22.16.0`；不是 Codex 的 Windows Node v24 环境，也不是 TT 或手机。
- 固定提交的 7 个契约模块、fixture、原测试、返修测试与 2 个 prepare JSON 样例，共 12 个文件，其本地 Git blob SHA 全部与 GitHub 固定提交一致；没有修改被测实现。
- 实际执行 `node --test packages/contracts/tests/review.test.mjs`：10/10 通过。
- 实际执行 `node --test packages/contracts/tests/*.test.mjs`：42/42 通过，0 失败/跳过；包含原 32 项与新增 10 项。
- 实际对全部 10 个 `.mjs` 执行 `node --check`：全部通过。
- 额外执行第 4 节的导入/注入组合诊断，输出见第 5 节；它不属于上述 42 项测试，不伪称现有测试已失败。
- 探针 18/18 和完整仓库 diff 检查是 Codex 实施回报，本轮没有独立重跑。提交比较确认探针实现/测试及 T-03 预备卡没有被返修改动。
- 未测试生产持久化、崩溃恢复、TT/Android、真实剧情或大规模性能；这些不作为本轮新增返修要求。

本轮运行材料在会话交付文件 `t02-d99e1d5-review-evidence.txt` 中，包含环境、12 个 blob 哈希、42 项 TAP 输出、语法检查及附加诊断。不能依赖会话文件路径作为仓库工作前提；下文已保留重现步骤和实际结果，Codex 可直接据此补测。

## 3. R1～R4 已复核的修复

| 原项 | 本轮结果 |
| --- | --- |
| R1 累计版本与纠错 | 同 Record 家族通过 checkpoint + advance 正常推进两次；历史检查点纠正不倒退当前累计选择，后缀失效并能逐层修复；父子分支隔离。保留 current 的 selection 校验，没有简单移除约束。 |
| R2 选择执行图循环 | active/done 检查拒绝 A2 → B1 → 当前 A2 的选择循环；损坏图的 planner 不返回伪正常 rebuild 队列；合法菱形共享依赖通过。 |
| R3 跨故事重绑 | 旧 binding_id 跨 Story 更新在发布前拒绝，原状态保持可校验/导出；同 Story 改名和续接继续通过。 |
| R4 无原文记忆续聊 | 同 Branch 声明基线前缀不变时追加仍可用；旧前缀变更或过早 cutoff 待确认；不隐式扩张到其他故事/子线；必需不可用项不再聚合为 empty。 |

v1→v2 的常规逻辑往返测试也通过。固定检查点仅允许同 Record 的较早覆盖前缀，可作为本阶段最小实现边界；这不等于其他累计对象/产品能力已经完成。

## 4. R5：被纠正的版本仍是当前选择时，导入与注入均未拒绝（P1）

### 涉及位置

- `packages/contracts/transfer.mjs`：`validateState` 的分支视图校验，固定提交约 115～129 行。
- `packages/contracts/memory.mjs`：`checkExecutionGraph` 与 `memoryStatus` 的根节点/输入依赖区别，约 164～216 行。
- `packages/contracts/context.mjs`：`prepareAvailability` 与 `canApply` 的当前必需/选中记忆放行路径。

### 复现步骤

此处是**刻意构造的语义矛盾导入状态**，不是声称普通 `selectMemory` 已自然生成该状态；形状、引用、同家族约束及包 checksum 都有效。

1. 使用现有 `fixture(4)`，由前两条正文创建普通 Summary A1，正常归档并选择。
2. 创建同一 memory_id、相同 coverage、修正内容的 A2，赋新 memory_revision_id；正常归档但暂不选择。
3. 克隆状态，保持 `selections[A.memory_id] = A1`，同时设置 `corrections[A1] = A2`。含义发生冲突：一处说当前采用 A1，另一处明确说 A1 已被 A2 纠正。
4. 对该状态执行 `validateState`，随后 `importLogical(exportLogical(state))`。导出包有按当前内容生成的正确 checksum，并非校验和损坏。
5. 用导入后的状态创建新的 prepare；`required_memory_revision_ids` 明确包含 A1，并重新计算合法 prepare 指纹。
6. 构造 `status=ready` 的响应：ContextBlock 为正常可发送的 Summary，引用 A1，content 为 A1 旧内容；其余请求/响应身份一致。
7. 查询 `memoryStatus(A1)`、`prepareAvailability`，并执行 `canApply`。

### 为什么当前校验漏过

`validateState` 分别校验纠错端点归属/无环和选中版本归属，却没有校验“当前选中版本不能同时已被该分支 corrections 重定向”。执行图从选中根开始遍历，根本身的纠错关系没有被检查；没有记忆子依赖的 A1 可通过图校验。

`memoryStatus` 在遍历 input_refs 时使用 dependencyTarget，但对正在被检查的根 A1 本身没有对应的有效选择一致性约束。最终门禁又只确认 A1 仍在 selections 且其 status 为 valid，因而允许旧摘要发送。

checksum 只能证明包内容一致，不能代替这些领域关系校验。T-03 将依赖当前契约做导出/恢复，因此此项属于 T-02 现有逻辑包校验责任，不是要求现在实现生产恢复。

## 5. R5 实际诊断结果

以下是本轮 Node 诊断输出，而非推测：

```text
validateState: ACCEPTED correction while old revision remains selected
export/import: ACCEPTED contradictory selection/correction
selected is old: true
correction redirects old to replacement: true
memoryStatus(old): valid
prepareAvailability(required old): ready
canApply(block with old summary): true
```

正确行为不能同时包含“矛盾状态被认定合法”与“已被纠正的旧根仍获准正常召回”。

## 6. 有界返修要求

1. 在状态与逻辑包共同校验中补齐 corrections/selections 交叉不变量；矛盾包应在接受前返回类型化错误，不静默代用户选择 A2 或清除纠错关系。
2. 当前必需/选中记忆的最终放行不能让已声明被纠正的旧根继续使用。可通过共享校验与明确有效状态前置条件实现，避免各处产生不同解释；不要求每次调用都扫描整个未来生产库。
3. 保留合法的历史归档与固定检查点：正常 advance 不会把旧检查点登记为被纠正，不能因本项修复全局废弃旧版本、移除 selection 检查或破坏子线。
4. 增加确定性反例：正确 checksum 的矛盾 v2 包、直接状态交叉校验、修复后正常纠错包往返及最终旧摘要拒绝。至少覆盖一跳纠错；多跳纠错与当前选择的一致性也需明确。
5. 继续运行现有 42 项契约测试、新增回归、探针回归及语法/diff 检查。分别记录结果，勿修改原断言来接受错误路径。

复核通过的 R1～R4 无需重写。预计改动应限于相关校验/门禁、测试和契约说明；Codex 开工仍报告实际预计代码量。Chat 本轮只写 review 文档，没有直接修实现。

## 7. 下一步与状态

继续原 `tasks/T-02-identity-version-context.md`，本轮剩余问题以 R5 为准；实施回报写回该任务。保持 `implemented_unverified` 待下一次复核。T-03 预备卡继续 proposal，不执行，不创建新任务。

## 固定源码入口

- [memory.mjs](https://github.com/Roballz/liminal-axis-mnemosyne/blob/d99e1d50785a7a3dfb3173741c187f09016c7fe3/packages/contracts/memory.mjs)
- [context.mjs](https://github.com/Roballz/liminal-axis-mnemosyne/blob/d99e1d50785a7a3dfb3173741c187f09016c7fe3/packages/contracts/context.mjs)
- [transfer.mjs](https://github.com/Roballz/liminal-axis-mnemosyne/blob/d99e1d50785a7a3dfb3173741c187f09016c7fe3/packages/contracts/transfer.mjs)
- [R1～R4 测试](https://github.com/Roballz/liminal-axis-mnemosyne/blob/d99e1d50785a7a3dfb3173741c187f09016c7fe3/packages/contracts/tests/review.test.mjs)
