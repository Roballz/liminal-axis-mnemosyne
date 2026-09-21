# T-03：可迁移、可恢复的存储地基

状态：in_progress（按fc3264b返修P4-R1/R2与P5-R1，333项回归保留原322项；两处快照一致性、有界目录合并及兼容/新路径故障验证已实现，最新资源完成线见notes/t-03-p4-repair-handoff.md；自动维护门禁保留，待Chat复核）

发布：2026-09-19。规划仓库基线：`4dcdaf568ddb596c9060c27ef4c57fb858095509`。
T-02 已验收实现：`1891043f6fc907236e12bb85d63ea823f43abca8`；规范为 `docs/06-contracts.md` v0.3 / 对象 schema_version=1 / 逻辑包 format_version=2。

本卡由 Chat 根据用户本轮授权发布，取代 `T-03-storage-foundation.proposal.md`。**首次施工只执行 P0～P2，随后停在 G1 交 Chat review；G1 放行后才做 P3～P5。** 不因文件状态为 planned 就跳过选型与恢复协议审查。P0～P5 是同一任务的增量，不新建 T-03A/T-04 等卡。

## 1. 用户目标、范围与阶段完成线

让已验收的历史/记忆契约真正可靠落盘：手机关闭或应用异常退出后，已确认的历史、分支和纠错记录不丢；有完整逻辑备份，日后换独立服务器不重写身份或重新付费总结剧情。

优先验证 **B1：TT 本机 TriviumDB provider**。本任务先交付隔离桌面 TT 环境的持久化与恢复地基，不能冒充 A 独立服务器、正式手机产品或真实 B→A 迁移已经完成。手机准入单独记录，未获得安全测试条件不操作现用手机。

S-A 的 T-03 完成条件：选定 provider 经过 G1；P3 的有界存储/完整逻辑恢复通过；P4 的规定正确性与资源冒烟完成；P5 有可复现的操作/回退说明；最终由 Chat review 升 verified。只完成 P0～P2 不关闭 T-03。

不做：正式 RP/柏宝书导入同步器、自动配对非标准回合、真实 LLM 摘要/重建、完整混合召回/外部 reranker、完整工作台、认证服务器/MCP、离线多主合并、自动 GC、改 TT/ST/柏宝书源码或接管用户真实档案。

## 2. 必读、事实与未决项处理

依次读取 AGENTS、README、S-A、本卡，再读：

- `notes/t-02-final-review.md`、`docs/06-contracts.md`、`packages/contracts/` 及现有三组契约测试；R1～R5 以最终结论为准。
- `docs/08-history-snapshot-and-rebuild.md` 的 Head/清单/固定 fork；`docs/03-decisions-and-open-questions.md` 的 B 单权威写入及存储候选。
- `notes/baseline.md`、T-02A 最终回报；`docs/07-t02-contract-proposal.md` 的数据库边界与逻辑迁移讨论。旧 proposal 只供历史对照。

**无需再次询问的已确认项：** B/A 共用领域规则；单权威写入且用户主要长期使用单台手机；正文为历史权威；来源/coverage 逐层重建；不确定不猜；真实档案不做首次破坏性实验。

**任务内用事实关闭，不要求用户现在猜答案：** 安装版是否含 api.db、无 embedding 的保存路径、精确映射/枚举、持久性屏障、单写协调、块参数。先检查现有环境，不自动升级生产安装；能力缺失时报告具体缺口。

**仍需关卡决策：** B1 能否承载正式数据；若不满足，B2（本机正式存储与索引分离）或提前 A 由 Chat/用户决定。不能自行补造文件/SQL API、安装服务器、修改收费配置或降低正确性标准。原非标准回合、品牌名、模糊匹配、自动保留期等不阻塞此存储任务，也不由 Codex 顺手决定。

## 3. 本轮核对后必须带入的契约

1. Head 指向完整不可变 snapshot/manifest，清单选择 `(message_id, revision_id)`；固定父 snapshot 前缀，父线修改不改变子线。UUID 与物理 NodeId/路径分离。
2. **记忆视图是独立可变状态：version、selections、corrections 必须一致发布。** 不能只持久化正文 Head。持久化继续保留 current/checkpoint、advance/replace/correctMemory 的已验收区别。
3. **R5 交叉不变量：被选中的根沿本分支 corrections 解析必须仍为自己。** 有效 checksum 不替代归属、引用、无环及此交叉校验；恢复前拒绝矛盾，不自动选新版或删纠错关系。
4. 同 operation 同请求重试先返回原结果，再考虑旧 expected Head；同键异 payload 拒绝。expected memory view、binding_generation 同样防陈旧写入；旧 binding 不原地跨 Story。
5. derived-only 在同 Branch 声明前缀保持时续用，前缀修改待确认，不自动跨子线；必需记忆不可用不伪装 empty。旧检查点未被选择不等于失效。
6. 原文归档/修复与正常召回就绪分开；有待重建、索引落后或未确认提交时不得放行旧记忆。只存恢复材料和预制任务，不执行真实 LLM 重建。
7. 逻辑包 v2 保留 T-02 已建模的 stories/branches/messages/revisions/blocks/snapshots/memories/views/operations/bindings。旧 v1 走已验收的显式兼容，不删字段伪装降级。
8. **缩回旧预案的超前备份承诺：** T-02 尚无完整模块、用户锁、通用任务结构，本任务不发明它们并称全产品备份。保留当前模型中的全部归档和选择；存储层若新增提交账本、重建标记、恢复检查点，必须单独版本化、可导出恢复并在 G1 说明其与 v2 的关系。

## 4. 开工报告与允许范围

开工报告 commit/分支/工作树、必读文件、实际 TT/Node/OS、隔离 data root 与本次测试 namespace 清单、预计文件、实现与测试行数、依赖/许可证、执行命令和当前增量完成线。

首个 P0～P2 增量的 Chat 粗估：实现/适配约 400～800 行，测试/fixture 约 400～900 行；不是配额或完整 T-03 总量。Codex 按实际情况重估，G1 后再报 P3～P5 工作量。不为凑行数扩建工程。

允许新增最小 `packages/storage/`、TT storage adapter/独立诊断 harness、`evals/` 虚构 fixture 和故障日志、必要文档及少量构建入口。目录名可结合实际工程调整，但必须保持 Core/Host/Storage 分层。

T-02 是小样本语义 oracle，不是每次写入全库复制的生产实现。允许抽离最小跨运行时 crypto/编码接口或复用校验逻辑；不得改变已接受语义、移除校验、静默改指纹或抄一套逐渐分歧的领域模型。全部原测试保持回归；如发现新语义缺口先单列给 Chat。

只用虚构测试数据。现有 `.codex/`、用户安装/真实存档/其他扩展与数据库不动；不调用付费模型或上传真实 RP。建立独立测试空间不等于获准删除它或终止共享生产进程；清理/实际强杀前明确目标与隔离证明，不确定则停在模拟测试并报告。

## 5. 实施顺序：先攻坚，再做常规收尾

### P0：最小环境/能力核对（必要前置，不做界面装修）

核对实际安装、`api.db` 和安全独立测试环境。T-02A 的 `5e33bf6fead6` 仅是旧宿主基线，不证明现装版含数据库。核验正式数据不依赖付费 embedding、精确 ID 回读、重开、完整枚举的可行入口。

优先复用当前公开接口；若只能通过向量承载节点，需明确隔离纯存储记录与语义索引并实测，不能把占位向量混进真实召回。复杂 JSON 不能靠未经证明的 TQL CREATE 替代。Node crypto 不可直接在 TT WebView import；先以最小运行时适配验证 UUID/JCS/SHA-256 对照值，再写更大功能。

输出：版本/接口矩阵与隔离证明，标明 source-only/observed/unsupported。没有 api.db 或安全独立环境时停下相关原生操作；可完成纯协议分析，不冒称 B 原型通过。

### P1：提交、幂等与恢复协议（最高难，先写不变量和反例）

在扩建 CRUD/块树前，用实际可用原语写清一个业务提交的状态机与失败处理；T-02 没有提供跨调用事务。

