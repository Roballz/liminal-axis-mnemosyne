# T-02 最小可执行契约

版本：v0.3 / schema_version=1（逻辑包 format_version=2）；2026-09-19；状态：verified（限最小契约与 Node 内存参考模型）。1891043 最终复核关闭 R1～R5；证据、边界及 T-03 交接见 `notes/t-02-final-review.md`。

规则依据：03 的 T02-D01～D25 / P01、08 的 accepted Head 设计。实现入口为 `packages/contracts/index.mjs`，机器形状规范为 `schema.mjs` 的显式字段检查器；另有跨对象及转换校验。不是 JSON Schema 标准文件，不用静态类型冒充运行时校验。范围限 Node 内存参考模型，不是生产 Engine/数据库/HTTP SDK。

## 1. 身份、对象与字段字典

ID 为 `<prefix>_<lowercase UUIDv4>`。集中前缀：Story=st，Branch=br，SourceMessage=msg，SourceRevision=rev，HistorySnapshot=hs，ManifestBlock=hm，业务操作=op，派生家族=mem，派生版本=mr，记忆视图=mv，HostBinding=hb，Run=run，ContextBlock=cb。运行时使用安全 crypto.randomUUID；fixture 使用固定值。碰撞不可覆盖。2026-09-20 T-03 将 UUID/SHA 实现抽到跨 Node/TT 的 runtime.mjs，JCS与指纹版本不变；该运行时改动随 G1 待review，不扩大T-02原验收范围。

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
| 分支记忆视图 | version（mv ID）、selections：memory_id → memory_revision_id、corrections：被纠正的 memory_revision_id → 替代版本ID；单独于正文 Head |

所有字段显式出现；缺失、未知字段、非法值拒绝，不以 null 泛化故障。SourceRef 只含 message_id/revision_id，T-02 不支持字符跨度/正文投影；未来支持需版本化规定坐标，不能继承旧 offset。

kind 暂为 TurnMemory / Summary / Event / Record；不是冻结品牌名。TurnMemory 的 coverage 必须是相邻 User+Assistant 两条实际版本。实际额外读取的上下文也进入 input_refs。开场白、连续消息等未知结构保留全部 sources，groupTurns 返回 unsupported 且不批准猜测配对；普通末尾 User 为 pending。

HostBinding.intent 为 new_story / carryover / fork / confirmed_mapping，是上层已确认意图，不是模型猜测结果。创建新 Story 用独立 init；续接绑定不改正文 Head。绑定/文件变化必须推进 binding_generation；已有binding_id的story_id不可原地改变，即使映射暂时为空也拒绝，跨故事须用新binding身份或后续显式修复流程。宿主 stableId、index、NodeId 都不成为领域 ID。

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
- `{type:"memory",memory_id,memory_revision_id,dependency_mode?}`：实际读过的下级派生版本。省略模式等价于current，保持旧引用语义/指纹。

数组保持加工顺序，既不是字段级依赖图，也不是仅保留最终引用。Summary/Event/累计 Record 通过同一关系连接下层。basis_snapshot_id 保存生成时正文基线，不要求目标 Head 与其相同。

### 3.1 固定检查点与替代传播（R1/R2）

