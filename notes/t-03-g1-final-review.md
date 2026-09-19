# T-03 G1 最终 Chat review：R1/R2 关闭，放行 P3

日期：2026-09-20。
审核实现：`48663c4935040f8dc79d964d6595b3d51a042cad`。
返修基线：`26f41713a6fd178162c2b633f419bbc67f526726`（实现与 `8e3f6a6` 相同）。
前轮记录：`notes/t-03-g1-review.md`，保留为历史审核证据；本文件是原 T-03 的 G1 关卡回执与 P3 执行补充，不是新任务卡。

## 1. 结论与批准范围

**G1 通过。G1-R1、G1-R2 关闭，允许继续原 `tasks/T-03-storage-foundation.md` 的 P3。T-03 总状态仍为 in_progress。**

本轮复核未发现新的 G1 收尾阻塞。接受 P0 的固定版本原语证据、P1 的发布/确认/可见性分层，以及修复后 P2 的有硬上限存储与小包恢复原型，作为下一增量的基础。

**B1：TT TriviumDB 作为 P3 实施路线放行，不等于正式手机/生产 provider 已验收。** 当前批准限已记录的隔离 TT `367b0c7e9410`、单 JS 宿主内同一 api 对象/namespace 的受控写入入口与合成样本。无需现在改做 B2/A；若 P3 发现原语无法支持必要的一致性/恢复能力，再带证据回到 Chat/用户决定，不降低标准强行保留 B1。

原型上限仍保留；P3 的有界存储、完整恢复、正式持久请求入口和维护协调，以及 P4/P5 均不能因 G1 通过而视为已完成。手机、真实档案、A 服务器、真实 B→A 迁移仍未准入。

## 2. 本轮真实执行证据

### Chat 独立执行

环境：隔离 Linux / Node `v22.16.0` / Git `2.47.3`。

通过 GitHub connector 读取固定提交。容器直接下载因 DNS 不可用失败，随后复制原文本，在运行前逐一核对 Git blob SHA；被测文件与下面固定版本完全一致，未修改实现、fixture 或断言。

| 文件 | Git blob SHA |
| --- | --- |
| packages/contracts/primitives.mjs | b59a3bacfa97289e9190c459db5b544bdcad94ca |
| packages/contracts/runtime.mjs | 80866e66a8b0b52611da28a19303ec3c32707689 |
| packages/contracts/schema.mjs | 864f21302c45cd2324c1cfbccf09829e5f6a4075 |
| packages/contracts/index.mjs | b86662882940d45572e09a991424014ce4b4c2f9 |
| packages/contracts/history.mjs | 39370d7f621f708c1fdc81de93e4c79106a5fdca |
| packages/contracts/context.mjs | 30a7410263fa8070dc90233e142b146112be102f |
| packages/contracts/transfer.mjs | 9c5f59dcc9b33de50d07ea4540425a892dcfa8fb |
| packages/contracts/memory.mjs | ed37308f418031ccc559b8b318e79c8d1c2ad553 |
| packages/contracts/tests/fixture.mjs | 4be1e82e92434c73793c4c7553556e653ac4da51 |
| packages/storage/tests/scenario.mjs | 928e0f5d63ef9bf0762e31680b87980a744eafc6 |
| packages/storage/tests/fake-io.mjs | 417eaca141ffbc66423571a65bcdea83c700cec2 |
| packages/storage/protocol.mjs | f6d4755be3e8b7c8fdb306437f4bf0ecd7d3214f |
| packages/storage/tt-adapter.mjs | 14ebb5c26fd2216cb5ddfb96d9dd0a09de66fda0 |
| packages/storage/tests/g1-review.test.mjs | 2253ff5c295e0b67d964bc2680a211bcf355327b |
| packages/storage/tests/storage.test.mjs | 162c448558caaf57a523629e0694a035162f27db |

实际运行：

