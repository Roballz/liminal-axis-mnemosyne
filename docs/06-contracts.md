# T-02 最小可执行契约

版本：v0.2 / schema_version=1；2026-09-19；状态：implemented_unverified，待 Chat review。

规则依据：03 的 T02-D01～D25 / P01、08 的 accepted Head 设计。实现入口为 `packages/contracts/index.mjs`，机器形状规范为 `schema.mjs` 的显式字段检查器；另有跨对象及转换校验。不是 JSON Schema 标准文件，不用静态类型冒充运行时校验。范围限 Node 内存参考模型，不是生产 Engine/数据库/HTTP SDK。

## 1. 身份、对象与字段字典

ID 为 `<prefix>_<lowercase UUIDv4>`。集中前缀：Story=st，Branch=br，SourceMessage=msg，SourceRevision=rev，HistorySnapshot=hs，ManifestBlock=hm，业务操作=op，派生家族=mem，派生版本=mr，记忆视图=mv，HostBinding=hb，Run=run，ContextBlock=cb。生产生成使用 Node crypto.randomUUID；fixture 使用固定值。碰撞不可覆盖。

| 类型 | 必填字段及含义 |
| --- | --- |
| Story | schema_version、story_id；逻辑连续剧情，不是宿主文件 |
| Branch | schema_version、branch_id、story_id、head_snapshot_id、fork（初始主线为 null） |
| SourceMessage | schema_version、message_id、story_id；相同文本仍可有不同身份 |
| SourceRevision | schema_version、revision_id、message_id、role、content、content_fingerprint、provenance；正文和角色不可原地改 |
| provenance | host_kind、binding_id/null、host_scope、stable_id/null、mutable_ref/null、observed_index/null、import_batch/null、operation；仅来源证据，不保存密钥 |
| HistorySnapshot | schema_version、snapshot_id、story_id、branch_id、previous_snapshot_id/null、manifest_root_id、message_count、change_kind、operation_id、created_at |
| 叶块 | schema_version、block_id、kind=leaf、entries：有序 SourceRef 数组 |
| 目录块 | schema_version、block_id、kind=directory、children：有序 {block_id,message_count} 数组 |
| fork | parent_branch_id、source_snapshot_id、prefix_length、anchor；anchor 为最后一个 SourceRef，空前缀为 null |
| HostBinding | schema_version、binding_id、story_id、branch_id、host_kind、host_scope、stable_id/null、mutable_ref/null、binding_generation、intent、message_map |
| message_map | 有序 {host_key,message_id}；同一绑定内双向不歧义，跨文件可复用领域消息 |
| 派生版本 | schema_version、memory_id、memory_revision_id、story_id、basis_snapshot_id、kind、origin、input_refs、coverage、recipe_id、model_profile/null、input_fingerprint、content、visibility、recall_enabled、source_declaration/null、scope_branch_id/null |
| 分支记忆视图 | version（mv ID）、selections：memory_id → memory_revision_id；单独于正文 Head |

所有字段显式出现；缺失、未知字段、非法值拒绝，不以 null 泛化故障。SourceRef 只含 message_id/revision_id，T-02 不支持字符跨度/正文投影；未来支持需版本化规定坐标，不能继承旧 offset。

kind 暂为 TurnMemory / Summary / Event / Record；不是冻结品牌名。TurnMemory 的 coverage 必须是相邻 User+Assistant 两条实际版本。实际额外读取的上下文也进入 input_refs。开场白、连续消息等未知结构保留全部 sources，groupTurns 返回 unsupported 且不批准猜测配对；普通末尾 User 为 pending。

HostBinding.intent 为 new_story / carryover / fork / confirmed_mapping，是上层已确认意图，不是模型猜测结果。创建新 Story 用独立 init；续接绑定不改正文 Head。绑定/文件变化必须推进 binding_generation；宿主 stableId、index、NodeId 都不成为领域 ID。

## 2. 不可变历史与提交

清单展开按子节点顺序，检查计数、引用存在、revision 所属消息及故事、无环、同一消息不重复；正文不嵌在快照里。snapshot.previous 只在同 Branch 内；Head 必须属于本 Branch；逻辑包中已提交快照必须在其 Head 历史链上。