- current（默认）：实际版本引用仍不可变；目标分支当前选择必须对应它。下级被换成另一版，上级旧输出待重建，不能把旧引用文本改写为新引用后冒充已重建。
- checkpoint：只允许同一Record家族、严格较短且等于本版coverage前缀的历史版本。它固定读取该旧检查点，不因当前Record正常累计推进而被替换；仍递归核对原文、coverage、隐私及纠错记录。Summary/跨家族/同范围版本不能用此模式绕过selection。
- `selectMemory(state,branch,mr,expectedView,makeId?,mode="replace")` 默认替换：记录先前所选版本→新版本的分支纠错关系。正常累计需显式mode="advance"，并引用当前所选旧版为checkpoint；不登记旧版被纠正，且新累计版必须有效才发布。没有显式advance的自依赖组合会拒绝，不静默发布必然过期的结果。
- `correctMemory(state,branch,oldMr,newMr,expectedView,makeId?)` 用于纠正已不是当前选择的历史检查点。两版必须同家族/相同coverage；若旧版不是当前选择，不把较新的累计状态指针倒退，只登记corrections并推进记忆视图版本。依赖该检查点的后缀待重建；可按层纠正并最终恢复有效状态。
- corrections仅作用于本Branch；fork复制当时视图，父线后续纠正不改变子线。再次显式选回某版本会清除此目标的出向纠错映射，但其正文/传递依赖仍须有效；不是删除原文或全局复活旧数据。
- validity和planner共用dependencyTarget：current取当前selection，checkpoint取固定引用，再沿该分支显式corrections解析。实际引用与解析目标不同则旧结果待重建。实际执行图用active/done三色拓扑检查，合法共享依赖只访问一次；选择/纠错产生环则发布前NEEDS_RESOLUTION，validateState也拒绝，防御性planner返回blocked且无rebuild队列。

corrections是版本级纠错关系，不是字段级状态依赖系统。正文编辑仍由原来源/coverage判失效；不需要把每次正文变更强制登记成一次提取纠错。历史归档校验只看当时不可变来源是否成立，当前选择图校验另做，不能用现在的selection否定合法旧档案的存在。

R5交叉不变量：每个selection选中的根版本，沿本分支corrections解析后必须仍为自身。旧版本或纠错链中间版本仍被选中的矛盾状态，validateState/exportLogical/importLogical以NEEDS_RESOLUTION拒绝，即使导入checksum正确；不自动改selection或删corrections。memoryStatus对已被纠正的旧版本返回needs-rebuild，因此绕过导入的调用也不能通过prepareAvailability/canApply注入旧摘要；planner对矛盾视图返回blocked且无重建队列。此规则不要求所有历史版本等于当前selection，也不要求每条历史纠错链终点被选中：合法advance留下的未纠正检查点、历史检查点纠正后的非当前终点仍可按原规则使用，父线纠错不改变已固定子线。字段及逻辑包版本不变。

coverage 含 mode=interval/members、members（当时有序版本集合）、boundary（首尾 message_id；空为 null）、observed_span（当时首尾之间全部版本）。interval 的 members 必须等于整段；members 不要求连续，但 observed_span 用来检测中间新增/删除/重排并请求局部关联复核，不自动吸收新成员。

`memoryStatus(state,mr,branch,cutoffLength?)` 针对目标 Branch 当前 Head 前缀检查全部实际来源、下级选择与 coverage；不在共享对象上写 invalid。返回：

| 状态 | 语义 |
| --- | --- |
| valid | 该目标视图适用；不等于覆盖了全库 |
| needs-rebuild | 已知输入/下层版本/连续 coverage 变化，不能注入 |
| needs-review | 非连续集合span变化，或derived-only声明前缀无法确认；不能注入 |
| needs-resolution | 缺对象、损坏引用/循环等，不能以重摘伪造修复 |
| out-of-scope | 故事或显式作用域不适用 |
| excluded | 用户排除或私有字段，不进入正常发送 |

子线独立记忆视图，父线修正文或修摘要不全局破坏共享旧版。范围外追加、插入导致的显示楼层平移不自动废弃局部回合。切回旧 Revision 可显式选回适用记忆版本。重摘下层不改正文 Head，但推进本分支 memory_view_version，上级依赖旧下层版本时重建。

`rebuildPlan` 返回 statuses/rebuild/review/blocked；rebuild 依赖在前、上级在后。累计状态要显式引用前一有效状态和新输入，才可沿受影响后缀重放；模型不替调用者推断漏记依赖。这里只计划，不调用 LLM、不执行重建；review/blocked 未解除时不能消费受影响上级结果。