- `node --test --test-reporter=tap packages/storage/tests/g1-review.test.mjs`：**19/19 通过**。
- `node --test --test-reporter=tap packages/storage/tests/storage.test.mjs packages/storage/tests/g1-review.test.mjs`：**84/84 通过**，0 失败/取消/跳过。19 项已包含在 84 项中，不相加。
- 上述 15 个 `.mjs` 逐一 `node --check`：**15/15 通过**。
- 独立副本恢复修复前实际 protocol/adapter，然后运行同一最终 19 项定向测试：**10 通过、9 失败，退出码 1**，为预期红灯对照。旧 protocol blob 为 `aefb3687816510ba043e8d956663de95bc6a3b00`，旧 adapter blob 为 `bb7090a90254ce775d7b529e9b17ad2dffc25a2c`；两者校验一致后才执行，不是自行编写的模拟旧实现。
- 当前 protocol、adapter、两份 storage test 和 scenario 共 5 份源码 SHA-256，另与 Codex `repair-hashes.json` 中的 sourceSha256 核对一致。

完整输出交付为 `t03-48663c4-g1-review-evidence.txt`。本文件保留命令、版本及结果，Codex 无需依赖会话附件才能继续。

### Codex 回报与原生证据审阅

- 已核对 `evals/t03/g1-repair/after-final.tap` 的 **150/150**、0 失败/取消/跳过；完整 150 项、23 文件语法和 diff 检查是 **Codex 执行结果**，本轮 Chat 没有独立重跑全部契约/旧探针或完整仓库 diff 检查。
- 已审阅 `native-20260919g1.json` 与对应 native suite：旧 owner recover/read/native IO 分别得到 OWNER_CLOSED / STALE_HANDLE / OWNER_CLOSED；替代 owner 重开保留两条确认账本及预期状态。
- 缺 tip 的 root 与既有 null payload 节点均得到 NEEDS_RESOLUTION；被观察的异常节点内容未被自动替换，节点数 20→20。该记录不是全库逐字节审计，也不是新的硬件断电证明。
- 两种关闭失败（关闭前失败、实际已关闭但回复失败）由 namespace-dispatching mock 覆盖，**没有伪称为真实 TT 原生 IO 故障**。
- Codex 初始红灯为首批 18 项中的 8 项失败；本轮独立红灯使用最终 19 项，得到 9 项失败，两组数量不同不是证据冲突。

## 3. G1-R1：owner 生命周期关闭

成功关闭后以私有 retired 状态永久终止旧 owner；旧 recover/commit 不能重新取得写入能力，重复 close 不再影响替代实例。适配层 IO 复核 registry 归属，旧 owner 不能通过所持 native 包装访问替代 owner 的资源。

关闭结果不确定时不删除 registry：同一 api/namespace 仍指向同一 owner 和队列，状态为 recovery-required。恢复在原队列中重新 open 原生 namespace，再执行原有回读/校验；旧 handle 因 generation 改变而失效。open/close 交错需等待并重新核对登记。

定向测试分别覆盖成功关闭、关闭前失败、关闭后丢回复、close/open/recover 交错、失败后重试 close，以及旧 IO 被拦截。合法竞争只确认一项，重开保留已确认状态、子线、第二故事和账本。

两处旧测试从“成功 close 后同 owner recover”改为“旧 owner 拒绝，新 owner 回读”，符合修复目标；原有状态/幂等断言保留，不是放宽防丢要求。

## 4. G1-R2：异常读取不再伪装空库

只有 native.get 明确返回 null 才表示记录不存在。既有节点的缺失/null/数组等非法 payload 不转换为空槽；root 必须具备完整字段及显式合法 tip/staging，失败保留待恢复/待修复状态。

缺 tip、非法 tip 类型/范围、缺 staging、错误 format、root 与非 root 的损坏 payload 均有定向回归。合法空库、显式 null tip、暂存导入及首次发布前孤儿仍可解释，首次未发布请求可以精确重试。

