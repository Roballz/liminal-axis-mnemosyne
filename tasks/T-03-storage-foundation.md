# T-03：可迁移、可恢复的存储地基

状态：in_progress（P0～P2 小原型 implemented_unverified；停在 G1 待 Chat review，非整任务完成）

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
