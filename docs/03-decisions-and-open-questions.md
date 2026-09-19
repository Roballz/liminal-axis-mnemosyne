# 决策记录与未决问题

v0.1 · 2026-09-17

## 1. 建议基线（B，尚非用户逐项批准）

| ID | 决策 | 理由与代价 |
| --- | --- | --- |
| B-01 | 独立 Engine + TT Adapter + Workbench | 降低数据迁移成本；需维护自己的 API |
| B-02 | 原文／版本为正式数据，索引可重建 | 更换模型不丢根基；需备份与迁移 |
| B-03 | 保留每楼 Leaf，跨楼事件用链接表达 | 不必二选一大叶子／碎片；事件边界需校正 |
| B-04 | 展示、常驻、召回、录入分别控制 | 实现“隐藏但能回忆”；设置需直观 |
| B-05 | ContextBlock 独立编译到宿主位置 | 用户可调各类位置；需 provider 联调 |
| B-06 | 助手提案后确认写入 | 减少覆盖与幻觉污染；多一步确认 |
| B-07 | 只读影子迁移，逐类替换注入 | 不破坏现用档案；阶段内维护两套入口 |
| B-08 | HTTP 先行，MCP 可选 | 当前 TT 接入不被 MCP 进度阻塞 |

## 2. 必须实验的部分（E）

### E-01：中文 BM25 实现

要比较普通名词、专名别称、无空格中文原句、短名字误匹配和错别字。决定分词／规范化／词表或字符方案，测索引成本。Qdrant sparse 是候选承载，不等于中文 BM25 自动完成。

关闭条件：固定测试集通过且有可重建索引说明，再冻结 provider 契约。

### E-02：多 query 融合

Vector Q1～Q5 家族内 max 与 RRF 对照；再与 BM25 家族做融合。测试同义 query 是否不合理重复投票。决定权重、候选池与截断；不要照抄某引擎的默认常数。

### E-03：rerank 与原文展开

起点保留 20 候选作为对照，并优先原文 rerank。比较摘要／原文／事件短包的准确率与 token；阈值按模型与数据集校准，不能把 0.9 当成 90% 正确率。单独选择全文升级规则与预算。

### E-04：事件边界与证据扩展

手动关联先行。自动聚组按场景、目标、参与者与因果变化提出建议，但要支持一楼多事件、跨楼同事件及交错剧情线。比较邻接扩展与 EventLink 扩展，避免召回一片就拉整章。

### E-05：激活与预算

明确名称可直达；模糊描述、关系邻居与近期提及的权重待评。重点常驻超额默认暂停；概览数量过大时具体如何引导用户管理待 UX 测试。不要擅自把“概览常驻”变成隐藏。

### E-06：延迟与故障默认

严格／宽松可配置；选择用户默认值、超时、上一轮派生未完成时的策略。检索失败、索引落后与没有相关记忆要有不同提示。

### E-07：技术栈与部署

TypeScript／正式存储／Qdrant 是建议方向。T-03 决定最小可维护部署；未完成中文检索与恢复实验前不固定全部组件版本。

## 3. 延后讨论（D）

D-01：千万字以上剧情骨架的组织、更新与有限常驻预算。
D-02：L1～Ln 层级总结保留方式；旧总结退出提示词后如何作为导航。
D-03：长期因果、关系变化、伏笔与角色心理连续性的专门评测。
D-04：是否改造 TT 活动聊天存储，或未来开发独立 RP 前端。
D-05：更复杂的实体关系图、多 Agent 整理与长期后台规划。

D 仅留入口，不提前自动删旧总结或把所有内容归到一个“永久大摘要”。

## 4. 变更模板

新建决策 ID，记录：问题、状态、用户要求、选项、选中方案、取舍、影响的数据／接口、测试证据、迁移和回退、替代的旧 ID。

没有证据时标 proposed，不把建议改成 accepted。旧记录被替代时标 superseded，保留理由。


## 5. T-02 身份／版本讨论确认（2026-09-19）

以下为用户与 Chat 基于 TT/ST 实际工作流确认的领域原则；正式字段名与完整 schema 仍由 T-02 任务冻结。