derived_only：无伪造引用，input_refs/coverage为空，有source_declaration和明确scope_branch_id/basis_snapshot_id。basis快照同时固定导入时声明历史的有序前缀，不随续聊修改；生成基线ID不同不再自动等于不可用。同Branch、声明前缀仍是当前有效历史前缀且全部位于请求cutoff内时，纯追加后仍可召回；原基线编辑/删除/重排或cutoff过早返回needs-review，不伪造原文重建。跨故事/子线仍out-of-scope，不自动继承。来源声明与基线原样逻辑导出。

## 4. Prepare 与 ContextBlock

prepare 字段：schema_version、story_id、branch_id、head_snapshot_id、run_id、binding_id、binding_generation、observation_generation、memory_view_version、policy_version、cutoff_length、user_input、recent_source_refs、required_memory_revision_ids、memory_tokens_max、placement_profile、input_fingerprint。

cutoff_length 是捕获的不可变快照内前缀条数，不是永久楼层 ID。run_id 由 Mnemosyne 创建；新一轮/取消/重试的新准备必须换 run。观察事件先推进 observation_generation 并标 pendingHistoryChange，未提交也不接受旧响应。Adapter 应用前提供新读取的 current，而非把响应 echo 当 current。

required_memory_revision_ids 是本次明确必需的记忆范围；未知返回needs_resolution，其余任何非valid状态（包括out-of-scope/excluded/未被选择/needs-review）返回not_ready并阻止canApply，不能伪装empty。只有必需集合确实为空才能聚合成empty。它不证明全库已就绪；调用者应把实际必需范围传全。其他故事、原文归档、诊断、导出和修复不全局停用。

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

v0.3兼容约定：旧input_refs缺dependency_mode仍表示current，不补写字段、不重算旧指纹；显式current/checkpoint的新字段作为实际input_refs的一部分进入原有派生投影，因此有不同指纹。view.corrections不改历史加工输入，更新view版本使prepare过期；未来持久化必须把选择/纠错与view版本一起提交。

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

exportLogical/importLogical只做内存逻辑往返。新包format_version=2，保留state及logical-export指纹；state包含stories/branches/messages/revisions/blocks/snapshots/memories/views/operations/bindings。验证来源、选择执行图和纠错链无环/同家族归属；校验完才返回冻结的新状态，不合并/覆盖已有库。

旧format_version=1先按原包内容验证checksum，再仅为旧视图补corrections={}，不改任何来源/快照/记忆ID或旧指纹。v1不允许携带新dependency_mode/corrections；含有旧版已允许但实际成环的选择图不会被伪装修复，仍拒绝并要求显式解决。新包不能降级给旧代码，否则会丢checkpoint/纠错含义。回退代码时保留原v1包和新增v2包，不把去掉字段当无损降级；本次没有生产库迁移。

T-03 必须提供：精确领域 ID 读写/完整枚举、不可变对象冲突保护、expected Head 协调、全部引用和操作结果的完整持久发布、失败恢复、记忆选择/重建进度保存、稳定导出边界、空环境恢复、可重建索引及真实 IO 错误。Node crypto/内存复制是此 oracle 的运行时，不要求 TT WebView 直接 import node 模块；B provider 的运行时边界必须另测。

provider 更换不能改正式 ID、有效清单和已有正确记忆；逻辑包不含 NodeId/TQL。此最小包尚无完整模块/用户锁/后台作业结构，不能作为未来全产品备份格式直接发布。物理块大小、扇出、GC、数据库和手机性能未冻结。T-03 保持 proposal，未执行。

旧例迁移：head_revision → head_snapshot_id（必须真实 snapshot，不是字符串改名前缀）；generation_id → Mnemosyne run_id；input_hash → 四用途指纹；memory_revision → memory_view_version；每楼 Leaf → 普通 TurnMemory 双来源；knowledge_scope → V1 普通上帝视角+独立隐私/发送权限。没有线上旧接口/真实数据迁移，本次仅更新人工样例；模块/提案样例仍明确标 draft，历史运行证据不重写。
