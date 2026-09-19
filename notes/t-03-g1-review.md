# T-03 G1 Chat review：P0～P2 首轮验收

日期：2026-09-20。
审核实现：`3e583e7a75a63a62a7436e5263dc2d6f38477e12`。
审核读取基线（任务引用修正后）：`8e3f6a6828177b93bdeaceafb3a8d062847ecb01`。
比较基线：`852260acd8d3e65d9d756af81cdf72e52c50046b`。

## 1. 结论与关卡

**G1 暂不通过，不放行 P3。T-03 保持 in_progress；P1/P2 原型保持 implemented_unverified。**

接受 P0 的有限宿主证据，认可“不可变材料 → 单 root 发布 → flush 后确认”的候选分层，以及独立 ledger/journal/markers、小包暂存恢复的方向。本次发现两项落在当前 P0～P2 范围内的正确性阻塞：

- **G1-R1：关闭后的旧 owner 可恢复，与新 owner 同时写同一 namespace，破坏单写与已确认提交保留。**
- **G1-R2：恢复读取将无效发布元数据误作空库，导致已提交历史与账本静默不可见。**

两项均在隔离 Node 环境用审核源码复现；不是声称在用户 TT 真机或真实档案上复现，也不是仅凭推测列出的缺陷。不推翻 T-02、Head 设计或全部发布协议，不要求改做 B2/A。B1 仍是值得继续核查的候选，尚未批准为生产 provider。

本记录是原 `tasks/T-03-storage-foundation.md` 的 G1 返修依据，不是新任务卡。

## 2. 本轮实际执行与证据层级

### Chat 独立执行

- Linux / Node `v22.16.0` / Git `2.47.3`，仅隔离合成数据。
- 通过 GitHub connector 读取固定提交。容器直接下载因 DNS 不可用失败，随后复制原文件文本，并逐一验证 Git blob SHA；未修改被测实现或原断言。
- 执行 `node --test --test-reporter=tap packages/storage/tests/storage.test.mjs`：**65/65 通过**，0 失败、0 跳过。
- 对以下 14 个实际被测实现/fixture/测试文件执行 `node --check`：**14/14 通过**。
- 另行执行 4 个组合诊断：旧 owner 在关闭成功/失败后的两种路径，以及缺 tip 的 root/现有节点 null payload 的两种路径。诊断不计入原 65 项测试，也不称为 TT 原生试验。
- 本轮没有独立运行完整 48 项契约测试、18 项旧探针、完整仓库 diff 检查或 TT/Android 联调。**131/131、21 文件语法及 diff 检查为 Codex 已提交的执行记录，不能混称为 Chat 独立 131 项通过。**

| 文件 | 已核对 Git blob SHA |
| --- | --- |
| packages/contracts/primitives.mjs | b59a3bacfa97289e9190c459db5b544bdcad94ca |
| packages/contracts/runtime.mjs | 80866e66a8b0b52611da28a19303ec3c32707689 |
| packages/contracts/schema.mjs | 864f21302c45cd2324c1cfbccf09829e5f6a4075 |
| packages/contracts/history.mjs | 39370d7f621f708c1fdc81de93e4c79106a5fdca |
| packages/contracts/index.mjs | b86662882940d45572e09a991424014ce4b4c2f9 |
| packages/contracts/memory.mjs | ed37308f418031ccc559b8b318e79c8d1c2ad553 |
| packages/contracts/context.mjs | 30a7410263fa8070dc90233e142b146112be102f |
| packages/contracts/transfer.mjs | 9c5f59dcc9b33de50d07ea4540425a892dcfa8fb |
| packages/contracts/tests/fixture.mjs | 4be1e82e92434c73793c4c7553556e653ac4da51 |
| packages/storage/protocol.mjs | aefb3687816510ba043e8d956663de95bc6a3b00 |
| packages/storage/tt-adapter.mjs | bb7090a90254ce775d7b529e9b17ad2dffc25a2c |
| packages/storage/tests/fake-io.mjs | 417eaca141ffbc66423571a65bcdea83c700cec2 |
| packages/storage/tests/scenario.mjs | 928e0f5d63ef9bf0762e31680b87980a744eafc6 |
| packages/storage/tests/storage.test.mjs | 93eaf13a27084639f1bda35919926b0765853ec3 |