fork 固定父 snapshot 的含端点前缀，创建子线自己的初始 snapshot。父线以后变化不修改子线来源；从 User 处 fork 不继承读取下一条 Assistant 的整轮摘要；跨 cutoff 的事件不能原样复用。

`commitHistory(state, command, makeId?) → {state,snapshot_id}`。command 含 operation_id、story_id、branch_id、expected_head/null、change_kind、entries、messages、revisions、fork/null、created_at。messages/revisions 是本次新归档对象，已有 ID 不重复塞入；未选中的实际候选可归档，但不能伪称取得过宿主已丢弃的正文。

change_kind：init/fork 只初始化新 Branch；append 只追加；edit/swipe/regenerate 改同一消息的一个选中版本，后两者仅 assistant；delete 只移除已选条目；reorder 保留成员仅改顺序；import 表示已确认的完整新历史，可插入/复合修改；restore 只恢复本 Branch 保留的旧历史并产生新 snapshot。

先查已提交 operation_id：相同写入指纹返回原结果，异 payload 返回 OPERATION_CONFLICT；之后才查 expected_head。两个旧 Head 竞争者不能都成功。新对象/清单/快照完整校验后才返回新状态；失败不修改输入状态。确认为完全相同历史的 import 不推进 Head；摘要修正和绑定变化也不推进。

参考实现复制内存状态，以双条目叶块演示共享；这个数字仅为 fixture/oracle 实现细节，不是生产块大小决定。没有 B-tree、事务、持久化、崩溃恢复。所有历史正文/块/快照和派生版本不就地覆盖；视图/绑定通过新状态更新。archiveMemory/selectMemory 是低级纯逻辑步骤，不宣称已有可恢复的后台作业/通用写入事务。

## 3. 来源、coverage 与逐层有效性

input_refs 两种明确形状：

- `{type:"source",message_id,revision_id}`：实际读过的正文版本。
- `{type:"memory",memory_id,memory_revision_id}`：实际读过的下级派生版本。

数组保持加工顺序，既不是字段级依赖图，也不是仅保留最终引用。Summary/Event/累计 Record 通过同一关系连接下层。basis_snapshot_id 保存生成时正文基线，不要求目标 Head 与其相同。

coverage 含 mode=interval/members、members（当时有序版本集合）、boundary（首尾 message_id；空为 null）、observed_span（当时首尾之间全部版本）。interval 的 members 必须等于整段；members 不要求连续，但 observed_span 用来检测中间新增/删除/重排并请求局部关联复核，不自动吸收新成员。

`memoryStatus(state,mr,branch,cutoffLength?)` 针对目标 Branch 当前 Head 前缀检查全部实际来源、下级选择与 coverage；不在共享对象上写 invalid。返回：

| 状态 | 语义 |
| --- | --- |
| valid | 该目标视图适用；不等于覆盖了全库 |
| needs-rebuild | 已知输入/下层版本/连续 coverage 变化，不能注入 |
| needs-review | 非连续集合的相关 span 变化，需关联复核，不能当作完整事件 |
| needs-resolution | 缺对象、损坏引用/循环等，不能以重摘伪造修复 |
| out-of-scope | 故事或显式作用域不适用 |
| excluded | 用户排除或私有字段，不进入正常发送 |

子线独立记忆视图，父线修正文或修摘要不全局破坏共享旧版。范围外追加、插入导致的显示楼层平移不自动废弃局部回合。切回旧 Revision 可显式选回适用记忆版本。重摘下层不改正文 Head，但推进本分支 memory_view_version，上级依赖旧下层版本时重建。

`rebuildPlan` 返回 statuses/rebuild/review/blocked；rebuild 依赖在前、上级在后。累计状态要显式引用前一有效状态和新输入，才可沿受影响后缀重放；模型不替调用者推断漏记依赖。这里只计划，不调用 LLM、不执行重建；review/blocked 未解除时不能消费受影响上级结果。

