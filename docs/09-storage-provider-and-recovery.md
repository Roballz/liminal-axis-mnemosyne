# T-03：存储发布与恢复协议及P3前置边界

版本：v0.9，2026-09-21。状态：按fc3264b回执返修P4-R1/R2与P5-R1，快照一致性和有界目录合并已实现；本轮证据见 `../notes/t-03-p4-repair-handoff.md`。第11节保留旧资源结果，第12节为本轮协议补充。自动维护门禁保留；T-03尚待review，B1未获手机/生产准入。

下文1～7节保留P0～P2协议与当时限制；其中“G1待审/未放行”是历史状态，当前许可按最终回执。第8节保留前置增量，P3最新协议与边界见第10节及 `../notes/t-03-p3-handoff.md`。
实施基线 `852260acd8d3e65d9d756af81cdf72e52c50046b`；继承 06 v0.3 / 对象 schema_version=1 / 逻辑包 format_version=2。本文没有更改领域语义。

## 1. 已观察的宿主原语

Windows TT Canary `dev (367b0c7e9410)` / TriviumDB API。独立便携副本、独立 data root/WebView profile；详见任务卡与 `evals/t03/native/`。

| 能力 | 结论与证据级别 |
| --- | --- |
| `api.db.open/upsert/get/flush/close` | observed；复杂 JSON、中文、emoji、换行正常回读及重开 |
| 无付费 embedding 保存正文 | observed；专用 dim=2 namespace，固定 `[1,0]` 只作物理承载，不执行向量召回或混入语义索引 |
| 物理 NodeId 0 | **observed unsupported**：报“节点 ID 0 为内部保留值”；公共类型中的非负整数不代表 0 可写 |
| 领域 ID → 物理 ID | observed；领域 UUID 不变；协议逻辑槽 n 映射 TT NodeId n+1，发布槽为物理 ID 1 |
| 完整读取本原型库 | observed；从发布槽读取 commit 链并精确 get；连续物理槽扫描用于恢复分配位置和孤儿去重，无 search topK |
| 通用跨调用事务/CAS | public API 未提供；本协议不假定存在 |
| `syncMode=full`、显式 flush | observed 配置及两处进程强杀恢复通过；WAL 语义为 source-only，未验证硬件断电 |
| `listNamespaces` | source-only：仅打开库，不当成全库目录 |
| 外部维护/同步后的旧 native handle | source-only：宿主 bridge 以 namespace 调用，不能据句柄对象推断代次；本原型只保证自身 owner 管理的 close/recover 代次 |