完整原 TAP、哈希/语法结果、额外诊断与诊断源码保存在本次会话交付文件 `t03-8e3f6a6-g1-review-evidence.txt`。下文保留重现方法及实际输出，Codex 不依赖会话文件路径也能补测。

### 已审阅、可保留的原生证据

`evals/t03/native/20260919a-p0.json` 与 harness 相符：专用 dim=2/full namespace、不调用 embedding、中文复杂 JSON 精确回读与正常重开、UUID/SHA 对照。

`20260919c-before-process.json` / `after-process.json` 与相应恢复记录对应：独立副本、精确 PID、publish/before 与 publish-flush/after 两个断点。发布前恢复旧 view `…014`，重试后 `…023`；发布后恢复即为 `…023`；两者重试账本均为 3。`20260919d-roundtrip.json` 记录两故事/三分支、小包恢复、R5 拒绝、共享 owner、取消等待、关闭后旧 handle 拒绝与固定导出样本。

这些是**本轮审阅的 Codex/用户原生记录**，不声称 Chat 重新强杀 TT。它们证明各自已测试路径，不涵盖下述“旧 owner 本身恢复”的组合，也不证明任意损坏元数据都已拒绝。无需因本次发现而否定全部原生证据。

## 3. G1-R1：关闭/恢复跨 owner 生命周期会丢失已确认提交（P1 优先级）

### 位置及原因

- `packages/storage/tt-adapter.mjs:7-10,19,22-27`：registry 按 api/namespace 共用 opening；native close 的 finally 无论成功失败都删除登记。
- `packages/storage/protocol.mjs:153-157,207-210`：旧 owner 的 recover 不检查是否已经退出 registry/被替代，可从 closed 再变 ready；只撤销旧包装 handle，不撤销旧 owner 本身的 IO 权限。
- 固定宿主源码 `Darkatse/TauriTavern@367b0c7e9410/src/tauri/main/api/db.js:14-20,60-62` 按 namespace 发送 execute/close，不在原 native JS handle 中携带实例代次；“重新打开后旧 native 方法绝不会操作新实例”不是可用前提。

问题发生于**同一 JS 环境、同一 api 对象、同一 namespace**；不是已声明不支持的跨 WebView、跨设备或独立 wrapper 场景。

### 隔离复现

使用现有 `scenario()` 和真实 `openTestStore`/StoreOwner，仅底层 api 为按 namespace 查当前打开库的 Map mock：

1. `a = openTestStore(api, ns)`，通过其 handle 提交 scenario 初始请求。
2. 关闭 a；再 `b = openTestStore(api, ns)`，得到不同 owner，读取同一初始提交。
3. 对仍被调用者持有的旧 a 调用 `a.recover()`，成功返回可写的新 handle。此时 a/b 各自有独立队列、ledger 和分配游标，却指向同一个底层库。
4. a 提交 scenario 第二个合法请求（增加记忆、子线和另一个故事），得到成功确认。
5. b 提交另一个从相同初始状态通过 `commitHistory` 编译的合法 edit，请求/版本 ID 不同，也得到成功确认；其 expected 只对自身过期内存检查，未被拒绝。
6. 重开恢复：b 的操作存在，a 的已确认操作及新增子线/故事不在恢复结果中。物理槽也可能被两个过期分配游标复用。
7. 将第 2 步改成 native close 抛 EIO、底层仍打开，registry 仍被 finally 移除；重复以上过程，同样复现。

整个诊断使用 handle.commit，未绕过它直接并发调用内部 commit，也未手改领域状态来伪造一条非法业务命令。

### 实际输出摘要

关闭成功与关闭失败两种情况下均为：

```text
distinctOwners = true
oldOwnerStatus = ready
newOwnerStatus = ready
bothCompetingWritesAcknowledged = true
firstAcknowledgedOperationRetained = false
secondOperationRetained = true
firstAcknowledgedChildBranchRetained = false
firstAcknowledgedSecondStoryRetained = false
```