| ID | 状态 | 结论 |
| --- | --- | --- |
| T02-D01 | accepted | **Story 是逻辑剧情连续体，不等同于单个宿主聊天文件。** 普通新建空聊天默认创建新 Story；若用户为了降低高楼聊天负担而新开空聊天继续旧剧情，必须由用户显式选择“继续现有 Story／Branch”或等价 Carryover 操作，系统不根据“新建空聊天”自动猜测意图。完全一致旧档的重导入可提示为同源候选，但最终映射语义允许用户确认／覆盖。 |
| T02-D02 | accepted | **宿主聊天文件与 Mnemosyne Story/Branch 必须解耦。** 一个 Story/Branch 可以跨多个 TT/ST 聊天文件连续承载；单个宿主文件只作为来源／绑定，不作为长期主键。该绑定对象名称待 T-02 定名。 |
| T02-D03 | accepted | **平台“从某楼新建分支”映射为同一 Story 下的新 Branch，而不是复制成独立 Story。** 子 Branch 继承父 Branch 到分叉点为止的既有历史；分叉后双方独立推进。 |
| T02-D04 | accepted | **分支继承按引用／可见性复用，不复制分叉前记忆。** 子 Branch 保存 parent branch 与 fork cutoff，并复用祖先在 cutoff 之前的有效来源及派生记录；父线分叉后的内容对子线不可见。 |
| T02-D05 | proposed | **分叉继承当时的历史版本，而不是永远跟随父线后续修改。** 当前候选方案是子 Branch 保留 fork 时所引用的 SourceMessage Revision；父 Branch 后续编辑旧楼只切换父线自己的 active Revision，子线仍读取旧 Revision，无需把父线强制改名为另一 Branch。用户已确认问题存在，但该版本选择机制仍待最终讨论。 |
| T02-D06 | accepted | **Mnemosyne 自己生成的稳定 ID 才是正式身份。** TT/ST 的 session/conversation/chat ID、文件名、楼层号等只作为 provenance / adapter mapping，不能充当跨平台永久主键。 |
| T02-D07 | accepted | **SourceMessage 与 Revision 分离。** 同一逻辑消息被编辑时保留同一 SourceMessage，生成新的 Revision；旧 Revision 默认保留但退出当前有效历史，不用覆盖唯一原文。旧派生记录是否长期物理保留属于后续存储／GC 策略。 |
| T02-D08 | accepted | **Swipe 与 regenerate 视为同一 assistant SourceMessage 的候选 Revision 家族。** 当前选中的候选才参与当前 Branch；操作类型仍保留 provenance 以便诊断。若宿主可提供旧 swipe 候选，导入时可保存为非活动 Revision；无需为每个临时候选都生成派生记忆。 |
| T02-D09 | accepted | **派生记忆可以延后一轮生成，但这是调度策略，不改变版本语义。** 当最新回复仍可能 swipe/regenerate 时可保持 provisional；一旦后续消息推进，该 Branch 采用的 Revision 即成为该历史路径上的有效版本。即时生成模式下则必须在 swipe/regenerate 后失效旧派生并重建当前版本。 |
| T02-D10 | accepted | **Edit / Swipe / Regenerate 需要保留不同操作来源，但版本模型可统一。** Edit = 同一 SourceMessage 的正文新 Revision；Swipe/Regenerate = assistant 消息的候选 Revision 切换/新增。手动深层 Edit 无法依赖单一事件保证发现，需另有同步／修复策略。 |
| T02-D11 | accepted | **宿主删除默认先变成当前 Branch 不可见／tombstone，而不是立即物理擦除。** 对应派生记忆立即退出召回；真正永久删除由显式 purge 流程处理。是否长期保留被删原文及派生历史的物理副本由 T-03 存储/保留策略决定。 |
| T02-D12 | accepted | **来源顺序与剧情内时间是两个不同维度。** 楼层号只作显示／宿主映射；正式先后关系由 Branch 内来源顺序／版本关系维护。剧情内 YYYY-MM-DD HH:MM 等时间可作为 Event/摘要的 world-time 字段和展示辅助，但不能代替来源顺序，因为存在倒叙、回忆和时间不确定。 |
| T02-D13 | proposed | **Branch Head／History Revision 需要某种正式版本标识，但具体表达未冻结。** 用户提出可读组合 <story/parent>-<branch>-<最高楼层>-<剧情结尾时间> 作为思路；当前建议仅把楼层／剧情时间当显示与诊断信息，正式身份仍采用 Mnemosyne 内部不可变 ID／版本号。待 T-02 最终讨论。 |
| T02-D14 | accepted | **逻辑隔离采用共享 canonical store + story_id / branch_id / message_id 等作用域，不按聊天文件或角色卡各建独立数据库。** 同 Story 的多个聊天文件和多个 Branch 才能复用共同历史；角色卡不是数据隔离主键。物理数据库部署与表结构仍留给 T-03。 |
| T02-D15 | accepted | **当前有效历史由 Branch lineage + fork cutoff + active Revision 共同决定。** “失效/不可见”与“物理删除”严格区分；检索与派生结果必须按这套有效性视图过滤。 |