- 明确持久提交点、确认返回点、读者可见点；先保存不可变对象及恢复材料，后发布当前引用。真实事务可用则优先用；不可用时可评估不可变提交记录 + 单一发布点/恢复目录，不直接把多次成功写入当原子。
- 持久记录 operation 请求指纹、预期状态、结果及必要重建标记；Head/view/binding 等受影响状态要来自同一次可解释提交。读者不能看见新 Head 配旧纠错视图或丢失的失效标记。
- 记忆选择/纠错/绑定操作不能只有历史 command 那一套幂等保护。其去重/恢复元数据独立版本化，不往 v2 的历史 command 表硬塞异类操作。
- 一个权威写端仍有多个异步任务/handle；它们必须共用协调入口。重启后内存 mutex 已丢，需从持久状态恢复；不能依赖 TT namespace 同步充当锁。
- 已确认提交在声明的故障模型内必须保留。未收到确认的请求可能已提交，恢复按持久提交证据核定，重试用同 operation；**超时/停止等待不等于原生写入取消或回滚。** 无法判断时明确待恢复/冲突，不换新 operation 盲重试。
- 不能因取消发生在提交之后而撤销已提交历史。若原生操作尚在运行，禁止释放逻辑写入权后让竞争请求并行改同一状态。
- 先列模型故障、进程异常退出、底层 IO 失败、硬件断电的不同保证。full/flush 的实测与源码依据分别记录，不承诺物理断电零损失。

**同时前置检查空间放大：** T-02 的 command.entries 和整份 state 是参考表示；若每轮把整条历史 command、全量视图或目录列表重复落盘，分块正文也救不了增长成本。协议应允许无损引用/分块保存重复结构，并能还原原请求指纹。数据正确性和恢复目录本身不能依赖一个不断全量重写的无限大 JSON。

### P2：极小真实存储闭环 + 断点恢复（最高难，先证实最危险路径）

只建设支持上述协议的薄 B1 原型，用小清单、两条故事及父子分支、预制记忆/纠错完成：写入 → 失效/提交 → 非正常重开 → 按 ID 回读 → 小型逻辑包导出 → 全新测试库导入。此时不做优化块树、大面板或真实语义检索。

逐个命中故障点，保存 seed、故障序号、operation、前后 Head/view、确认状态、持久回读与校验结果。注入器必须能区分写入前失败、底层已写入但返回失败/丢确认，而非总在第一条调用前抛错。

| 断点/组合 | 必须观察到的边界 |
| --- | --- |
| 正文/块写到一半 | 当前可见历史不能引用半份数据；旧已确认提交仍可读 |
| snapshot 完成但发布前 | 未提交材料不作为当前剧情；重试不重复造逻辑对象 |
| Head/操作结果/失效标记交界 | 不出现结果已生效却查不到提交证据或漏重建状态 |
| selections/corrections/view 交界 | 恢复后满足 R1～R5；不允许矛盾选择和旧摘要注入 |
| 已持久提交、确认丢失或等待被取消 | 同 operation 得到同一逻辑结果；竞争旧版本写入拒绝 |
| 两个异步写入者竞争、close 后 reopen | 协调有效；失效 handle 不继续悄悄写入 |
| IO 失败/空间不足（可控故障注入） | typed error/未确认状态明确，不宣称成功、不清空旧库 |
| 小备份或暂存导入中断 | 原库未被覆盖，半成品不能被报告为完整备份/激活为新库 |

每个协议断点有确定性模拟；隔离真实 TT 至少覆盖发布前和发布后丢确认附近的进程异常退出/重开。正常 close/reopen 不是异常退出测试。不能安全实施时保留 pending，此项不算通过；不得对生产手机/共享真实实例强杀或填满磁盘。

#### G1：必须暂停的选型与协议 review

提交 P0～P2 实际回报、能力矩阵、发布/恢复协议、故障证据及临时包范围；T-03 总状态仍 in_progress，不升 implemented_unverified/verified。

Chat 根据真实证据确认 B1 是否可扩展，再放行 P3；不适合时再讨论 B2/A，Codex 不自行更换路线。**本轮没有等待用户先猜答案的产品未决项，但不取消这一工程选型关卡。**

### P3：有界分块清单 + 完整一致导出/恢复（高难，接着集中完成）

在 G1 选定路径上完成持久对象/清单/快照/分支/记忆视图/绑定与恢复账本的必要读写。

- 清单使用有界、不可变共享块；局部 append/edit/insert/delete/fork 只改必要块及目录路径，不能每轮复制全文、整份 state 或所有历史操作。UUID 索引、namespace 目录和枚举游标重启后可重建/核对；物理 ID 冲突不得覆盖领域对象。
- 全量历史重建/逻辑审计可以显式扫描；普通追加和局部读取不先 materialize 全库。小 fixture 可用 T-02 内存模型做 oracle，大规模路径需有界读取。
- 对照历史序列、来源版本、fork、记忆适用性、幂等结果与 R1～R5；不同块布局不要求与双条目 oracle 的物理块分配相同。已生成领域 ID/快照引用在备份恢复中必须保留，不以换库为由重编号。
- 导出枚举所有需要保留的正文、版本、旧快照、块、memories、views/corrections、operations、bindings，而非仅当前 Head 可见对象或 search topK。保留当前模型可表达的用户修正、排除/私有声明与删除后的历史；不自动 GC。
- 采用有边界的导出快照：可先暂停写入取得固定提交视图，再流式读取不可变对象；多故事/视图不能各读到不同提交时刻。基础目录、重试账本与索引任务进度都须有一致恢复边界。
- 标准 v2 包是互操作基线；存储层需要流式布局/辅助账本时，给出独立格式版本及到 v2 逻辑内容的无损关系，在 G1 说明后实现。不能忽略账本再称完整恢复，也不能直接把全内存 exportLogical 用在无限规模。可在明确大小上限内提供标准 v2 输出。
- 接收文本时处理重复 JSON key、无效 Unicode、深度/字节/记录数量上限；超限明确失败，不截断正文。checksum 校验和 R5 等领域关系校验均需执行；跨浏览器/Node 的编码指纹一致。
- 导入只进新的隔离库/暂存空间，全量引用和版本校验通过才激活。未知格式、重复 ID 异内容、缺块、断链、R5 矛盾包拒绝；不以覆盖原库后再校验的方式恢复。
- index 是可重建派生层。正文事务不等 embedding/text index 成功才保存，但必须有持久的索引落后/重建进度；副作用重放不得重复改正文，实际模型生成不在此任务实现。

任何无法无损保留 T-02 契约的存储简化都要停下 review，不能把已验收语义悄悄降低为“稍后再补”。P3 结束先更新高难项交接记录，列尚未验证边界，再进入收尾。

### P4：索引恢复、资源冒烟与安全设备验证（主要验证，不后置新架构攻坚）

小型中文 marker/人工数值向量验证：正文写入后索引失败/丢失能重建，错误 Story/Branch/版本不会进入结果；已过期候选必须再做领域过滤。只证明基本存取与恢复，不称完整 E-01/BM25/语义质量评测。

使用固定种子合成数据：小集 → 约百万字符 1x → 5x/10x，记录 UTF-8 字节数、消息/历史版本/分支/operation 数量，不能只复制一个大字符串。包括长时间逐轮增长和深层编辑/分叉，检查 command/账本/目录的重复放大。P1/P3 已先关注该风险，不到最后才设计解决办法。

固定设备、场景、迭代数、资源上限和停止条件后再测冷启动、ID/范围读取、追加、编辑/删除、fork、导出/恢复、峰值内存、主线程阻塞及磁盘放大。延迟预算尚无用户确认，因此本轮标**探索性测量**，不编造毫秒目标或手机性能达标结论；正确性与有界算法要求不因此放宽。达到资源上限应安全终止并报告边界，不能崩溃后写“压力通过”。

1x 的完整恢复和有界操作是本任务资源冒烟完成线；5x/10x 是容量探索，未完成/超限如实记录且不得宣称该规模可用。真实百万字样本要额外获得使用范围许可，本次默认不需要它；合成数据不证明长期剧情质量。

手机：已有安全独立环境且用户允许时，用合成样本验证最小保存/后台挂起/重开/恢复及诊断可用；否则明确 mobile pending，桌面结果不能授权替换手机长期档案。后台被终止时靠已实现的恢复协议，不能声称 TT 关闭后仍持续运行任务。实际维护事件不可安全触发的项目标未测，不用模拟通过冒充真机通过。

### P5：最小诊断入口、操作说明与收尾（中低难，最后做）

保留一个最小状态面板/命令入口：版本、当前测试库、Head/view、提交/恢复/索引状态、明确错误，以及合成样本导出/恢复验证入口。不要做完整工作台、品牌美化或真实聊天自动同步。

整理安装/启停、故障复现、备份和只读回退说明；自动化测试输出先随高难阶段记录，最后只做汇总，不事后补造证据。退出调试版本保留库与备份，不自动清理归档。

## 6. 验收矩阵与不得省略的回归