### 有界返修要求

统一 registry 与 owner 生命周期，保证每个允许访问的 namespace 在 close/recover/reopen 全流程中只有一条权威写入路径。

可选择：旧 owner 成为不可复活的终止对象；或让 reopen/recover 通过 registry 重新取得同一个受管理 owner。具体实现不在本 review 冻结，但不能仅撤销旧 handle、仍允许旧 owner 绕回可写状态。

close 失败不得无条件放弃协调归属；不明结果保持隔离/待恢复，旧对象不能删除或关闭已经属于新 owner 的资源。重复 close、open/close 并发、旧 owner recover 均需明确语义。不要只在文档要求“调用者自觉不要恢复旧对象”，而保留可确认丢提交的成功路径。

原 fake 测试中的同 owner close/recover 若需随所选生命周期方案调整，应说明契约变化并补等价的安全重开测试，不把错误行为改成预期通过。

## 4. G1-R2：无效发布信息被降级为空库（P1 优先级）

### 位置及两个入口

- `tt-adapter.mjs:16`：`(await native.get(id + 1))?.payload ?? null` 混淆“节点不存在”与“节点存在但 payload 缺失/null”。后者在专用协议库中应属于错误记录，不能静默当成空槽。
- `protocol.mjs:158-176,201-204`：root 仅检查 format/kind/staging，没有要求 tip 字段存在；随后 `root?.tip ?? null` 将缺字段 root 解释为空提交链，最终 owner 变成 ready。

### 已执行的两个反例

A. 使用 FakeIO 正常提交初始请求并确认，保留所有其他物理材料，仅从 root 删除 tip 字段；flush/crash 后新 owner.recover 成功，read 返回 0 个 Story、ledger=0。

B. 经实际 adapter 和 namespace Map mock 正常提交初始请求并确认；关闭后让物理 NodeId 1 **仍存在**，但 payload 为 null；再 openTestStore，同样成功进入 ready，返回空历史和空账本。

两种诊断中原物理集合仍有 20 个节点。这里观察到的是**已有历史被静默视为不可见的空库**，不是声称存储节点已全部物理删除；继续写入仍会放大风险。

```text
MALFORMED_ROOT_MISSING_TIP:
  recoveryAccepted=true, ownerStatus=ready, stories=0, ledger=0, physicalNodesStillPresent=20
EXISTING_ROOT_NODE_NULL_PAYLOAD:
  rootNodeExists=true, recoveryAccepted=true, ownerStatus=ready, stories=0, ledger=0
```

这是刻意构造的异常元数据，不声称普通 TT 调用自然生成了它。任务已经要求恢复校验失败不能当空库，该拒绝边界属于 P2，不需要等完整 P3 文本解析器才补。

### 有界返修要求

只将 native 的明确“记录不存在”映射为 null；存在记录则校验完整协议 envelope。root 必须有合法、显式的 tip 和 staging，tip 为协议允许的 null 或有效正整数引用；缺字段、错误类型、错误格式及现有节点的 null/missing payload 返回类型化错误，owner 不得进入 ready 或接收正常提交。

保留合法空库、显式 tip:null 的合法初始/暂存状态，以及首次发布前中断留下的合法未提交材料。不能把所有“没有已发布 root 但有孤儿”的情况一刀切成损坏，更不能为了修复主动清空库或猜选最新 commit。

错误应尽量在进一步写入前识别；必要恢复屏障失败要传播。诊断性扫描/导出隔离材料与正常“空库可用”必须区分。

## 5. 返修验收与范围限制

继续原 T-03 的 P0～P2，先报告实现/测试各自预计行数；优先修 G1-R1，再补 G1-R2。Chat 本轮只提交 review/阶段文档，未改实现或新增项目测试文件。

最低新增回归：