### T-02 当前未决／攻坚项

1. **旧档重新导入与身份重识别。** 内部 ID 为正式身份已经确定，但原始 JSONL / 跨平台导入缺少 Mnemosyne ID 时，怎样结合内容 hash、顺序、宿主 metadata、前缀匹配与用户确认来判断“同一档／副本／分支／全新 Story”尚未冻结。单纯相同 hash 只能证明内容相同，不能自动证明用户语义上希望合并。
2. **深层手动编辑的自动发现。** TT/ST 若没有可靠事件或只暴露当前窗口，需决定同步时扫描范围、指纹链／revision detection、显式 repair/rescan 的边界；首版不能假装能无成本实时监控整份超长聊天。
3. **正式 fork cutoff / head revision 表达。** 已确定必须绑定具体有效版本快照，但字段结构、版本向量或其他表示仍需设计与正反例验证。
4. **SourceMessage / Revision 的导入匹配算法与冲突语义。** 包括重复导入、内容相同但用户故意复制成另一故事、部分前缀相同、文件改名、跨 TT/ST 迁移等。
5. **被删除／旧 Revision 的物理保留与 GC。** 领域语义已确定为默认不立即硬删，但具体保留期、备份传播和永久 purge 由 T-03 存储方案决定。



## 6. T-02 第二轮讨论与宿主取证（2026-09-19）

### 已确认

| ID | 状态 | 结论 |
| --- | --- | --- |
| T02-D16 | accepted | **Carryover／续接旧剧情必须是显式用户动作。** 新建空聊天本身不说明用户想继续旧 Story；Mnemosyne 可提供“绑定到已有 Story/Branch／携带记忆继续”的入口，但不自动猜测。 |
| T02-D17 | accepted | **手动映射是正式兜底能力。** 当自动身份匹配、跨平台导入或分支关系无法可靠判断时，允许用户明确指定“这个宿主聊天属于哪个 Story/Branch/Segment”，系统不得为了全自动而冒险合并。 |
| T02-D18 | accepted | **无原文的派生记忆允许存在并参与召回。** 必须显式标记 source unavailable / derived-only，不伪造原文或假装完整覆盖。 |
| T02-D19 | accepted | **V1 默认采用上帝视角记忆。** 不按单个角色知识范围过滤普通召回；仅保留最小 visibility/audience 扩展字段，为未来单角色 Agent／多 Agent 分饰模式预留，不在当前 RP 模式启用复杂知识屏蔽。 |
| T02-D20 | accepted | **身份冲突、来源缺失、无法确定的合并禁止自动写入。** 冲突进入 needs-resolution；由用户手动修复或未来 AI 助手给出提案，确认无冲突后才能继续该受影响范围的写入。 |
| T02-D21 | accepted | **基础派生单位固定为“一轮 User + 对应 Assistant 输出”这一对。** 默认不单独为 User 楼生成独立摘要／记忆；User 内容作为该轮输入来源与 Assistant 输出共同组成派生源。派生摘要／记忆归属于这组实际 SourceMessage Revision，而不是仅绑定楼层号；楼层、message index、剧情时间只作定位与展示。 |

### 待确认／方案候选