| ID | 验收结果必须可复现 |
| --- | --- |
| S01 | 实际 TT 与运行时能力已核对；无 embedding 保存复杂 JSON/正文，冷重开仍保真 |
| S02 | 发布前/发布后/丢确认/取消与重试均满足 P1 协议，已确认提交不因所测故障丢失 |
| S03 | expected Head/view/binding 拒绝陈旧请求；同操作同结果、同键異请求冲突；多个 handle 协调 |
| S04 | 持久恢复后的父子隔离、检查点、纠错传播、无原文续聊与 R5 拒绝均与 T-02 一致 |
| S05 | 局部修改有界；历史清单、operation/目录/视图没有全量重复写放大陷阱 |
| S06 | 全量枚举/稳定导出/空库恢复保留 ID、全部约定对象和恢复材料，不重生成正确摘要 |
| S07 | 异常/矛盾/超限导入不激活、不覆盖；checksum正确仍不能绕过领域校验 |
| S08 | 索引失效不损害正文；恢复/维护后不使用旧 handle 或过期候选 |
| S09 | 1x 合成集完整恢复与资源记录，5x/10x探索和手机结果分别标注边界 |
| S10 | 文档、实际命令、回退和选型理由完整；无真实数据/密钥写仓库、无越界任务 |

原回归：`node --test packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js`（当前 48+18=66 项基线，不是本卡声称已重跑）。原有文件修改时保留其正确反例语义；执行相关 `.mjs`、探针语法检查及 `git diff --check`。新 storage/真实 TT 测试命令依实际工程记录，不臆造 npm 脚本。

必须区分：源码推导、内存/故障注入器测试、真实 TT IO/异常退出、手机结果。提交可复现测试、版本/seed/断点和脱敏统计；未执行标 pending。正常 close/reopen、fake provider、全内存 roundtrip 单独通过均不足以声称持久性验收。

## 7. 回退、清理与 T-04 边界

保留原实现基线、测试库与可验证逻辑包；回退代码不能删除 corrections/checkpoint 后冒充兼容。迁移/格式变化前保全原包和暂存区。回退到旧库前先保全之后新增提交，不能丢掉新剧情。

清理须列出本任务实际创建的精确 namespace/data root，并得到授权；不按宽泛前缀删库、不填满真实磁盘、不操作共享生产实例。自动保留期/GC 未批准，所有仍被保留快照/分支引用的对象不清理。

B→A 只验迁移材料和 B→空环境的恢复；A 尚未实现时不称真迁移完成。正式导入/同步/搜索/派生仍留后续任务，不自动创建 T-04，不自动启用生产手机。

## 8. 文档和实施回报

更新本 task、S-A、README/包说明、CHANGELOG、实际 provider/发布恢复规范、evals 结果；规范可新建 `docs/09-storage-provider-and-recovery.md`，实验记录可用 `notes/t-03-storage-evidence.md`。这些是契约和证据，不创建不断追加的对话日志。

首次回报只到 G1：P0～P2 的实际改动、代码量、接口/故障证据、原语限制、B1适用性、G1待决定事项及下一增量估计。G1未放行时禁止继续 P3。

最终实施回报：实际选型及为什么；格式/运行时差异；持久提交和恢复协议；S01～S10结果；原回归和新测试；真实与模拟边界；各尺度/设备指标；回退与剩余风险。状态到 implemented_unverified，Chat 决定 verified；部分关卡通过不等于全部完成。

## 9. 本轮依据与批准边界

用户本轮授权：在无新增产品取舍阻塞时发布正式卡，并将高难项尽量前置。本卡据此调整为 P0必要前置 → P1协议 → P2真实故障小闭环 → G1 → P3块/恢复 → P4验证 → P5常规收尾。

本卡的阶段顺序、G1和范围是本轮工程安排；不是 TT 已实现的能力或新测试结果。原预案中未填写的 T-02 基线、包格式现已由最终review补齐。