此结论只涵盖明确测试的无效记录及既定故障模型；不声称能自动推断任意人为删除 root 后的原历史、不宣称所有介质损坏都能自修复，也不允许通过猜测最新 commit 或清空材料解除故障。

## 5. P3 实施许可与优先顺序

继续原 T-03，不创建 T-03A/T-04。以下是已有 P3 要求的明确化，不要求扩大到完整业务引擎；开工照常报告文件、依赖、实现/测试预计行数及验收方式。

### 先补两项恢复前提（高难，排在 P3 前部）

1. **持久请求与生成 ID 的恢复入口。** 不再依赖调用者内存中保存编译请求，重开可定位尚未确认的操作、原请求/指纹和已生成 ID。区分准备材料、已发布结果与取消等待；重试先判原操作状态，不重造随机 ID/重复业务副作用。历史、记忆选择/纠错与绑定操作都要有可恢复的去重边界。具体存储封装独立版本化，不能向标准 v2 历史 command 表混塞异类操作。此机制当前未实现，不能写成已验收能力。
2. **外部维护与句柄换代协调。** 正常产品读写只通过一个明确的协调入口；宿主同步/归档整体替换、关闭/重开之后先停止旧入口、排空或隔离未决写入并重新核对库身份/状态。不能因为 namespace 字符串相同就认定仍是原库。宿主能力不足以证明这一边界时，只停下受影响路径并报告具体缺口，不能编造维护事件或以本轮同 api 的测试代替验证。

### 再做有界存储与完整恢复（继续高难）

- 同时处理 manifest、command.entries、views/corrections、expected、重建标记、journal/ledger 和目录的放大；不能只分块正文却仍每轮全库复制、完整回放所有旧操作。
- 共享不可变块、精确 ID 索引、恢复检查点/枚举与稳定导出边界保持契约语义；用小样本 oracle 对照，普通路径有界，大规模审计允许显式扫描。
- 独立恢复封装与标准逻辑包 v2 的无损关系写清，保留已提交结果账本；流式/有界导入先在空目标校验全部引用、R1～R5、格式和资源限制，成功后才激活。
- 每项高难增量同步记录正常、失败、丢确认、重开与回退证据。任何影响当前临时格式的变化都需版本化并保全已有测试库，不覆盖旧库试迁移。

完成后更新原 task 的 P3 高难项交接，再按原卡安排 P4/P5；本次只决定下一增量可开工，不提前批准其验收。原 150 项回归继续保留；生命周期变化必须说明断言变更理由，不通过删测试降标准。

## 6. 总任务与未验证边界

T-03 仍 in_progress，S-A 尚未完成。P0～P2 在此有限范围通过 G1；生产数据入口、P3 有界存储/恢复、P4 索引及资源/设备验证、P5 操作说明仍有工作。

维持单权威写入、合成数据和独立桌面副本；未授权升级/强杀生产手机、读取真实 RP、调用付费 API、自动 GC 或切换部署路线。本轮只写审核与当前状态文档，没有修改仓库实现或执行 P3。

## 固定来源

- [修复实现](https://github.com/Roballz/liminal-axis-mnemosyne/commit/48663c4935040f8dc79d964d6595b3d51a042cad)
- [定向测试](https://github.com/Roballz/liminal-axis-mnemosyne/blob/48663c4935040f8dc79d964d6595b3d51a042cad/packages/storage/tests/g1-review.test.mjs)
- [原生验证记录](https://github.com/Roballz/liminal-axis-mnemosyne/blob/48663c4935040f8dc79d964d6595b3d51a042cad/evals/t03/g1-repair/native-20260919g1.json)
- [Codex 最终全套输出](https://github.com/Roballz/liminal-axis-mnemosyne/blob/48663c4935040f8dc79d964d6595b3d51a042cad/evals/t03/g1-repair/after-final.tap)