1. **Derived Memory 的正式来源契约。** 当前建议：摘要、事件、实体变化等派生对象必须保存一个或多个 source_revision_id（必要时再带 source span）；楼层号、message index、world time 只作 provenance/display，不能作为唯一来源键。
2. **派生对象类型与命名。** 用户倾向不同层级使用不同对象：单轮／单段小记忆、跨非连续楼层事件、实体／状态记录分别建模；正式名字兼顾 Mnemosyne 品牌与技术清晰度，尚未冻结。
3. **ContextBlock 正式字段。** 当前理解：它是 Engine 发给 Adapter 的临时“待注入记忆块”，不是数据库正文格式本身。不同记忆类型可以有不同渲染模板；role/位置可由用户配置，默认通常 system。
4. **Run / Generation identity。** 候选方案：每次生成前拦截由 Mnemosyne 自己创建 run_id，不依赖 TT 原生 generation id；生命周期覆盖 prepare → context compile/inject → generation end/cancel。
5. **Branch History Revision / Head snapshot。** 候选方案：每次会改变当前有效历史的 append/edit/swipe/delete/branch mapping 都推进内部 revision/epoch；生成开始时捕获它，结果返回前复核。楼层号和剧情时间只用于 UI/日志，不作为唯一并发控制键。
6. **Derivation input hash。** 候选方案：hash 用于幂等/缓存，不充当消息身份。输入应至少包含实际 source revision IDs + 规范化正文 + derivation schema/prompt version；“相同楼层号 + 相同文本 hash”不足以跨 Branch 唯一判断同一来源。
7. **TT chat_metadata.integrity 的角色。** 已确认它是当前 TT character chat stableId() 的来源。用户已人工检查约 7～8 个实际存档，其中包含多个 Branch，所见 integrity 均不重复；这说明当前实际环境中它很可能是聊天文档级稳定身份。由于源码分支路径的 metadata 继承行为仍可能受保存端重写影响，T-02A 再做一次受控 parent/child 实测后冻结其 adapter 语义。即便验证为文档级唯一 ID，它仍只作为宿主稳定 ID，不替代 Mnemosyne 的 Story/Branch 主键。
8. **旧档与重复导入匹配。** integrity、内容 hash、顺序前缀、文件名/chatRef 都可作证据，但最终仍保留用户确认和手动映射；自动判定规则待集中攻坚。


## 7. T-02A 前置验证决定（2026-09-19）

在冻结正式 T-02 契约前，先执行一个小型宿主事实验证子任务 T-02A；它属于 T-02 的前置验证，不改变 S-A 的主任务编号。

T-02A 只回答以下事实问题：

1. 当前 TT 2.2.0 dev/Canary 创建 Branch 后，parent / child 的 stableId()/chat_metadata.integrity 是否确实不同。
2. 普通 UI 手动编辑旧消息时，扩展侧是否稳定收到 MESSAGE_EDITED(messageIndex) 与 MESSAGE_UPDATED(messageIndex)，以及事件发生时能否读取到编辑后的正文。
3. 删除消息时 MESSAGE_DELETED 提供什么参数；删除后历史索引如何变化。
4. Swipe / regenerate 时 MESSAGE_SWIPED / generation lifecycle 能否稳定定位当前 assistant message 与 active swipe。
5. 文件改名、普通重新打开聊天是否保持 stableId 不变。

T-02A 不设计数据库、不实现正式 Memory Engine、不冻结 Story/Branch/Revision schema；它只产出宿主能力矩阵和脱敏运行证据。若事件能力不足，正式 T-02 必须保留手动 repair/rescan/映射入口作为降级路径。


## 8. TT `api.db` / TriviumDB 宿主能力取证（2026-09-19）

2026-09-18，TauriTavern 合并 PR #17，将 TriviumDB 重构为原生 adapter crate 并通过 `window.__TAURITAVERN__.api.db` 暴露给扩展。该变化影响 T-03 技术栈评估，但不改变 T-02 的 Story / Branch / SourceMessage / Revision 领域契约。

### 已验证宿主事实