| 场景 | 预期 |
| --- | --- |
| close成功 → open新owner → 旧owner recover | 不产生两个独立写队列；旧对象明确拒绝或回到唯一受管理owner |
| close失败后重开/恢复 | 不释放未解决的协调归属，不丢已确认操作 |
| 旧owner重复close、close/open竞争 | 不影响替代owner，不误删其registry登记 |
| 两个从同旧状态编译的不同合法操作 | 只允许正确串行提交或拒绝陈旧者；重开保留所有已确认提交及账本 |
| root缺tip、tip类型错误、现有节点payload为空/缺失 | 类型化拒绝，不能返回空库ready；保留材料 |
| 真正空库、合法暂存、首次发布前失败 | 正常支持，不误报或自动清库 |
| 原关闭旧handle、丢确认、R5、小包中断测试 | 正确语义保留并回归 |

重跑原 65 项存储测试、新增测试、48 项契约、18 项探针及语法/diff 检查。区分原测试数、新增数、实际失败/通过，不为凑计数改旧断言。

补一个小型原生 close→reopen→旧owner 操作的生命周期验证，以及全新测试 namespace 下异常 root/payload 的拒绝回读即可；native close 失败可在 mock 注入，不要求制造真实 IO 故障。只用现有隔离副本/新 namespace，不修改或强杀现用 TT，不需重做整套原生强杀矩阵。若发布/flush/恢复协议本身也被实质改动，再重跑受影响强杀点。

## 6. G1 对已声明缺口的处理

以下不作为本轮第三、第四项返修，而是后续放行 P3 必须携带的条件：

- **持久化请求意图与生成 ID 保留**：在正式业务入口确认接收前保存可恢复请求/ID，重启后不依赖 fixture 的固定 seed 重新生成；原 operation 与结果可对应。不要求 P2 现在实现完整用户业务入口。
- **外部维护协调**：除修复本轮内部 owner 问题外，未来宿主同步/归档替换须撤销运行代次并重开校验。没有可靠通知时应有明确互斥/停用维护限制，不能声称自动接线已实现。
- **空间放大**：现有 256记录/32消息/64提交等硬上限作为 P2 保护可接受；P3 必须对 command.entries、views、expected、journal/目录建立有界表示，不能只优化正文。
- **包边界**：`mnemosyne-storage-p2-v1` 是独立小型诊断恢复包；logical v2 与额外 ledger/journal/markers 全部保留，不称为全产品备份。流式版本及互操作规则在 P3 单独定稿。
- **设备保证**：原生强杀不等于硬件断电、真实磁盘满或 Android 后台测试；不因此授权手机生产使用。

当前先关闭 G1-R1/R2 并复核；随后才决定 B1 扩展和 P3 放行。无须用户重新回答单端偏好或猜选数据库；不创建 T-03A/T-04，不自行切 B2/A。

## 7. 固定源码与证据入口

- [protocol.mjs @ 8e3f6a6](https://github.com/Roballz/liminal-axis-mnemosyne/blob/8e3f6a6828177b93bdeaceafb3a8d062847ecb01/packages/storage/protocol.mjs)
- [tt-adapter.mjs @ 8e3f6a6](https://github.com/Roballz/liminal-axis-mnemosyne/blob/8e3f6a6828177b93bdeaceafb3a8d062847ecb01/packages/storage/tt-adapter.mjs)
- [原存储测试](https://github.com/Roballz/liminal-axis-mnemosyne/blob/8e3f6a6828177b93bdeaceafb3a8d062847ecb01/packages/storage/tests/storage.test.mjs)
- [场景fixture](https://github.com/Roballz/liminal-axis-mnemosyne/blob/8e3f6a6828177b93bdeaceafb3a8d062847ecb01/packages/storage/tests/scenario.mjs)
- [提交的原生证据](https://github.com/Roballz/liminal-axis-mnemosyne/tree/8e3f6a6828177b93bdeaceafb3a8d062847ecb01/evals/t03/native)
- [候选协议及已声明限制](https://github.com/Roballz/liminal-axis-mnemosyne/blob/8e3f6a6828177b93bdeaceafb3a8d062847ecb01/docs/09-storage-provider-and-recovery.md)
- [TT namespace调用源码 @ 367b0c7](https://github.com/Darkatse/TauriTavern/blob/367b0c7e9410/src/tauri/main/api/db.js)