derived_only：无伪造引用，input_refs/coverage 为空，有 source_declaration 和明确 branch/basis snapshot。可召回，不提供原文展开。**当前安全下界只允许声明的精确快照完整视图，不自动继承子线或扩张到后续 Head**；更宽来源缺失记忆适用范围需 Chat review 后设计，不能按空来源“处处有效”。它不是损坏引用的降级包装。

## 4. Prepare 与 ContextBlock

prepare 字段：schema_version、story_id、branch_id、head_snapshot_id、run_id、binding_id、binding_generation、observation_generation、memory_view_version、policy_version、cutoff_length、user_input、recent_source_refs、required_memory_revision_ids、memory_tokens_max、placement_profile、input_fingerprint。

cutoff_length 是捕获的不可变快照内前缀条数，不是永久楼层 ID。run_id 由 Mnemosyne 创建；新一轮/取消/重试的新准备必须换 run。观察事件先推进 observation_generation 并标 pendingHistoryChange，未提交也不接受旧响应。Adapter 应用前提供新读取的 current，而非把响应 echo 当 current。

required_memory_revision_ids 是本次明确必需的记忆范围；其中待重建/未知必须返回 not_ready/needs_resolution，不能伪装 empty。它不证明全库已就绪；调用者应把实际必需范围传全。其他故事、原文归档、诊断、导出和修复不全局停用。

response：schema_version、echo（完整请求）、status、blocks、warnings、rerank_status、rerank_score。status 为 ready / empty / not_ready / needs_resolution / index_behind；只有 ready 有 blocks。没有执行 rerank 或失败时 score=null；不能填 cosine/RRF。最低方案不实现检索 trace 计算。

ContextBlock：block_id、kind、content、content_revision、origin、input_refs、source_declaration、activation_reasons、placement、priority、compressible、residency、token_count_estimate、visibility、send_allowed。字段均由 schema 校验。

placement.role=system/user/assistant 与 position=before_history/at_depth 分开，前者 depth=null，后者为非负整数。用户可配置，未硬编码 system；宿主编译/实机验证仍待后续。residency=detail 要求 compressible=false，预算不足应阻止/报错，不能静默摘要。当前不实现 tokenizer 或预算分配。

来源派生块必须有 input_refs；derived_only 块必须指向作用域已校验的记忆版本；user_defined 设定必须有显式来源声明，不能冒称已发生正文事实。private 或 send_allowed=false 拒绝发送。隐藏 residency=none 不等于 recall_enabled=false；不启用角色知情/地点硬过滤。

`canApply` 核对当前状态、完整 echo、未提交变化、必需记忆可用性以及各块来源/选择。历史追加会使旧 prepare 过期；后台摘要不用这套 run/head 严格门禁，而用自身来源/coverage 的 memoryStatus。调用者仍需清理旧注入槽和保证一个类别一个注入者；本包不部署 Adapter。

## 5. 四类指纹输入

格式：`sha256:<purpose>:v1:<hex>`；对 `{purpose,version:1,payload}` 做 JCS、UTF-8 编码后 SHA-256。SHA-256 不充当身份/权限/模型确定性承诺。

| 用途 | 精确包含 | 排除 |
| --- | --- | --- |
| content | {role,content} | UUID、宿主路径/index、观察时间、模型、派生输出 |
| derived-input | story_id、kind、origin、input_refs（实际输入顺序）、coverage、recipe_id、model_profile、source_declaration、scope_branch_id、scope_snapshot_id（derived-only 的 basis；正常来源为 null） | 记忆输出/ID、正常来源 basis Head、run/时间/路径/物理 provider/NodeId |
| prepare-input | prepare 除 input_fingerprint 外所有字段 | 返回 blocks、运行耗时、宿主可变路径、物理 provider ID |
| write-payload | 完整历史 command，包括 operation_id、expected_head、entries 顺序、新消息/版本及 provenance、fork、固定 created_at | 模型后生成的 snapshot/block ID、网络重试时间/HTTP 头、provider 信息 |