1. **不是 WebView / IndexedDB。** 前端 `api.db` 只是 JS bridge；实际 CRUD、向量检索、文本索引、图操作与 TQL 由 TT Rust 后端的 `tt-adapter-triviumdb` 执行。
2. **是 TT data root 下的原生嵌入式数据库。** 每个 namespace 使用独立数据库实例／文件组，TT 文档给出的路径为 `_tauritavern/databases/db-<namespace>/`。
3. **完整 TT 数据归档已纳入数据库。** 导出前会 flush，并在归档期间暂停数据库操作；导入按 namespace 替换文件组，导入后扩展需要重新 `open()`。
4. **索引与真相源仍需分离。** TT 对 TriviumDB 0.8.8 的说明明确指出：手工 `indexText` / `indexKeyword` 不进入 WAL；批量索引后应调用 `buildTextIndex()`，并保留可重建索引的源文本。这与 B-02“原文／版本为正式数据，索引可重建”一致。
5. **它不是外部数据库服务。** `window.__TAURITAVERN__.api.db` 只存在于 TT 宿主 WebView；独立 Mnemosyne Engine / MCP 进程不能把它当网络数据库直接连接。若使用，必须通过 TT Adapter 调用，或另做明确的宿主桥接。

### 对 Mnemosyne 的当前影响

- **T-02：不改。** canonical identity、Branch lineage、Revision、派生来源与有效历史语义仍由 Mnemosyne 自己定义。
- **T-03：新增强候选。** 需要把“TT 内嵌 TriviumDB provider”与独立后端方案做对照实验；若验证通过，它可能在 TT-only / 本机模式下同时承担 JSON 真相数据、向量、文本和图查询，从而减少首版外部组件。
- **跨平台约束不变。** 不能把 TT namespace、NodeId、TQL 或 TriviumDB 文件格式提升为 Mnemosyne 的跨平台正式身份／领域契约；它们最多属于 storage adapter / deployment provider。
- **中文检索仍需 E-01 实测。** 上游 TriviumDB 当前文档描述 TextIndex 使用 AC + BM25 2-Gram，这对无空格中文很有潜力，但必须在 TT 实际固定版本与我们的中文 RP 测试集上验证，不直接当成方案已冻结。


## 9. T-03 渐进式 Storage Provider 路线（2026-09-19）

状态：proposed，待 T-03 实测后冻结。

用户当前只有约百万字真实 RP 样本，历史千万字记录无法从原商业平台导出。由此采用“两类测试集分工”，不等待真实数据自然增长到千万字：

1. **真实百万字集**：用于检索质量、中文 BM25/向量混合召回、事件与角色连续性、误召回/漏召回等语义评测。
2. **合成放大集（5x/10x 或更高）**：从真实样本的结构、长度分布、元数据与关系密度生成压力数据，用于存储规模、冷启动、RSS/heap、p95/p99 查询延迟、索引构建、flush/compact、备份恢复和迁移演练。合成集不得替代真实集的语义质量结论。

### 渐进式实现候选

若 T-03 A/B 证明 TT 内嵌 TriviumDB 在百万字真实集 + 合成规模集上达到首版门槛，优先交付：

- **Provider B：TT TriviumDB 本机 provider**，让用户尽早在现有 TT 手机/桌面环境实际使用；
- 同时保持 Mnemosyne Core 的 storage contract、canonical IDs、逻辑导出格式与索引重建规则独立于 TriviumDB；
- 后续继续实现 **Provider A：独立 Mnemosyne backend**，用于更高规模、跨宿主、服务端部署和更强扩缩容；
- 当真实剧情增长或 A 成熟时，从 B 迁移到 A；迁移依赖 Mnemosyne 自己的 canonical 数据与可重建索引，不依赖 Trivium NodeId/TQL 作为永久身份。

### 必须守住的迁移边界

- TriviumDB NodeId 只能是 storage-local ID，不得成为 SourceMessage/Revision/Event 等正式身份。
- 原文、Revision、派生对象及其来源关系必须能逻辑导出；向量/TextIndex/QuIVer 等视为可重建索引。
- Provider contract 不暴露 TQL 作为 Mnemosyne Core 必需语义，避免未来 A provider 被迫复刻 TriviumDB。
- B 版验收必须包含“导出 B → 空环境重建/导入”的演练，否则不得视为可迁移。