外部事实仅采用本轮经 GitHub 连接回读的固定 TT 来源，**不宣称是上游最新或用户当前安装版**：
- [Database API @ a1855be](https://github.com/Darkatse/TauriTavern/blob/a1855be4a4f8b6ee7cd0374a84dbb3709c3e5375/docs/API/Database.md)：共享close、后台flush不能保证强杀回调、停止等待不等于取消原生执行、索引WAL边界、listNamespaces仅列打开库等。
- [Sync @ a1855be](https://github.com/Darkatse/TauriTavern/blob/a1855be4a4f8b6ee7cd0374a84dbb3709c3e5375/docs/CurrentState/Sync.md)：namespace整体替换，不合并记录，不提供多端写锁。

实际版本若不同，先记录差异并评估协议前提；不为追新功能默默升级生产环境。

## 实测与关卡状态（2026-09-20 Codex 回报）

**本增量交 G1 review。P0 已取得安装/接口/隔离证据，P1 候选协议及 P2 有硬上限的原型为 implemented_unverified；T-03 总状态 in_progress。G1 未放行，P3～P5未执行，不创建下一张任务卡。**

### 基线、环境与范围

- `git pull --ff-only origin main`：从1891043快进到 `852260acd8d3e65d9d756af81cdf72e52c50046b`；实施提交为 `3e583e7`（`feat(storage): implement T-03 P0-P2 recovery prototype`）；分支 main，原有未跟踪 `.codex/` 未修改。
- 已读 README、AGENTS、S-A、本卡、T-02最终review、06 v0.3/逻辑包v2、08 Head设计、03单写/存储决策、07数据库边界、baseline、T-02A回报、contracts及三组测试；历史“proposal”状态按正式任务覆盖。
- Windows 10 Pro x64；Node v24.19.0；Git 2.55.0.windows.3；WebView2 153.0.4234.32。用户更新后的 TT `dev (367b0c7e9410)`，File/ProductVersion仍2.2.0；二进制60186112 bytes，SHA256 `11a9bc110da5dc634ff8c0b7b8fe244110c360af46693e50de67968cb811f2c4`。旧安装5e33标记只保留为更新前事实。
- 只复制程序/default/frontend-templates到 `D:\Mnemosyne\.t03-local\tt-367b0c7`，portable.flag选择独立 `data`，WebView profile单独放在 `webview-profile`。源码与实际进程路径/profile均核对；未复制现用聊天、模型配置或令牌。
- TT单实例插件曾拦截副本；用户正常退出原实例后再启动。实际强杀只针对验证了固定路径/SHA/本次kill-ready事件的副本：发布前PID14208、发布后PID11144。2026-09-20因额度中断恢复，重新启动PID6552；未把用户报告的随Codex关闭当成额外受控崩溃实验。
- 无新依赖/服务安装或第三方实现代码复制；无真实RP/付费API/生产手机/现用安装改动。测试collector只监听127.0.0.1:19374并在结果后退出，远程调试端口尝试未生效且最终不使用。

### 实际改动与代码量

- 新增 `packages/storage/protocol.mjs`、`tt-adapter.mjs`：共享写队列、变化对象/提交账本、单root发布、未知结果门禁、精确回读恢复、独立ledger/markers/journal小型包、空namespace暂存导入与激活。
- 新增 `packages/contracts/runtime.mjs`，primitives只替换UUID/SHA运行时；同步指纹/JCS、用途版本和已验收语义不变。Node/WebCrypto/真实TT对照通过。
- 新增故障fixture、原生harness/collector/隔离进程脚本，以及 `.gitignore` 中只忽略本次 `.t03-local/`。证据在 `evals/t03`；候选协议和限制在 `docs/09-storage-provider-and-recovery.md` v0.1。
- 新增实现330行（runtime40、protocol262、adapter28）；primitives +2/-2。新增测试/fixture/原生验证harness共478行（含manifest10行）。与开工500～800/450～850估计相比，实现更薄；未建设正式业务入口、有界块树或产品面板。文档和原始TAP/JSON不计入代码量。

### 真实执行、结果与证据

| 项 | 实际结果 |
| --- | --- |
| `node --test --test-reporter=tap packages/storage/tests/storage.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js` | **131/131通过**：原契约48+探针18+存储65；0失败/跳过。`evals/t03/node-tests.tap` |
| contracts/storage 的mjs/js逐文件 `node --check` +原探针 | 21文件通过；PowerShell隔离脚本实际Start/Crash执行成功 |
| `git diff --check` | 通过；最终代码/证据哈希与部署fixture请求一致性保存在 `evals/t03/verification.json` |
| P0 `collector.mjs p0 20260919a` | 实际api.db方法、full配置、复杂中文JSON、精确ID、close/reopen与UUID/SHA/JCS对照通过；无embedding调用 |
| 初始发布失败 | a/b两次失败保留；b明确报物理NodeId0内部保留。修正adapter为逻辑槽n→物理n+1，用新c/d namespace重跑，未覆盖失败库 |
| `before 20260919c` → Crash before → `recover-before` | 材料flush后、root发布前强杀；重开保留旧view `mv_…014`，同operation重试后为`mv_…023`；原Head/子线不变，ledger=3 |
| `after 20260919c` → Crash after → `recover-after` | root发布flush后、确认前强杀；重开已是`mv_…023`，重复操作返回原结果，ledger仍3 |
| `roundtrip 20260919c`及最终修正后`roundtrip 20260919d` | 两故事/三分支、编辑/纠错/绑定、小型逻辑包→新库恢复、幂等、同键异请求/R5拒绝、多handle共享owner、取消等待不释放写权、陈旧竞争拒绝、关闭句柄失效、中断导入不激活均通过 |
| 最终d额外项 | 导出后继续提交不修改旧包；`exportSnapshotFixed=true`。2026-09-20 `reopen-check 20260919d` 再次打开已有restored库，状态及5条幂等账本通过 |

原生原始结果/进程证明位于 `evals/t03/native/*.json`。固定seed=20260919。Node故障矩阵为4类增量（fork/选择、纠错、正文edit、binding）×12个断点，TAP诊断保存operation、前后Head/view/binding、确认状态和恢复校验；底层已写但返回失败与写前失败分别注入。原生强杀覆盖的是纠错事务的发布两侧，不宣称所有48个断点均在TT强杀。

### 契约、偏差和未验证项

- v2/schema_version=1保持；额外恢复包 `mnemosyne-storage-p2-v1` 独立版本化。恢复同时校验logical、journal、ledger与重建标记；不删除corrections/checkpoint来修复矛盾，不修改领域UUID，不调用LLM重建。
- 内部编译事务要求保留原请求和生成的ID；重试先查账本后查expected。尚无正式业务命令durable intent/ID预留入口，不能丢失请求后重新生成ID冒充同一重试；外部维护/同步导致native句柄换代尚无自动接线。G1必须审查这些生产化条件。
- 明确小样本限制：256记录、32消息/快照、16选择/视图、状态/请求各256KiB、64提交。内存仍物化全库，单command.entries/view/expected/markers尚未分块；S05未通过，不把现原型称手机生产存储。P1已说明无损引用方向，P3未实施。
- S01～S03有本增量原生证据；S04仅小fixture父子/纠错及R5原生回读，完整R1～R5/derived-only组合主要为Node回归，未宣称全量TT组合矩阵完成。S06/S07只小包，完整一致流式备份/文本解析硬化待P3。S08仅owner生命周期门禁，真实索引重建/宿主同步替换未测；S09/手机/性能均pending。S10本增量文档回报已补齐，整任务未验收。
- 模拟ENOSPC不等于真实磁盘满；未做硬件断电、OS崩溃、真实IO故障或生产迁移。flush/强杀结果仅限本安装版、此故障点/fixture；不承诺断电零损失。

### 测试库、回退与G1待决定事项

独立库目录为上述data root下 `_tauritavern/databases/`。实际namespace完整清单：

- `mnemo-t03-20260919a-capability`、`mnemo-t03-20260919a-crash-before`、`mnemo-t03-20260919b-crash-before`；后两者是失败试验。
- `mnemo-t03-20260919c-crash-before`、`mnemo-t03-20260919c-crash-after`、`mnemo-t03-20260919c-roundtrip`、`mnemo-t03-20260919c-restored`、`mnemo-t03-20260919c-race`、`mnemo-t03-20260919c-interrupted-import`。
- `mnemo-t03-20260919d-roundtrip`、`mnemo-t03-20260919d-restored`、`mnemo-t03-20260919d-race`、`mnemo-t03-20260919d-interrupted-import`。

不自动删除上述库/孤儿/隔离副本。回退只停用harness并撤本轮代码，保留测试库/证据；不需要生产格式迁移，不覆盖现用存档。隔离TT因用户要求已重开，数据库handle在验证后关闭，collector已退出。

**请求 Chat 在 G1 审查 B1 原语、发布协议、临时恢复格式、durable intent及外部维护协调缺口，再决定是否放行 P3；不把本回报当成放行。** 下一增量仍是本任务P3，有界清单/command/视图/目录和完整恢复，工作量需按review后的设计重新估计；当前粗估实现600～1000、测试500～900行，非批准/配额。不创建新任务卡，不自行选择B2/A。

## G1-R1/R2 返修检查点（2026-09-20，用户要求更新档案后暂停）

本节是当前状态；上节保留首轮实施记录。基线 `26f41713a6fd178162c2b633f419bbc67f526726` / main，已拉取评审5a47aa0及阶段导读26f4171。已读 `notes/t-03-g1-review.md`、README、S-A、本task、06 v0.3与09 v0.1。Windows / Node v24.19.0；本轮检查时没有TT进程，未启动副本或创建新namespace。原 `.codex/`、旧测试库与旧原生证据未修改。

### 已实施，尚待原生验证与Chat复核

- **R1**：成功close把owner永久终止，旧owner.recover/commit返回OWNER_CLOSED；重复close是无原生副作用的幂等操作。关闭失败进入recovery-required，registry保留同一owner；recover在其原队列内重新open原生namespace，再执行既有恢复流程，覆盖关闭前失败及已关闭但回执丢失两种情况。
- registry仅在关闭成功且仍属于本次opening时释放；open遇到正在关闭的owner先等待其队列，随后重新核对登记；所有适配层IO校验当前登记归属，旧对象不能关闭或删除替代owner的资源。
- **R2**：只有native.get明确返回null才解释为记录不存在。节点存在但payload为null、缺失、数组或非法值则NEEDS_RESOLUTION。root要求显式format/kind/staging/tip；tip只能为null或正安全整数，缺字段/非法类型拒绝，owner不进入ready，不清空材料。
- 合法空库、显式null tip、暂存库及首次发布前遗留孤儿路径保留。持久格式、root发布/两次flush/确认顺序未改；关闭生命周期语义按review要求收紧，不需要生产迁移。

实现改动：protocol +19/-6、adapter +31/-7，共+50/-13；新增定向测试134行，旧测试+5/-2。开工估计实现70～120、测试200～300行，实际修复更小。旧测试两处“同owner关闭后recover”改为先断言OWNER_CLOSED，再新建owner回读原状态与账本；其余旧断言保留，不把丢提交行为改成合法。

### 实际验证与证据

- 改实现前运行首批18项新增定向测试：10通过、8失败，包含旧owner恢复、关闭失败、close/open竞争、缺tip及null/missing payload；原始输出 `evals/t03/g1-repair/before.tap`。随后另补1项失败close重试测试，未把它混计入这批旧版红灯。
- 修复后执行 `node --test --test-reporter=tap packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js`：**150/150通过，0失败/跳过**，即原131+新增19；见 `evals/t03/g1-repair/after.tap`。
- 新增测试的native mock按namespace查当前打开实例，旧native方法可访问重开后的库，避免用天然失效的mock掩盖R1。两条合法竞争请求只有一条确认，重开保留已确认账本、子线和第二故事；异常读取测试核对底层材料未改变。
- **本轮小型隔离TT验证、最终逐文件语法/diff检查、最终部署/源码哈希清单尚pending。** 旧131项/原生强杀结果仅作历史记录，不能替代这次返修验证。没有重做强杀矩阵，没有调用付费API。

### 暂停与恢复入口

用户在Node回归完成后要求“更新完档案停一下”，因此到此暂停。代码和文档在未提交工作树；未commit/push。两项仍待验证与Chat复核，不宣布G1通过或T-03完成。

用户恢复后：先检查工作树，再给已有独立副本部署修复代码，仅用新namespace做close→reopen→旧owner拒绝，以及缺tip/null payload拒绝的小型原生验证；补最终语法/diff及独立哈希清单，更新本回报后再次停G1。发布协议无实质变化，不默认重做全部强杀矩阵。不进入P3、不创建新任务卡。

回退只撤本轮三处实现/测试改动和新增定向测试，保留旧库及本轮TAP；撤回修复会重新暴露已知R1/R2，不能称为可用生产版本。本轮无持久数据迁移。无新的产品资料缺失，当前未完成项来自用户暂停要求。

## G1-R1/R2 返修继续验证（2026-09-19）

本节接续上面的暂停记录。用户恢复后继续使用 Windows / Node `v24.19.0`、隔离 TT Canary `dev (367b0c7e9410)`（SHA256 `11a9bc110da5dc634ff8c0b7b8fe244110c360af46693e50de67968cb811f2c4`），只写入新 namespace；现用 TT、真实 RP、手机和付费 API 未操作。隔离副本完成后已退出，collector 已停止。

### 实际返修与验证

- R1/R2 实现保持上节所述：成功 close 永久终止 owner；失败 close 保留唯一 registry/队列并可在原 owner 内 reopen；旧 owner 的 recover、handle 和 native IO 均受生命周期门禁。恢复只把明确的 native `null` 解释为缺记录，完整校验 root 和既有节点 payload，损坏信息返回 `NEEDS_RESOLUTION`。
- 新增 `g1-repair` native 阶段，真实运行证据为 `evals/t03/g1-repair/native-20260919g1.json`：`mnemo-t03-20260919g1-lifecycle` 中旧 owner 的 recover/read/IO 分别为 `OWNER_CLOSED`/`STALE_HANDLE`/`OWNER_CLOSED`，替代 owner 重开后保留 2 条确认账本；缺 `tip` 的 root 与现有 `payload:null` 节点均返回 `NEEDS_RESOLUTION`，两类 namespace 的物理节点数均为 20→20，材料未被清空或替换。
- 最终 Node 命令：`node --test --test-reporter=tap packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js`，**150/150 通过，0 失败、0取消、0跳过**；完整输出 `evals/t03/g1-repair/after-final.tap`。23 个 contracts/storage/probe 的 `.mjs/.js` 文件 `node --check` 全通过，结果在 `syntax-final.json`；`git diff --check` 通过。
- 修复源文件与隔离 harness 的 SHA-256 对照、native 证据哈希见 `evals/t03/g1-repair/repair-hashes.json`。本轮实际新增 native 阶段约 68 行、定向测试 134 行；R1/R2 实现净变更仍为 protocol `+19/-6`、adapter `+31/-7`，旧测试 `+5/-2`。未改持久格式、root 发布顺序或逻辑包 v2。

### 关卡结论与边界

R1/R2 的实现和本轮隔离验证已完成，证据已回写；**G1 仍停在 Chat review，未自行宣布放行**。本轮没有重做整套强杀矩阵，因为发布协议没有实质变化；没有进入 P3，没有创建任务卡，也没有把 T-03 标为完成。B1 仍未获生产选型批准；durable intent/ID 预留、外部维护协调、有界清单与完整流式恢复仍是 Chat 决定后才能进入的后续条件。

本轮新 namespace：`mnemo-t03-20260919g1-lifecycle`、`mnemo-t03-20260919g1-malformed-root`、`mnemo-t03-20260919g1-null-payload`。均保留在隔离 data root，不自动清理。

## P3 前置增量与维护阻塞（2026-09-20 Codex 回报）

**当前状态：G1已通过；P3部分实施，前置诊断增量implemented_unverified，自动外部维护路径受阻。P3有界存储/完整恢复尚未实施，P4/P5未开工，T-03继续in_progress。** 这不是P3完成回报。高难项交接：`notes/t-03-p3-handoff.md`。

### 基线、范围和实际修改

- `git pull --ff-only origin main`：48663c4快进至 `bd1f0e42bb74ee237ca2633e7be8f5da4d873021`；main；原未跟踪`.codex/`保留。当前增量按用户授权提交并推送，供 Chat 线上 review。
- 已读README、AGENTS、S-A、原task、G1最终review尤其第5节、T-02最终review、06 v0.3、08、03/07相关决策、baseline与T-02A最终回报、contracts/storage及测试。09原版本v0.3随本轮更新v0.4。无缺失产品输入，不索要真实数据。
- Windows / Node v24.19.0 / Git 2.55.0.windows.3；TT沿用隔离Canary367b0c7e9410，exe SHA256 `11a9bc110da5dc634ff8c0b7b8fe244110c360af46693e50de67968cb811f2c4`。独立根仍为 `D:\Mnemosyne\.t03-local\tt-367b0c7`，portable data与WebView profile不变。
- 新增实现332行（intent-prototype274、intent-tt-adapter58）；旧adapter +1/-1只将P3前缀隔离出旧入口。新增测试/原生harness360行（223+66+71），suite分派+1，collector +1/-1。原测试和contracts/protocol零改动；文档/TAP/JSON不计代码量。
- 原估计实现1200～1800、测试900～1400是完整P3范围。实际因固定宿主维护原语缺口在前置阶段停下，不能把行数下降解释成P3已完成。无新依赖、服务安装、第三方实现复制或技术栈切换。

### 完成的有限前置与协议影响

新增独立版本化 `mnemosyne-storage-intents-v1`，原输入、已编译请求和生成ID先持久准备，再按operation执行；重开枚举prepared/published并精确去重，覆盖历史、记忆选择/纠错及binding。未flush准备不承诺可找回。纯编译过程不执行任何外部副作用；停止等待不会释放写队列。

正常诊断读写经唯一协调入口；合作式suspend排空/换代，resume核对库身份/root/准备链票据。错误不会把同名namespace默认为原库。所有P2硬上限继续保留，仍使用全库参考模型和审计，不能视为有界生产请求入口。

标准v2/schema_version=1不变；异类去重记录不进入历史command表。旧P2测试库不迁移、不覆盖；新格式没有完整导出/导入能力，旧bundle会缺intent材料，禁止用其宣称新库完整备份。新格式及合作式维护方案仅交review，不静默扩大accepted范围。

### 真实命令与结果

| 验证 | 实际结果/证据 |
| --- | --- |
| `node --test --test-reporter=tap packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js` | **211/211通过**，原150+新增61；0失败/取消/跳过。`evals/t03/p3-prerequisites/node-tests.tap` |
| contracts/storage/probe全部`.mjs/.js`逐一`node --check` | **28/28通过**；`syntax.json` |
| `git diff --check`及新增源码尾随空白检查 | 通过；`verification.json`记录命令、基线、源码/部署哈希与证据哈希 |
| `node packages/storage/native/collector.mjs p3-intent 20260920p3a` / `... 20260920p3b`，分别启动独立TT副本 | 两次done；最终b使用最终实现。原输入/生成IDclose→reopen恢复、历史/记忆已发布去重、旧handle STALE_HANDLE、身份变化LIBRARY_CHANGED通过；`native-20260920p3a.json`、`native-20260920p3b.json` |
| 旧原生handle反例 | 同名库close/reopen后旧handle仍可写，两个新合成namespace复现；这是原语缺口证据，不是维护安全通过 |

Node矩阵覆盖三类操作的准备/发布前后IO失败和丢确认；另有记忆纠错、取消等待、合作式维护排空、准备竞争、未知读错误、关闭失败、registry竞争和校验值正确但输入/生成ID/编译记录矛盾。使用fixture(2)的固定业务输入，新增生成ID由实际UUID生成器产生并持久保存；不依赖重试时生成相同随机值。

原生新namespace仅：`mnemo-t03-p3-20260920p3a-intent`、`mnemo-t03-p3-20260920p3a-fence`、`mnemo-t03-p3-20260920p3b-intent`、`mnemo-t03-p3-20260920p3b-fence`。未删除旧或新测试库，未碰现用安装/真实RP/手机/付费API。

原生测试全部关闭数据库句柄后collector退出。副本PID16380正常关闭窗口后进程残留；PID14360的隐藏窗口自动化返回不支持接口。精确核验唯一进程路径、PID、二进制SHA和本轮done证据后结束这两个隔离进程，分别记录`isolated-exit*.json`；**这些退出清理不是发布断点/强杀恢复实验**。没有把旧P2强杀结果充作新intent格式验证。

### 外部维护阻塞、尚缺验收与下一步依赖

固定TT的公开bridge只发送namespace，没有expected generation/跨调用租约；维护锁只覆盖单个后端调用。源码blob及真实旧handle反例见高难交接。JS写前核对库身份与后续upsert之间仍可被维护换代，无法声称排空/隔离所有宿主自动维护下的旧写。

按G1第5节及AGENTS，停止该受影响路径并带证据回审；未编造维护事件、未切换B2/A或修改宿主。自动维护门禁明确HOST_MAINTENANCE_UNSUPPORTED。需Chat/用户决定宿主原生fencing/可等待维护前门禁的最小补充，或明确受限诊断运行边界；建议不是已批准设计。

S05、完整S06/S07和维护S08仍pending：manifest/command.entries/views/corrections/expected/markers/journal/目录有界化、恢复检查点、全量枚举和稳定流式导出/导入、重复JSON key/Unicode/资源限制均未交付。新辅助格式真实进程强杀/断电/磁盘满、真实sync/archive、手机未验证。保留原R1～R5语义和全部回归不等于已做完整生产存储。

回退只停用本轮harness/入口并撤本轮代码，保留全部物理测试库和证据。新库不得直接用旧adapter写；后续需要数据回退时先实现完整辅助格式导出，不丢准备记录。下一步仍在原T-03内；未创建新任务卡，未进入P4/P5，未宣告P3或整个T-03完成。

## P3 受控隔离继续增量（2026-09-20 Codex 回报）

**当前增量implemented_unverified；P3与T-03仍未完成。** 有界结构已实现基元，现有intent格式的完整业务恢复材料已有导出/恢复；普通领域编译、分页发布/checkpoint和规模化流式恢复尚未接通，S05不能标为通过。自动外部维护继续`HOST_MAINTENANCE_UNSUPPORTED`；不进入P4/P5，不新建任务卡。

### 基线、开工与范围

- `git pull --ff-only origin main`由15b8605快进到`ea1eca4d81f855f8ef92cf1439ea412b94fdb365`；main；原未跟踪`.codex/`未改动/不提交。首次沙箱不能写FETCH_HEAD，按工具权限升级后完成。
- 已读用户指定`notes/t-03-p3-maintenance-review.md`、README、AGENTS、S-A、本task、G1第5节、06 v0.3、08、T-02最终回执及相关contracts/storage实现/测试；09从v0.4更新v0.5。最新专项回审允许隔离工程继续，c90d77d不作为句柄修复或已安装证据。
- 环境：Windows x64 / Node v24.19.0；固定隔离TT `367b0c7e9410e8fcf394f668302d70073e5a3ce5`，exe SHA256 `11a9bc110da5dc634ff8c0b7b8fe244110c360af46693e50de67968cb811f2c4`。data root仍为`D:\Mnemosyne\.t03-local\tt-367b0c7\data`，独立WebView profile。没有其他TT进程；每次启动/强杀/退出均按精确路径、哈希及本轮证据核对。
- 开工粗估实现1200～1800、测试/harness900～1400行为完整P3预估。此次可验收增量实际实现**+560/-9**，新增测试**317行**，native harness/控制脚本**+135/-6**；明细见verification.json。差额包含尚未完成的业务编译/分页发布集成，不能解释为全部P3缩小后已完成。原211项测试与contracts/protocol未修改，无新增依赖/服务。

### 实际改动及数据影响

1. `pages.mjs`：不可变8KiB页、精确AVL目录、计数序列树，局部append/edit/insert/delete/fork路径共享、重开按ID/游标读取、全量结构审计；缓存128页。物理候选hash地址碰撞拒绝覆盖，不代替领域UUID。
2. `paged-json.mjs`：同一基元覆盖正文/manifest/command.entries/views/corrections/expected/markers/目录等JSON形状，局部`at/set/splice`不扫描无关子树。显式`write/read`是全量转换/审计；这些基元未替换现有普通业务编译与P2发布协议。
3. `strict-json.mjs`、`intent-recovery.mjs`：独立传输格式`mnemosyne-intent-recovery-v1`，固定导出边界，逐记录UTF-8流与完整checksum链；保存标准v2全部逻辑对象及journal/ledger/markers/intents，包括prepared请求和生成ID。拒绝重复key、非法Unicode/UTF-8、截断/尾随、未知格式及资源超限。
4. 协调入口增加export；adapter增加空目标restore。先全量验证输入/R1～R5/持久ID重编译，staging后写入，重新回读持久材料审计，再单点激活并flush。激活前故障保持不可读，激活丢确认从持久状态判定。没有覆盖源库或自动清理暂存库。
5. 恢复库使用`mnemosyne-storage-restored-intents-v1`身份格式及新物理library ID；原领域ID/请求/结果保持。物理身份与激活标记为新恢复重建，不声称物理文件逐字克隆。旧15b8605读者实际执行后拒绝新格式，防止其忽略新增staging标记而提前开放库；Node证据见legacy-reader-check.json。旧v1源库兼容新读者，不做就地迁移。
6. 所有上限仍明确：传输单记录1MiB/总32MiB/4096记录/深度64；v1领域编译保留P2硬上限。流式传输不等于规模化领域审计，当前审计仍会物化小库。未修改06、领域指纹或记忆语义。

### 真实验证

| 命令/验证 | 结果与证据 |
| --- | --- |
| `node --test --test-reporter=tap packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js` | **275/275通过**，原211+新增64，0失败/取消/跳过；`evals/t03/p3-structures-recovery/node-tests.tap` |
| 全部contracts/storage/probe `.mjs/.js`执行`node --check` | **36/36通过**；syntax.json |
| `git diff --check`、新文件尾随空白、PowerShell脚本语法 | 最终检查与记录见verification.json和powershell-syntax.json |
| `node packages/storage/native/collector.mjs p3-recovery 20260920p3e` | 完整业务恢复材料往返、prepared ID保持、恢复后重试通过；分页旧根/局部新根原生重开通过。340节点，实测最大物理ID281377777316372；同目录原生JSON |
| `p3-before`→`isolated-tt.ps1 -Action Crash -Phase p3-before -Run 20260920p3e`→`recover-p3-before` | 请求材料已flush、publish前精确强杀PID13940；重开为prepared，生成ID/result与独立kill-ready一致，发布后共2条历史operation，无重复 |
| `p3-after`→`isolated-tt.ps1 -Action Crash -Phase p3-after -Run 20260920p3e`→`recover-p3-after` | publish已flush、ack前精确强杀PID4640；重开为published，直接返回原result，共2条历史operation，无重复 |
| 实际旧15b8605协调器源码在Node FakeIO读取新恢复库 | `NEEDS_RESOLUTION`，目标不变；非旧TT真机运行。旧代码blob `5dbbfa282a6dcd323a143a9d90f039a2a5dd06bc` |

新增结构测试使用2048键、1024引用清单、400次seed=73013随机splice、4096次追加；故障覆盖physical collision、缺页/checksum、合法checksum的计数/排序矛盾、页写丢确认、完整恢复各阶段EIO/ENOSPC模拟。首次随机splice发现叶块合并导致AVL高度失衡，修复后全部通过；不把这些算法断言当作1x容量或手机性能结果。

恢复测试还验证删除后原文、旧快照、父子固定历史、第二故事、未选旧记忆/纠错、binding、全部账本和pending；合法checksum的R5/生成ID/ledger/marker矛盾拒绝。原T-02/G1/前置全部回归保留。真实强杀仅验证此固定TT/新intent格式/小合成数据的两个断点，不证明分页业务发布（尚未实现）或硬件断电。

原生最终namespace：`mnemo-t03-p3-20260920p3e-{source,restored,pages,crash-before,crash-after}`。前期c/d组保留在`preliminary/`与隔离库中；d的crash-before停在已记录发布前状态，未混称最终恢复通过。完成后退出脚本核对done/精确PID后清理残留测试进程，记录为**完成后的退出清理，不是故障证据**；最终无TT进程，collector已结束。所有测试库均保留。

### 剩余工作、回退和交接

本增量没有把有界基元接到普通领域编译/prepare/commit；仍有全库structuredClone、全视图/expected/markers和重开完整重放。分页发布/checkpoint/UUID索引、规模化流式领域审计与完整S05/S06/S07还需在原P3内继续。不能仅凭硬上限或基元测试宣称有界业务存储完成。

自动维护/真正sync/archive/硬件断电/真实磁盘满/手机未验证；c90d77d未安装实测；不修改TT、不切B2/A、不接受新受限生产模式。本次没有新增产品信息缺失或要求重复授权，剩余隔离工程仍在原许可内。

回退保留旧v1源库、新恢复库、所有测试库与完整包。旧代码拒绝恢复目标，不修改身份绕过；需要读取新库时保留本轮读者。分页实验与业务库分开，未迁移真实档案。已更新高难项交接、阶段导读、README、协议v0.5和CHANGELOG；按用户持久要求提交push供Chat review。状态只到当前增量implemented_unverified，不宣布P3/T-03完成。

## P3 端到端分页受控集成（2026-09-20 Codex 回报）

**本轮完成原交接第5节的三项集成，状态implemented_unverified，供高难项review。** 自动外部维护门禁仍阻塞该路径及生产准入；整个P3未获验收，T-03保持in_progress，P4/P5未开工，无新任务卡。

### 基线、范围、实现量

- `git pull --ff-only origin main`由4caa326快进至`2f11c5b`，main；拉取首次被FETCH_HEAD沙箱权限拦截，按工具升级权限后成功。原`.codex/`保留且不提交。
- 已读README、AGENTS、S-A、本task、G1第5节、维护专项review、P3交接第5节、06 v0.3、08、03相关决策及全部涉及的原型/契约实现。存储协议由v0.5更新v0.6；逻辑包v2/schema_version=1和指纹算法未更改。
- 本轮预估实现1500～2300、测试/harness900～1400行；实际实现**+1047/-0**，测试**+818/-0**，harness/控制脚本**+287/-6**。详见`evals/t03/p3-integration/code-lines.json`。不以缩短行数替代验收；无新增依赖、服务或第三方源码。
- 按用户中途要求收回子代理产出，后续由主代理单线完成修复、扩展反例、完整回归、原生操作和交接；模型策略已写入AGENTS。子代理结论只作已有产出复用，最终结果以本轮实际执行证据为准。

### 三项集成与格式影响

1. 新增paged-domain/history/memory，将历史局部变化、共享manifest/command.entries、记忆selections/corrections、binding及UUID目录接入分页结构。用原schema/derivedFingerprint和oracle作对照；需要检查的依赖按范围遍历，不先复制全state。`history-delta`是独立请求简写；显式逻辑读取仍还原标准command及原v2指纹。
2. 新增PagedCoordinator与隔离TT adapter：先持久准备原请求/生成ID/结果/候选，后单点发布domain、账本、journal、markers和checkpoint。正常重开不重放旧操作；原请求索引、pending和幂等结果可恢复。owner代次/关闭/合作维护保留，异常结果显式recover。测试发现纯领域拒绝误锁owner，已修复并加入回归；被拒绝候选不改变旧确认状态。
3. 新增精确页目录和完整NDJSON恢复：固定边界、逐页读取、严格UTF-8/重复key/资源控制，空库staging；先确认持久引用完整，再用原生成ID重编译审计全部journal/domain/结果和pending，成功才激活。正常恢复不重造ID、不覆盖源库。分页格式独立于旧P2/intent，新库拒绝旧读者。

恢复标记为一致Head/view上的`index=behind,rebuild=evaluate`，保留全部计算材料，不伪称模型或索引任务已执行，也不把所有旧记忆全局判失效。单对象/请求预算、图深度、缓存和传输上限均见09第10节；完整v2物化只限显式小包路径。目录中间页和孤儿无自动GC，物理放大另列风险。

### 实际环境、命令与结果

Windows x64 / Node v24.19.0。隔离TT仍为`367b0c7e9410e8fcf394f668302d70073e5a3ce5`，exe SHA256 `11a9bc110da5dc634ff8c0b7b8fe244110c360af46693e50de67968cb811f2c4`，独立`D:\Mnemosyne\.t03-local\tt-367b0c7\data`及WebView profile。c90d77d未安装实测，不作为句柄隔离修复证据。

| 验证 | 实际结果/证据 |
| --- | --- |
| `node --test --test-reporter=tap packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js` | **314/314通过，0失败/取消/跳过**；原275项保留。`node-tests.tap` |
| 全部contracts/storage/probe `.mjs/.js`逐一`node --check` | **52/52通过**，syntax.json；两份PowerShell控制脚本AST无错误 |
| 增长正确性 `node --max-old-space-size=1536 packages/storage/native/paged-growth.mjs` | 66确认操作、132消息、1,081,344合成字符及1个pending；39,378,227字节/60,290记录包；全部采样历史/确认结果/pending保留，growth.json |
| 最终读者复用原增长包 `node --max-old-space-size=1536 packages/storage/native/paged-growth-reopen.mjs` | 通过；最终冷开99次读取，66项确认操作与原pending ID/结果保留；包hash见growth-final-reader.json；不重复生成原66次历史 |
| `collector.mjs paged-roundtrip 20260920pageda` | 真实TT完整逻辑往返、history-delta、memory、binding及pending ID恢复/重试通过 |
| `paged-before`→精确Crash→`recover-paged-before`，run20260920pagedb | paged-publish前强杀PID12200；重开prepared，原ID/结果匹配，提交后2条历史operation，无重复 |
| `paged-after`→精确Crash→`recover-paged-after`，同run | paged-ack前强杀PID4932；重开published，返回原结果，2条历史operation，无重复 |
| `paged-reopen-check 20260920pageda` | 最终读者重新检查先前真实TT源/恢复库，目录checkpoint、原pending ID和已确认结果通过 |

原生证据及进程证明在`evals/t03/p3-integration/native/`。首次往返之后仅补强普通冷开的目录校验；首次与最终部署哈希分别保存，不混称同一代码运行。最终断点组与reopen-check使用最终读者。PowerShell进程证明可能把ISO时间字符串序列化为等价日期表示，原始请求逐字材料以Node collector原JSON为准。

新增模型反例涵盖local append/edit/insert/delete/reorder/restore、no-op import、固定fork、current依赖环、checkpoint/advance/correct、derived-only及cutoff；准备/发布两侧、丢确认、空目标恢复各激活阶段ENOSPC、缺页和合法checksum的R5/候选矛盾。检查点回读与局部操作读取量实测，不以独立树基元通过代替业务路径。

### 资源、未验证项与回退

增长测试的fixture IO同时持有完整源/目标物理Map，最终RSS约1.24GB；源物理节点681,821、恢复目标148,572，空间放大明显。该数字不是正式provider缓存预算，也不是P4设备性能通过。后续应检查真实TT空间/延迟及无GC增长；本轮没有用自定阈值批准手机。测试范围超出P2的32清单/64提交限制，但不宣称无限规模。

自动外部维护仍`HOST_MAINTENANCE_UNSUPPORTED`；未真实触发sync/archive、未硬件断电/真实磁盘满/手机测试，未修改TT、未切B2/A。所有原生阶段只用既有独立实例和新合成namespace，完成后的退出清理单独记录，不充作故障证据；测试库及本地包全部保留。

回退保留旧库、新分页库、原请求和完整分页包，停用新入口并保留可读版本，不改root格式绕过旧读者拒绝。新namespace为`mnemo-t03-paged-20260920pageda-{source,restored}`及`mnemo-t03-paged-20260920pagedb-crash-{before,after}`，无真实档案迁移。

高难交接第7节、README、阶段导读、包说明、协议和CHANGELOG已同步。下一依赖是Chat对受控集成/格式/正确性证据的review及未解决的宿主维护能力；不擅自进入P4/P5或创建后续卡。按用户持久要求提交push，整个T-03不提前宣告完成。

## P3-R1/R2返修回报（2026-09-21 Codex）

依据`notes/t-03-p3-integration-review.md`继续原P3，main从75abeea快进到d3726c9。已读README、S-A、task、最新review、G1第5节、维护边界及相关契约/源码。仅`.codex/`为原有未跟踪目录，排除提交。没有缺失产品输入，无新任务卡、子代理、TT修改或P4/P5施工。

范围及代码量：统一`paged-domain/history`成员校验，修复`paged-memory`四处遍历及纠错解析，新增`memory-work`；新增一个独立回归文件。预估实现180～280、测试250～400行；实际实现+104/-45，测试+186/-0。原有测试文件无修改，协议09由v0.6更新v0.7；物理格式、逻辑包v2/schema_version=1、UUID和指纹不变。

### 实现与语义

- **R1**：当前members命中还须与order中同label的ref精确相等，查询/reorder/重复成员统一复用。惰性父索引保留，子线标签复用不恢复父线后缀成员资格。测试用oracle实际拒绝非法重排，并检查prepare拒绝后root、Head/view、账本、原确认结果不变；合法重排、显式采用父线旧原文、重复插入、普通重开与完整导出恢复覆盖。
- **R2**：每次编译/查询独立的active/done工作集，缓存标量结果及子图高度，覆盖checkPagedGraph/checkPagedMemory/fits/pagedMemoryStatus/target。档案验证与不同snapshot下的适用性分开计键；current/checkpoint、纠错传播、执行拒环、R5、分支和cutoff不变。缓存命中仍核对路径深度+子图高度。
- 总预算8192状态/131072工作单位，深度仍128；超限RESOURCE_LIMIT，不返回部分valid，prepare保留旧确认状态。无全库对象缓存，活动体持有的单对象/coverage仍受既有对象预算约束。上限是工程拒绝边界，不是自批设备性能。详见09第10.3节。

### 实际验证

Windows x64 / Node v24.19.0。证据目录`evals/t03/p3-review-repair/`：

| 命令/范围 | 结果 |
| --- | --- |
| 固定75abeea三份旧实现 + 当前定向测试，`node --test --test-reporter=tap --test-name-pattern="P3-R1\|selected shared DAG" .t03-local/p3-review-baseline/packages/storage/tests/p3-review.test.mjs` | 2/2按预期失败；非法重排未拒绝，4层图52次而非8次，before.tap |
| `node --test --test-reporter=tap packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js` | **319/319通过**，0失败/取消/跳过，241398.8ms，after.tap；本轮仅最终完整跑一次 |
| 5个新增/修改代码文件逐一`node --check`及`git diff --check` | 通过，syntax.json |

确定性计数：4/8/12/16层图分别8/16/24/32个不同节点、12/28/44/60条边，graph记忆读取8/16/24/32次。真实PagedDomain 32节点/60边：graph32、验证+fits114、status145次逻辑memory读取；未将这些数字报作物理IO或原生延迟。新增5项包含实际coordinator提交与完整恢复，覆盖共享DAG、原始依赖环、current执行环、纠错链环、checkpoint重定向执行环、合法历史checkpoint、分支/截止点/basis隔离和状态/工作/缓存深度预算。

### 限制、回退与下一依赖

本轮不重跑66操作增长或TT强杀：发布/持久格式/适配和故障断点未改，领域修复已由完整分页业务/恢复和原314回归检验；旧原生记录保留但不计为本轮执行。没有操作现有TT测试库、真实档案或手机，也没有自动GC。

旧库不就地改写。既存旧非法reorder或超过新增预算的请求会在完整恢复重编译审计时拒绝，源与staging材料保留，不修剪历史强行通过。普通checkpoint重开不追溯审计全部历史；回退保留原库/包和读者，不能把有已知漏洞的75abeea写入行为描述为安全替代。

自动维护仍HOST_MAINTENANCE_UNSUPPORTED，c90d77d不作已修复证据，不改TT、不切B2/A。此前空间放大、设备资源和手机边界仍未关闭。本轮状态implemented_unverified，高难交接第8节已更新，R1/R2是否关闭及P3是否放行待Chat再次review；T-03继续in_progress，P4/P5未进入。按要求commit/push供线上审查。

## P4索引/诊断增量与资源阻塞（2026-09-21 Codex）

依据 `notes/t-03-p3-repair-review.md` 从 main@`42c6624178eeb3e3826a4fee37c3fe1ad843e0f2` 进入原 P4 → P5。已读最新review、README、S-A、本task、G1与维护边界、P3交接、09协议及相关实现。开工估计实现450～750、测试/harness550～900行；P4检查点加P5收尾累计实现约323行、测试/harness约596行，另有104行操作文档及TAP/JSON证据。无新依赖、子代理、真实数据、付费模型、TT修改、手机操作或T-04。

### 已实现与回归

- 新增可重建小型索引 `mnemosyne-recall-index-v1`，索引失败/丢失不改变确认正文；返回候选前复核checkpoint、Story/Branch/view、selection、memory fingerprint与当前领域状态。人工向量分数不冒充rerank。
- 新增只读分页诊断与库存分类，报告版本/library/checkpoint/operation/pending、Head/view/marker、索引状态及业务页、当前可达/不可达页、活动/陈旧目录页。没有产品写入口或完整工作台。
- 新增同一固定合成工作负载的Node与隔离TT harness：32轮增长、4次深层编辑、1次删除、固定fork/子线追加、中文marker记忆；当前正文976,500字符，保留历史版本1,069,500字符。
- 完整命令 `node --test --test-reporter=tap packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js`：**322/322通过**，0失败/取消/跳过，即原319项全部保留，加3项索引/诊断/库存回归。证据 `evals/t03/p4-p5/node-tests.tap`。

### 资源结果与停止

固定停止条件为Node heap 1536MiB、RSS 1.4GiB、临时包512MiB、物理节点1,000,000、单场景30分钟、磁盘余量20GiB。自动维护继续 `HOST_MAINTENANCE_UNSUPPORTED`。

Node计量内存provider的1x完整通过：工作负载453.2秒、冷重开101.5ms、导出8.0秒、空库完整恢复262.9秒；峰值RSS833,236,992 bytes，备份20,915,028 bytes/32,350 records。源库333,608物理节点，其中活动checkpoint可达业务页14,596、当前不可达保留业务页17,752、活动目录32,348、陈旧目录/中间页268,911；恢复库77,692节点，陈旧目录/中间页12,995。该结果不是原生TT或手机验收。

首轮原生 `20260921p4a` 受用户报告的上游供应商/网络中断污染，不作算法结论。随后使用哈希一致的进度版扩展和新namespace执行 `20260921p4b`，固定TT `367b0c7e9410`、exe SHA256 `11a9bc110da5dc634ff8c0b7b8fe244110c360af46693e50de67968cb811f2c4`。宿主全程响应：4/32发布为401,846.6ms/15,769节点；8/32为1,078,023.6ms/40,651节点；第12次发布返回后超过1,800,000ms，停止器报 `P4 native elapsed-time safety stop`。停止前断言先于进度发送，未补造第12次节点数。data root增加60,445,275 bytes。

停止后只核验唯一固定路径/PID/二进制哈希并做退出清理；普通关闭5秒未退出才强制结束，明确不是崩溃恢复实验。所有库与证据保留。5x/10x未执行：原生1x已失败，Node 1x源节点按线性外推到5x亦超过100万节点停止线。

### 当前关卡、回退与review请求

这是最新放行规定的新增资源算法问题。P4的1x仍未完成冷重开、范围读取、索引、导出/恢复，S09未通过；不提高阈值、不缩小样本、不关闭full flush、不自动GC，也不将Node通过写成TT通过。

P5随后独立收尾：新增版本化只读诊断快照、结构化错误、空目标备份/恢复验证命令及`docs/10-t03-storage-operations.md`。Node命令完成1,006,060 bytes/1,622 records合成恢复；固定TT只读冷开`p4b`源库为ready、12条确认operation、pending为空、71,271节点，marker仍behind/evaluate，无写能力或sync/archive。P5状态为implemented_unverified，不再是未完成项。

完整证据与待审问题见 `notes/t-03-p4-resource-review.md` 和 `evals/t03/p4-p5/`。需要Chat先审查普通发布的目录构建/重复持久写放大及允许的最小算法修复范围；后续仍在T-03内，不创建/执行T-04。回退停用本轮索引/诊断/harness并保留旧库、P4库和证据；没有生产格式迁移或真实档案写入。因P4强制完成线未过，仍不交整个T-03最终review。

## P4-R1/R2与P5-R1返修（2026-09-21 Codex）

基线main@fc3264b，已读最新联合回审、README、S-A、本卡和相关协议/源码。开工估计核心实现/计量300～500行、测试/harness400～650行；实际统计随 `evals/t03/p4-repair/verification.json` 收尾记录。仅原有`.codex/`排除提交，单线执行，无新依赖或T-04。

先用真实coordinator补反例：首批4项旧实现全失败，修复后全通过。最终候选返回前复核source并传递behind；rebuild不把漂移包装为当前ready。exportSnapshot在同一队列边界固定诊断/流，目标核对checkpoint、分支和operation并审计；源端正常前进合法，目标新library合法，close失败不盖主错误。

先计量128条目录批次：Node 1x虽完整通过，仍有249,529目录落盘；据此在原批准范围内固定为1024条引用批次，候选工作集保持16,384页/16MiB硬上限。只增量重建必要不可变AVL路径，已登记引用缓存限512条且恢复重建；未省略物理碰撞检查，未原地覆盖或删除已落盘页，未改变业务control/账本/导出格式。

最终完整命令仍为 `node --test --test-reporter=tap packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js`，333/333、0失败/跳过（77101.2322ms）。原322项保留，新11项涵盖真实纠错/编辑/view交错、两处源写入交错、目标checkpoint负例、不同library正例、关闭错误、目录写前/后失败和AVL旧根/平衡。原候选测试只适配返回对象，排除规则断言保留。

旧源码fc3264b生成的小包→新恢复及新包→旧恢复均核对逻辑内容、checkpoint和幂等回执。固定TT最终配置run 20260921r3分别在paged-publish/before和paged-ack/before强杀，恢复为prepared/published，与独立边界generated IDs和结果相符，重复execute无额外发布。退出清理另列。r1的collector因沙箱EPERM无法保存证据，该run无效且库保留；r2为中间128批次证据。

最终Node/固定TT原1x和资源分项结果统一见 `notes/t-03-p4-repair-handoff.md` 与 `evals/t03/p4-repair/`。原heap/RSS、30分钟、100万节点、512MiB包、20GiB磁盘余量与full持久化保留。实现为implemented_unverified；Chat复核返修与资源完成线后决定验收状态，自动维护HOST_MAINTENANCE_UNSUPPORTED和手机pending不变。

最终Node 1x完整通过（workload97,266ms、恢复138,766ms、源187,816节点、峰值RSS617,533,440 bytes）。固定TT run 20260921r4最后上报20/32、1,348,946.4ms、74,952节点；下次检查触发原时间停止器，完整1x未完成。用户报告期间调整TT窗口、操作其他应用及窗口层级，未量化干扰，不将超时单独归因于算法。S09/T-03仍未完成；本次提交为返修回审，不冒充整个T-03最终验收。需Chat/用户决定受控重测安排，未追加重跑或5x/10x。

回退停用新索引/诊断入口，保留所有测试源库/暂存库与导出材料，旧分页包互读小样本已验证；无生产迁移、真实档案写入、TT改动、B2/A切换或GC。同步09协议v0.9、10操作说明及CHANGELOG；提交push供review，不创建/执行T-04。