固定版本来源：[Database API](https://github.com/Darkatse/TauriTavern/blob/367b0c7e9410/docs/API/Database.md)、[db.js](https://github.com/Darkatse/TauriTavern/blob/367b0c7e9410/src/tauri/main/api/db.js)、[路径选择](https://github.com/Darkatse/TauriTavern/blob/367b0c7e9410/src-tauri/crates/tauritavern/src/infrastructure/paths.rs)、[单实例插件](https://github.com/Darkatse/TauriTavern/blob/367b0c7e9410/src-tauri/crates/tauritavern/src/app/host/plugins.rs)。这些已在本轮读取，不把其他提交的能力自动套到安装版。

## 2. 分层与小样本边界

- `packages/contracts/` 仍是领域校验/参考模型。只把同步 UUID/SHA-256 运行时从 Node 专属 import 改为可在 TT WebView 运行的实现；JCS、指纹用途/版本、所有已有测试不变。自编 SHA-256 已与 Node crypto、WebCrypto 的 UTF-8/填充边界对照；不是新增第三方依赖。
- `packages/storage/protocol.mjs` 接收由已验收领域函数编译的 transaction，生成每次变化对象、独立提交账本与重建材料；不导入 TT 内部模块。
- `tt-adapter.mjs` 仅调用公开 `api.db`，只允许 `mnemo-t03-*` 测试 namespace；每个 api 对象/namespace 共用 owner。没有正式 UI、聊天同步或索引检索入口。
- `native/` 是隔离测试 harness；`tests/` 是确定性故障注入器。fake 的 `flush/crash` 只表达假设，不能代替真实 TT 证据。

明确硬上限：状态 256 条记录、每快照 32 条消息、每视图 16 个选择、状态和单编译请求分别最多 262144 UTF-8 bytes、64 次提交、最多 8191 个非根物理逻辑槽。超限拒绝，不截断正文。范围不是手机性能预算或生产参数。

## 3. 数据与状态机

本增量私有恢复格式为 `mnemosyne-storage-p2-v1`，独立于逻辑包 v2：

| 项 | 内容 |
| --- | --- |
| 编译请求 | operation_id、预期所有当前 Head/view/binding_generation、变化记录、原结果；生成过的领域 ID 已包含其中 |
| 不可变 object 节点 | format/kind/checksum/value；变化记录按内容去重；请求的 changes 保存节点引用，避免再次内嵌同一批记录 |
| 不可变 commit 节点 | previous、请求指纹和引用、变化引用、result、重建标记引用 |
| 单一 root | format/kind/tip/staging；只保存固定大小发布指针，不包含无限增长目录 |
| 内存索引 | 领域状态、内容哈希→物理槽、operation→请求指纹/结果；均可由 root/commit/object 重建 |

普通提交依次为：

1. 在同 namespace 的串行队列内，先查 operation 账本。相同请求返回原结果；同键异请求拒绝；**之后**检查 expected Head/view/binding。
2. 应用变化到小样本参考状态，执行 validateState（含引用/归属/无环、R5）及不可变对象、绑定/分叉检查。编译请求是受信任内部接口，不能把任意 JSON patch 当成完整业务命令 API。
3. 保存变化对象、请求描述、当前分支重建计划及 `index=behind`，保存 commit；flush 材料。
4. 一次 upsert 更新 root.tip，随后 flush。Head、view/selections/corrections、binding、结果账本和失效材料由同一 commit 可达，不分别发布。
5. 发布 flush 成功后才切换 owner 的可读状态并返回确认。所有正常读者走同一个 owner 队列；原生低级 handle 不作为产品读入口。

逻辑发布点是 root 更新；对调用者的持久确认点是发布 flush 成功；读者可见点是 owner 完成发布。root 写入已发生但未确认时，结果只能是待恢复，不能断言失败/回滚。跨多个 API 调用的原子性来自协议，不宣称 TT 提供通用事务。

## 4. 不确定结果、协调与恢复

任何存储调用或故障钩子失败后，owner 进入 `recovery-required`，拒绝继续读写。保留底层错误作为 cause。超时/调用者取消等待不取消原生 promise，也不释放队列所有权；原生调用未 settle 时，后续提交与 close 仍等待。

恢复在队列清空后执行 flush/get，读取 root，精确回读对象和提交链，验证对象 checksum、请求指纹、operation/result 对应、逐次 expected 条件、完整领域状态及重建标记。只有全部一致才恢复 ready。无法读取/验证、断链或不明 IO 结果不当成空库，不删除纠错、不自动选新版。恢复/close 推进 owner 代次，旧包装 handle 拒绝。

G1-R1返修收紧生命周期：关闭成功后owner永久终止，recover/commit返回OWNER_CLOSED，重复close不再触及原生库。关闭失败保留唯一registry登记，进入recovery-required；恢复在原owner队列内重新open原生namespace，再执行既有flush/get校验。open等待正在关闭的队列并重查登记，只有成功关闭且登记仍属于本owner才释放；适配层每次IO验证登记归属，旧owner无法关闭替代owner的资源。初次open/recover失败尚未向调用方暴露owner时，可释放该失败的opening记录。

G1-R2返修明确读取边界：只有native.get返回null才表示不存在；现有节点null/missing/非法payload不能映射成空槽。root必须完整含format/kind/staging/tip；tip显式为null或正安全整数，否则NEEDS_RESOLUTION并保持待恢复。合法空库、显式null tip的初始/暂存状态、首次发布前孤儿仍可恢复，不猜选最新commit或清理材料。两项已由Node和隔离TT `20260919g1` 验证；原生结果见 `evals/t03/g1-repair/native-20260919g1.json`。

发布前材料是孤儿，不作为当前剧情；已存对象可按 checksum 复用，分配位置从实际连续槽恢复。此次测试重试保留同一编译请求与已生成 ID；**尚无正式业务命令入口的 durable intent/ID 预留机制**。若调用者丢失编译请求，不能重新随机生成一组 ID 并宣称是同一请求重试。这是 G1 必须审查的生产化前置条件。

多 handle 指本原型同一 JS 宿主/同一 api 对象里的协调入口；未实现跨 WebView、多个独立 api wrapper、外部扩展或设备并发写锁。外部宿主同步/归档替换前必须停止本 owner 并重新打开；自动维护事件接线未实现，不能在此前部署真实档案。

## 5. 小型备份与暂存导入

小型包包含：标准 logical v2、独立 ledger、rebuild/index 标记、编译请求 journal，以及外层 checksum。导入先检查两个 checksum、领域不变量，并从空状态重放 journal 对照 logical/ledger/markers；合法 checksum 不能替代 R5 或账本一致性。

导出在 owner 队列中取得固定副本；后续提交不修改旧包。导入只接受没有任何物理材料的新 namespace，先持久发布 `staging=true`，重放完成并逐项核对后才单点置为 false 并 flush。半成品重开保持 staging，不可作为活跃库读取；原库未覆盖。激活后丢确认时恢复可以发现完整新库，而不是清空它。

这不是全产品备份：只覆盖 T-02 已建模对象及本增量恢复材料；未提交孤儿不进入已提交逻辑包，仍保留在原物理库。没有模块/用户锁/通用任务模型、流式大备份、文本输入解析硬化或真实 B→A 迁移。

## 6. 故障保证与空间风险

| 故障模型 | 本轮范围 |
| --- | --- |
| 确定性 fake 断点 | object、commit、两次 flush、publish、ack 的 before/after，IO/ENOSPC、取消等待、竞争、导入中断；见 TAP |
| TT 进程异常终止 | 真实命中材料已 flush/发布前，以及发布已 flush/确认前；精确 PID 强杀后重开成功 |
| 真实磁盘满/底层设备 IO 失败 | 未执行；ENOSPC 是注入，不填满磁盘 |
| 硬件断电、OS 崩溃、介质损坏 | 未验证；不承诺物理断电零损失 |
| 手机后台/强杀 | pending，未操作手机 |

每次只写变化记录及本次账本，不重写整份 state 或全部 command 历史；root 固定大小。但本原型仍会在内存物化全库，单次 history command.entries、view、全体 expected、重建计划可能随样本增长，journal 导出也全内存。硬上限防止它被冒充生产实现，**S05 尚未通过**。

G1 若放行，P3 必须将 command.entries 用不可变清单引用无损恢复原请求、messages/revisions 用对象引用，views/expected/recovery 目录使用有界共享结构和可重建索引。不能只优化正文块而忽略账本放大；此处只提出协议兼容方向，未实施 P3 算法或冻结块参数。

## 7. G1 请求及回退

请 Chat 审查：B1 的已观察原语是否值得继续、发布/确认边界是否成立、编译请求保留/ID 预留与外部维护协调如何纳入 P3、上述临时包到 v2 的无损边界是否可接受。B1 生产选型及 P3 放行仍未决定；不自动切 B2/A。

回退只撤本轮源文件/运行时适配并停用隔离 harness；保留 `.t03-local` 的测试库和 `evals/t03` 证据。无需生产迁移，未改现用安装/档案/付费 API；不删除任何测试 namespace，不按前缀批量清理。若未来导入真实数据，必须另行完成迁移、导出和回退方案。

## 8. P3 持久请求与维护前置增量（2026-09-20）

新独立格式 `mnemosyne-storage-intents-v1` 仅在新 `mnemo-t03-p3-*` namespace 上诊断；请求、编译结果、生成ID序列先flush，随后才允许P2的领域发布。正常数据操作只有协调handle的prepare/execute/lookup/pending/read；原始IO/StoreOwner被封装。辅助记录不进入v2 history operations。

逻辑槽8193保存库身份，8194起最多64条准备记录；每条独立checksum和previous校验值。重开核对已提交journal与每条intent，使用持久ID序列重做纯编译审计，不生成随机ID，也不执行模型/业务副作用。输入和compiled指纹可从完整持久JSON原样计算。已持久准备无领域发布；已发布但未收到确认按ledger返回原结果。未flush准备没有持久承诺。

合作式suspend先换代并排空，捕获身份/root/intent边界，关闭后resume检查票据。不相同则LIBRARY_CHANGED。固定TT公开接口没有原生expected generation或扩展事务租约，单次维护读锁不能覆盖JS的身份检查和随后写入；真实原生反例见本轮evals。因此不支持自动宿主维护，相关路径以HOST_MAINTENANCE_UNSUPPORTED阻断。不能把合作式入口当成真实同步/归档事件接线。

仍保留P2全部状态/请求上限、完整oracle审计和串行单pending门禁；这不是S05有界生产路径。完整辅助格式备份/流式导入/文本解析尚未实现，旧P2导出包不能当作新库完整备份；迁移只准后续在新目标显式设计，不覆盖旧库。具体证据、原语缺口与下一步review问题见 `../notes/t-03-p3-handoff.md`。

## 9. P3 有界结构基元与v1完整恢复桥接（2026-09-20）

专项回审允许在既有受控隔离条件下继续。新增`pages.mjs`实现不可变内容寻址页、AVL目录和计数序列树；`paged-json.mjs`复用它们表示长正文/数组/嵌套map，`at/set/splice`只访问必要路径。最大页8192字节、叶16引用、键512规范JSON字节、缓存128页、深度64。候选物理槽取hash前48位+65536，完整hash验证，碰撞拒绝覆盖。固定TT实测的大整数精确回读见本轮原生证据；不把物理hash/槽当作领域UUID。

这些是可测基元，尚未连接现有业务编译/发布。`PagedJSON.write/read`仍是显式全量转换/审计，普通业务入口仍调用P2全库oracle并保留全部上限。因此本轮不将S05、规模化S06/S07标为已完成，下一步仍需局部领域编译、分页提交账本/索引/checkpoint以及流式领域审计。

`handle().export()`在协调队列中取得一致副本，返回UTF-8异步记录流。格式`mnemosyne-intent-recovery-v1`包含标准v2全部逻辑对象、journal、ledger、markers和全部intent（包括最后一个prepared请求/原输入/生成ID）；序号、前项hash和最终checksum共同校验完整性。v2及领域指纹不改变，记忆/绑定操作不塞入历史command表。

`openIntentTestStore(api, newNamespace, {restore: chunks})`只进入精确证明为空的新库。全部输入、R1～R5、生成ID重编译及账本审计通过后，先写逻辑槽8259的staging标记；准备链/P2数据落盘后重新回读审计，最后写active标记并flush。激活前故障不开放读写；激活丢确认可恢复原结果。原库不覆盖，不自动清理失败暂存库。

恢复目标采用新物理身份格式`mnemosyne-storage-restored-intents-v1`与新library ID，原领域ID/请求/结果不变。旧15b8605读者会因未知身份格式拒绝，不能绕过新增staging。新读者接受旧v1源库与新恢复库；新格式缺激活标记拒绝。旧库无就地迁移，回退保留读者与完整包，不修改身份来伪装降级。

文本入口拒绝重复key（含转义同名）、无效UTF-8/孤立代理项、非有限数、未知格式、截断/尾随记录和重复ID；限制单记录1MiB、整包32MiB、4096记录、每记录深度64/200000值。导出超限不生成完成尾记录。**这是有P2领域上限的完整v1恢复桥接，解码/领域审计仍会物化小库，不能称无限规模流式恢复。**

新增Node故障测试覆盖原文旧版本/删除保留、父子固定快照、第二故事、纠错、binding、pending、非法包及导入各断点；原211回归保留。原生最终组`20260920p3e`验证完整辅助材料往返、分页根重开、新intent发布前/后进程强杀，具体结果及哈希见`evals/t03/p3-structures-recovery/`。

自动外部维护仍固定`HOST_MAINTENANCE_UNSUPPORTED`，未升级c90d77d、未修改TT、未触发真实sync/archive、未验证硬件断电/真实磁盘满/手机。T-03继续in_progress；高难项交接和剩余工程工作见`notes/t-03-p3-handoff.md`。

## 10. P3 端到端分页集成（2026-09-20，待高难项 review）

本轮独立格式为 `mnemosyne-paged-storage-v1`，只进入新 `mnemo-t03-paged-*` 隔离 namespace。旧 P2/intent 入口、格式和回归保留，不就地升级旧库。普通业务入口为 `PagedCoordinator`，经过唯一 owner 队列处理历史、记忆和绑定；实现范围仍为 T-02 已建模对象。

### 10.1 业务编译与逻辑包的关系

历史使用计数序列树、UUID成员索引和有序标签索引。append/edit/insert/delete/fork 共享未变路径，固定 fork 只截取父快照前缀；标签不作为领域 ID。384 位标签的间隙不足明确返回 RESOURCE_LIMIT，不重排全库或更改身份。manifest 的新路径生成正式 hm UUID，旧 snapshot/块保留。完整 command.entries 以共享 JSON 序列引用保存，不在每轮重新生成整个数组。

P3-R1：fork的members可共享父线完整索引；成员查询、reorder及插入去重统一通过`indexMember`确认当前order中该label指向同一不可变ref。标签被子线复用不会使父线后缀成为子线成员。reorder只能重排当前成员；显式合法import仍可引用已归档的旧原文，不复制或静默裁剪父members。

`history-delta` 是存储请求的显式简写：payload 用 `splice:{start,delete_count,entries}` 替换完整 entries，其余字段仍按 command schema 校验；编译后保留可无损展开的原 v2 command。原 `history` 完整命令入口仍可用，扫描调用者提供的完整清单。不同输入形状的同 operation 请求属于不同原请求，不能静默互换重试。

原 v2 的 `payload_fingerprint` 算法和包校验不变。其 SHA-256 覆盖完整 command，不能声称局部编辑后可常数成本重算。因此分页 operation 保留 command 引用，在显式逻辑读取/导出时流式计算原指纹；普通增量的内部去重对**独立版本化原请求**求指纹，不冒充 v2 command 指纹。小型 `logical()` 继续输出可经原 validateState/importLogical 验证的 v2 包；限制4096对象、8MiB物化总量及单对象预算。规模化备份走下述分页格式。

记忆、coverage、current/checkpoint、纠错与R5使用既有schema/derivedFingerprint及异步分页引用检查，按键更新selections/corrections，不复制全库视图。需要检查的实际依赖图可遍历；算法以小样本oracle对照验证，原contracts仍是语义基准。绑定保持原generation/归属检查，不将记忆和绑定请求混入历史operations。

每个受影响分支保存 `{head,view,index:'behind',rebuild:'evaluate'}`。这是对该一致快照重新计算有效性/重建计划的持久材料，不表示全部旧记忆都失效或已执行重建；所有原文、输入关系、选择和纠错可达。当前阶段不执行模型、embedding或索引任务，不批准旧候选用于召回。

### 10.2 请求、发布与恢复检查点

逻辑槽0是唯一可变root，包含格式、独立library UUID、active/staging、checkpoint与精确页目录引用及checksum。不可变checkpoint包含domain、请求UUID索引、确认账本、journal序列、提交数和至多一个pending operation。expected由原请求和固定base domain引用表达，避免复制所有Head/view/binding。

准备：只编译纯领域变化并保存不可变候选、原输入、生成ID和结果；flush材料，再更新仍指向旧domain的pending检查点并flush，才确认prepare。执行：把候选domain、账本、journal和pending清空写进同一新检查点；flush材料，单点发布root，再flush后确认。丢确认或IO不确定会隔离owner；重开先查同operation，返回原生成ID/结果，不自动换新操作。纯编译拒绝只留下不可达候选，抛弃暂存目录，不锁死旧已确认状态。

正常重开只读root、精确目录路径、checkpoint及至多一个pending原请求，不重放全部历史。读取遇缺失/损坏会明确失败；显式audit和恢复激活前才全面检查所有保存材料。关闭成功永久终止owner；失败关闭保留登记并可recover；合作式suspend排空后持票据恢复。自动外部维护仍固定拒绝，检查root并不是宿主原子fencing。

### 10.3 完整分页恢复与资源边界

传输格式 `mnemosyne-page-directory-v1`：固定目录边界、header/page/footer、连续checksum链。目录逐键精确枚举全部保留的业务页、原请求、生成ID、候选、journal/账本和历史检查点；不使用search/topK，不在内存构造全局visited集合。传输保留相同内容的共享页一次，重新构建物理页目录；目录自身的历次中间节点不属于必须导出的领域材料。既有物理孤儿不自动GC。

导入先证明空目标并持久写staging，再分批解析/写不可变页和暂存目录。先验证每条页引用确实存在于目录及持久材料中，防止后续重编译悄悄补回缺页；然后按journal顺序用原生成ID重编译纯领域操作，对照每个base/after/result、完整domain和精确索引，最后核验pending。合法checksum不能绕过R5、引用、归属或操作结果校验。只有全部通过才发布active并flush；目标获得新library UUID，领域ID、旧历史、纠错、确认结果和prepared材料不变。激活前中断不开放读取，原库不覆盖。

默认上限：页8192 bytes、页缓存128、树/JSON深度64；普通请求1MiB；单对象物化1MiB/200000值；依赖遍历深度128。物理目录缓冲512节点，单次AVL更新暂可再增加有界路径，checkpoint时只落仍可达节点；库增长不扩大该缓冲。传输默认1GiB、1000000页、单行1MiB，超限拒绝，不截断正文。测试provider为测故障/统计保存内存Map，其总内存与正式分页算法的缓存预算分开报告。

P3-R2：每次记忆编译或状态查询新建`MemoryWork`，本次archives、执行图及advance状态检查共享预算，调用结束释放。校验、basis适用性、执行图、状态和纠错解析分别区分active/done；缓存只保留ID、标量结果及子图高度，不保存全库对象。fits以snapshot+revision为键，执行图/纠错以branch+revision为键，状态再包含cutoff；只在本次固定视图内复用，不跨提交或分支视图变化复用。命中done仍检查当前深度+缓存高度，不能因根枚举顺序绕过128层限制。

工作集最多8192个累计遍历状态，最多131072个工作单位（函数访问、引用/coverage成员、范围元素、纠错及根处理；derived-only前缀比较按元素预扣）。各类状态合计计数，全部档案/依赖不能绕过总预算。超过任一预算抛出RESOURCE_LIMIT，prepare不发布候选，状态查询也不会吞掉此错误而返回valid；环和深度违规仍为NEEDS_RESOLUTION/needs-resolution。数字是显式可拒绝的工程资源上限，不是产品容量、延迟或手机准入阈值。

同一固定视图的执行图按不同节点/边展开，不按路径指数展开；跨不同basis的适用性仍需分别检查，成本按实际(snapshot,revision)状态及边计数，受同一预算约束。活动递归体仍会持有深度上限内的单对象、coverage和证据集合，受单对象及工作预算共同限制，不能将memo条目数描述成总内存字节。完整恢复逐条请求使用相同编译预算；超过新预算或包含旧非法重排的材料会拒绝审计并保留staging，不自动修改历史以求恢复成功。

完整恢复可以线性枚举并重放历史以审计，但内存不随整个业务库物化。恢复审计仍消耗实际累计操作和物理材料的读取/计算成本；本轮不把它描述为常数时间。普通追加/重开和显式全量导出/审计分别取证。

### 10.4 准入和回退

固定TT仍为367b0c7e9410，c90d77d没有被认定解决句柄代次。原生验证仅使用独立data root、WebView profile与合成namespace，未触发真实sync/archive、未改TT、未切B2/A。完整恢复与增长正确性不等于P4资源/设备验收或手机生产准入。

回退保留所有库及分页包。旧入口拒绝新格式；读取新库须保留分页读者，不能改root格式来伪装降级。小型v2输出是互操作材料，不包含分页辅助账本；只有完整分页包承担此次恢复承诺。该P3增量提交时T-03仍in_progress且P4/P5未进入；当前状态由本文顶部及第11节覆盖。

## 11. P4可重建索引、只读诊断与资源阻塞（2026-09-21）

### 11.1 派生索引边界

独立格式 `mnemosyne-recall-index-v1` 只保存可重建的选中记忆候选、中文marker和人工数值向量。sidecar有building/ready/failed状态和源checkpoint；失败、丢失或behind不改变正文、Head、view、账本或恢复包。正式正文提交不等待索引。

检索分两层：sidecar只做有界粗筛，最终结果必须重新读取当前分页库，核对library/checkpoint、Story/Branch/view、selection、memory revision fingerprint以及`memoryStatus===valid`。不匹配、过期、已纠正、未选或失效候选全部丢弃。内部cosine/marker分数只用于人工测试排序，`rerank_score`仍为`null`，不冒充完整召回质量。

sidecar限制256项、单根1MiB、向量64维、候选256；这是小型恢复正确性实验，不是产品容量。索引namespace与正文namespace分离，完整分页备份不依赖sidecar；恢复后可以从确认正文重建。

### 11.2 只读诊断与物理库存

`PagedCoordinator`新增只读`diagnostics(branch)`，返回格式/library/status/checkpoint、确认operation数量、pending、物理节点、维护门禁及分支Head/view/marker。只读facade不暴露prepare/execute。离线库存按固定目录和checkpoint把物理材料分为：业务页、当前checkpoint可达页、当前不可达但保留页、活动目录页、陈旧目录/中间页和root。分类不删除数据，也不把不可达材料等同可GC。

Node计量provider的固定1x场景完整通过：32轮增长、4次深层编辑、删除、fork及记忆选择；当前正文976,500字符，历史版本1,069,500字符。源库333,608节点中，当前可达业务页14,596、不可达保留业务页17,752、活动目录32,348、陈旧目录/中间页268,911；完整恢复库77,692节点，陈旧目录/中间页12,995。源工作负载453.2秒，恢复262.9秒，峰值RSS833,236,992 bytes。该Map provider测量包含测试fixture本身开销，不代表TT或手机性能，但明确暴露目录发布放大。

### 11.3 固定TT停止证据

资源限制在运行前固定：单场景1,800,000ms、1,000,000物理节点、512MiB传输包，磁盘至少保留20GiB；不以测试结果反调阈值。固定宿主仍为TT `367b0c7e9410` / exe SHA256 `11a9bc110da5dc634ff8c0b7b8fe244110c360af46693e50de67968cb811f2c4`，独立portable data root和新合成namespace。

首轮run受用户报告的上游网络/LLM供应商中断污染，不作性能结论。新run `20260921p4b` 使用进度事件：4/32增长发布为401,846.6ms/15,769节点；8/32为1,078,023.6ms/40,651节点；第12次发布返回后的采样超过1,800,000ms，明确报`P4 native elapsed-time safety stop`。断言先于终点进度发送，故不补造第12次节点数。data root本轮增加60,445,275 bytes，宿主在各观察点响应。

这不是语义失败或崩溃恢复试验，而是普通发布路径的资源完成线失败。1x没有进入后续冷重开、范围读取、索引、导出和恢复，S09未通过。5x/10x不执行：原生1x已停止，Node 1x的333,608源节点即使线性外推到5x也超过100万节点限制。

### 11.4 关卡与不允许的静默决定

当前需review普通发布的目录构建、重复持久写和prepare成本，确定保持旧快照、checkpoint、幂等与完整恢复语义的最小算法修复范围。不得静默提高时间/节点限制、缩小1x、关闭`syncMode=full`、删除历史、自动GC、改TT或切B2/A。是否引入目录批量构建、写合并、离线维护或宿主批量原语属于待审设计，不由本节批准。

P5已补齐版本化只读诊断快照、结构化错误、空目标备份/恢复验证命令，并在固定TT只读冷开资源停止后的库；状态为implemented_unverified。安装/启停、故障复现和只读回退见`10-t03-storage-operations.md`。P4完成线仍未过，不能宣称T-03完成。自动维护继续`HOST_MAINTENANCE_UNSUPPORTED`，手机pending；完整证据见原task、`../notes/t-03-p4-resource-review.md`及`../evals/t03/p4-p5/`。

## 12. P4/P5快照边界与目录增量返修

`filterRecallCandidates`默认返回`{status, results, source}`，前后复核同一library/checkpoint/Story/Branch/Head/view；漂移为behind且无旧结果，search传递状态。原领域校验保留，rebuild完成前检查source，结果仅对返回的版本依据有效；未来注入仍须最终复核。

`exportSnapshot(branch)`在一次队列边界捕获诊断和固定目录导出流，不在队列中等待同队列handle。验证器对照该checkpoint及诊断，审计目标并复核目标checkpoint；源后续提交不参与比较，新目标library_id合法。finally关闭失败不掩盖主核验错误。

物理库存目录每1024个不同引用做增量AVL合并，复用未变子树；临时工作集硬限16,384候选页/16MiB，已登记引用缓存限512条且随恢复重建。只落盘当前批次根可达临时目录页，不删除已落盘页，不原地覆盖目录。业务put首次物理碰撞检查不跳过；业务页、control、generated IDs及账本格式不变。

最后目录批次完成后仍执行材料flush、单root发布、发布flush、ack。新的directory-write前后故障点纳入失败不变性验证，固定TT发布前/后强杀及丢确认恢复须以本轮代码重跑。旧/新分页包双向小样本恢复已验证，物理目录形状变化不改变领域或control内容身份。