相同 operation 重试必须复用创建时 command，不更新 created_at 或 provenance 的观察值；否则是明确冲突。派生 recipe_id 必须绑定实际规则/profile/schema 版本；已知模型 profile 不含凭证。未来新增影响输入的字段必须升级用途版本或明确兼容，不暗中改 v1。

编码规则依据 [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)：对象键按 UTF-16 顺序递归排序，数组保序，原文不做 Unicode/空白规范化；数字序列化交给 ECMAScript JSON.stringify。拒绝非有限数、孤立代理项、稀疏数组、循环、getter、非 JSON 对象等，不偷偷修复。

本 API 接受内存 JSON 值，不是文本 JSON 解析器。生产入口必须在 parse 前/过程中拒绝重复属性名和超限；JSON.parse 后丢失的重复 key 无法在本层还原。大整数身份不用 number；计数要求安全整数。完整跨语言 JCS 兼容和资源上限测试仍待生产入口。

## 6. 错误、缺失与宿主事实

ContractError 带 code、message、scope（可空）；领域码不绑定 HTTP：

| 码/结果 | 含义；A provider 可选映射 |
| --- | --- |
| INVALID_SCHEMA / INVALID_TRANSITION | 缺字段、非法结构/变更；422 |
| NEEDS_RESOLUTION | 身份或引用不明确；409，受影响范围进入修复 |
| ID_COLLISION / OPERATION_CONFLICT | 不可变身份碰撞/同键异请求；409 |
| HEAD_CONFLICT / VERSION_CONFLICT / STALE_PREPARE | 预期状态过期；409 |
| NOT_READY | 必需记忆未准备好；503（示意） |
| UNSUPPORTED | 非标准分组等尚不支持；422 |
| FORBIDDEN | 私有/禁发内容；403 |
| pending / empty / index_behind | 正常待回复/确实无匹配/索引落后，彼此不同 |
| IO_ERROR（provider 保留） | 真实存储/网络故障必须传播，不能转 empty；本包不模拟 IO |

认证/授权、资源超限和网络服务没有实现。应用 schema 成功不是授权。

interpretRegenerate 只消费已确认映射、稳定前后正文、成功确认；中间删除返回 pending，失败留空/状态变化返回 needs-resolution，正文未改返回 unchanged。ended/received 和同 index 不是成功/身份依据。T-02A 已验证 Delete 参数为删除后长度、Regenerate 候选不保证保留、summary 可滞后；本次 fixture 不替代新真机验证。完整 rescan/模糊匹配未实现。

## 7. 逻辑包、迁移与 T-03 交接

exportLogical/importLogical 只做内存逻辑往返。包带 format_version=1、state、logical-export 指纹；state 包含 stories/branches/messages/revisions/blocks/snapshots/memories/views/operations/bindings。验证引用、计数、分叉、链、操作结果及派生来源，校验完才返回冻结的新状态；不合并或覆盖已有库。

T-03 必须提供：精确领域 ID 读写/完整枚举、不可变对象冲突保护、expected Head 协调、全部引用和操作结果的完整持久发布、失败恢复、记忆选择/重建进度保存、稳定导出边界、空环境恢复、可重建索引及真实 IO 错误。Node crypto/内存复制是此 oracle 的运行时，不要求 TT WebView 直接 import node 模块；B provider 的运行时边界必须另测。

provider 更换不能改正式 ID、有效清单和已有正确记忆；逻辑包不含 NodeId/TQL。此最小包尚无完整模块/用户锁/后台作业结构，不能作为未来全产品备份格式直接发布。物理块大小、扇出、GC、数据库和手机性能未冻结。T-03 保持 proposal，未执行。

旧例迁移：head_revision → head_snapshot_id（必须真实 snapshot，不是字符串改名前缀）；generation_id → Mnemosyne run_id；input_hash → 四用途指纹；memory_revision → memory_view_version；每楼 Leaf → 普通 TurnMemory 双来源；knowledge_scope → V1 普通上帝视角+独立隐私/发送权限。没有线上旧接口/真实数据迁移，本次仅更新人工样例；模块/提案样例仍明确标 draft，历史运行证据不重写。
