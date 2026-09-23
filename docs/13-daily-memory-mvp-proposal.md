# 日用记忆初版：范围收缩与存储建议

日期：2026-09-23。状态：用户需求已记录；本文的实现选型、扩展字段与完成线为 proposed，尚未冻结、施工或验收。不是 T-06/T-07 正式任务卡，不自动启用下一任务。

本轮只读核对仓库与官方文档；未编写实现、运行测试、使用付费模型、读取真实聊天或操作用户设备。既有受控验收保留，不升级为手机生产准入。

## 1. 用户本轮明确需求

- 日常体验以用户的柏宝书 `codex/item-keywords-presence` 分支为参照：LLM Query、多查询向量、BM25、RRF、rerank，保留原文升级与 BM25/RRF 摘要额度；知识库额度、embedding 阈值独立。
- 目前实际使用物品、地点、生活小档案、记忆召回，以及当前时间/地点默认注入；眼下局势、变量、角色记录不作为本轮交付。
- 物品/人物/组织/设定等继续采用聊天内记录的模式，不先建设 Mnemosyne 实体状态数据库。沿用存储模式不代表本轮启用用户未使用的人物等功能，也不代表柏宝书已有独立组织 schema。
- 首先明确正文与摘要的独立入库及跨端/跨设备使用方式。优先考虑 TT 数据库兼容路线，过于复杂则接受 IndexedDB 或手机可用的 SQLite 路线；不因此预先授权三套后端同时实现。
- 能复用的现有功能直接复用；定档后再组织一个可日用的实现任务，由用户实机体验。此次不要求自动生成正式任务卡。

## 2. 当前进度和新的实际阻塞

S-A、T-04/T-05 的身份/版本、受控存储、只读导入和手动搜索已验收；自动向量/BM25召回、新摘要管线尚未作为正式任务交付。另已有 `apps/manual-search` 0.1.2 安装 Demo，不能再说完全没有日常入口。

但 Demo 的存储效率没有收口：`evals/manual-search-demo/0.1.1-synthetic-cost.json` 明确标注 `node-map-not-native`，27 条、8927 字符的合成材料产生 80315 次 get、31258 次 put。**这是现有 Mnemosyne 分页/目录实现的读写放大证据，不是手机测试，不证明 TriviumDB 本身性能差。** 0.1.2 文档仍将导入性能标为未解决；备份有 16 MiB 限制且没有文件恢复向导。

TT 原生 B provider 已有，不必从零验证一遍所有宿主原语。其基线使用 TriviumDB 公开 API，不是 SQLite SQL 接口；公开通用事务能力不足由现有协议补足。最新 Demo 回执指出 batchInsert 自动分配 NodeId，与当前指定物理 ID 的 upsert 并非直接替换关系。不能声称只换成批量写就已解决。

因此建议保留领域身份/来源/固定快照规则，但日用首版不要原样复制高放大的物理分页协议；更换或精简物理 provider 仍需作为明确选型决定，而不是偷偷修改已验收语义。

## 3. 柏宝书分支源码事实

核对分支头：`393873acd27906a09308ae65fe7e636a3d3941ab`。该结论针对仓库源码，不把它当成用户设备安装包已核对。

| 数据 | 实际持久化位置与字段 | 使用方式 |
| --- | --- | --- |
| L0 摘要和结构化变更 | `chat[i].extra.bbs_leaf`，摘要在 `text`，物品/人物/地点/生活细节等操作在 `delta` | `saveChat()` 落盘；有效叶子按当前聊天楼层顺序重放 |
| 高层摘要 | `chat_metadata.baibai_book.summaries`；`level`、`childIds` 等 | 压缩节点保存文本及下层关联，不承担结构化 delta 重放 |
| 当前实体/状态视图 | Vue 响应式 `memory` 镜像，不是另外一套实体持久数据库 | `deriveMemory(chat)` → `recomputeDerived()` → 状态文本 → `setExtensionPrompt()`；历史摘要和当前状态使用不同注入槽 |
| 本地摘要向量 | IndexedDB `bbs_vec_local` v1，store=`items`；主键 `[database,scope,leafId]`，索引 `by_scope=[database,scope]` | 记录 `docHash,payloadHash,vector,dim,document,mesFull,storyTime,msgIndex`；`document` 为索引文本，`mesFull` 为可空原文副本 |
| 知识库文件/区块 | IndexedDB `bbs_knowledge_files` v1，store=`files`，主键 `id`，索引 `database` | 字段 `id,database,name,delimiter,chunks,enabled,embedding,revision`；向量仍放 `bbs_vec_local.items` 的 `knowledge:<fileId>` scope |

摘要向量可调度到柏宝库后端；本地降级按 scope 取数据做 JS 余弦扫描。新增知识库直接使用 `localStore`，不能因装了柏宝库就认定它也自动上云。知识库原始区块及向量不在聊天文件中，不能把聊天备份当成该知识库的完整备份。

`hybrid.ts` 已实现两家族 RRF 及“原文 → BM25摘要 → RRF摘要 → 向量摘要”的去重补位；多条向量 query 先在向量家族内 max 合并。原文升级使用真实 rerank 分数。以上不需要重新设计。

复用优先级：先抽取 `hybrid.ts`、`bm25*`、query rewrite/embedding/rerank 客户端与必要渲染逻辑；读取数据和 scope 映射换成 Mnemosyne adapter。不能原样继承“楼层号即来源”“按 scope 全量载入”作为长期档案设计。原始代码复制前核对许可/授权；本轮没有作出许可证已确认的结论。

## 4. 记忆功能清单与首版建议

| 能力 | 本轮建议 |
| --- | --- |
| 现有混合召回、原文升级、独立知识库 | 保留用户当前体验，复用已有实现，不重新调算法或引入新的重型搜索服务 |
| 正文/L0/高层摘要档案与回溯 | 本次核心；正文和摘要分开保存，保留层级及来源声明，原文升级从指定正文版本读取 |
| 已确认继承档案的检索 | 支持明确选择的同故事/分支历史，不跨所有聊天全局混搜；继承/分叉意图沿用已定规则 |
| 编辑/swipe/分支/截止点过滤 | 保留既有契约；发送前核对来源和当前视图，不把保存了旧版等同于允许旧版召回 |
| 正文编辑后的摘要审核 | 沿用 12 文档；保留摘要必须记录明确兼容确认，不能更改旧生成来源假装重摘 |
| 事件记录和事件链扩展 | 原架构确有此项；建议后置，不以完成事件引擎阻塞正文/摘要初版 |
| 原文相关片段与有界邻接扩展 | 后续优化；首版维持现有整楼原文升级，不假定邻接就是因果 |

事件能力的差别是：一个事件可关联多条、不连续的回合摘要，召回命中后按已确认关联补必要前因/结果，而不是简单增加一层压缩摘要。无需为此先部署图数据库。原计划还多出独立档案、稳定版本/分支与跨聊天继承，并非只多一张事件表。

为缩小工程范围，建议首版仍由柏宝书生成摘要和维护聊天内实体/状态；Mnemosyne 接收已存在及新增摘要，并接入可复用的检索链。独立摘要生成器、完整实体引擎与事件自动识别均非本次前置。

同一类内容只能有一个主动注入者。当前知识库和摘要召回同处 `runVectorRecall`，交接召回归属时应拆清类别开关或统一接管该链，不能简单关闭整个柏宝书向量模块后又声称知识库保留不受影响。当前时间/地点和实体注入继续柏宝书；不要再由 Mnemosyne 重复发送。

## 5. 逻辑存储结构：保持契约，物理实现可替换

以下是面向讨论的分组，不是要求把每个概念机械拆成一张 SQL 表。06 v0.3 对象的字段/引用/版本规则仍是权威，不能在 schema_version=1 中静默加未知字段。

| 逻辑数据组 | 保留的正式字段/关系 |
| --- | --- |
| 故事与分支 | `story_id,branch_id,head_snapshot_id,fork`；fork 固定父快照/前缀，而不是仅记录分叉楼层号 |
| 正文身份与版本 | SourceMessage 的 `message_id,story_id`；SourceRevision 的 `revision_id,message_id,role,content,content_fingerprint,provenance` |
| 顺序与宿主映射 | HistorySnapshot、manifest 有序 SourceRef；HostBinding 的 `binding_id,host_kind,host_scope,stable_id,mutable_ref,binding_generation,intent,message_map` |
| 摘要/回合记忆 | `memory_id,memory_revision_id,story_id,basis_snapshot_id,kind,origin,content,input_refs,coverage,recipe_id,model_profile,input_fingerprint,visibility,recall_enabled,source_declaration,scope_branch_id` |
| 分支当前选择 | memory view 的 `version,selections,corrections`；有效性按分支/视图计算，不在共享摘要上写全局 invalid 标记 |

所有对象保留各自 `schema_version` 和契约要求的显式字段/null 语义。普通新增回合仍按相邻 User+Assistant；不支持配对的源消息完整归档，不伪造回合。楼层号和剧情时间是显示/来源信息，不当主键或唯一排序依据。

### 建议增加的版本化补充记录（待冻结）

| 补充对象 | 建议最小字段 |
| --- | --- |
| 摘要显示元信息 | `schema_version,memory_revision_id,level,story_time_start,story_time_end,display_anchor`；没有证据的字段明确缺失，不从名称猜层级 |
| 索引投影 | `schema_version,projection_id,target_kind,target_revision_id,scope,document_hash,index_version,embedding_profile_id,dimensions,vector`；词法投影另记录 tokenizer/index 版本；都是可重建资料，不是原文权威 |
| 兼容审核 | `schema_version,review_id,story_id,branch_id,memory_revision_id,target_snapshot_id,source_changes,decision,created_at`；source_changes 显式记录旧/新 SourceRef；只在限定来源变化下允许使用，不无限继承审核 |
| 迁移包清单 | 格式版本、库身份、固定导出检查点、对象计数/校验和及包含的模块；复用已定领域校验，但不假装新 provider 文件与旧 TT 物理恢复包二进制兼容 |

上述新增结构须在正式定档时规定必填/null、引用校验、有效性和导出/恢复语义；当前 06 校验器尚不支持这些补充记录，不把此表写成“已经实现”。索引中的 cosine/BM25/RRF/rerank 分数不作为长期事实，分数留在单次检索诊断。

旧柏宝书摘要没有完整生成来源时仍标明声明来源/未证明，不能仅凭导入时同楼原文相等就补造当时实际 input_refs。纳入自动召回需使用明确的旧资料参考/来源声明策略，不能绕过既有范围校验或伪装成已验证当前事实。

物品/人物/组织/设定、变量、眼下局势不新增数据库表；事件本轮也不要求建表。知识库沿用已有模块，未迁入 Mnemosyne 的模块必须在备份说明中列为“不包含”。

## 6. 实现途径建议与跨设备边界

**手机优先建议：独立 Dexie/IndexedDB provider + Mnemosyne 领域契约 + 版本化导出/恢复。** Dexie 是成熟 IndexedDB 封装而非跨后端适配器；TT/ST 的领域数据一致，通过自己的 HostAdapter/StorageProvider 隔离宿主。分批写入、每批事务和最终发布指针需保持一致；网络/模型调用不放在数据库事务里，不复制当前高放大的目录协议。

此路线的跨端含义是相同逻辑材料可导出到另一宿主/设备后继续使用，不是两个本地 IndexedDB 自动同步，也不宣称与 TT TriviumDB 文件互读。沿用单权威写入、明确设备交接；需做持久存储状态检测、空间错误处理和用户可用的恢复入口。持久存储申请未获准时应提示备份需求，不能承诺永不清理。

**真正多设备访问同一库的建议：小 VPS 单应用服务 + HTTPS 鉴权接口 + SQLite。** 数据库只由服务进程读写，不通过网盘/网络文件系统共享正在使用的 SQLite 文件；沿用同一身份/来源格式。此路线需要部署/备份/访问控制，是替代首版路线或后续升级，不与手机本地多主自动合并绑在一起。

TT provider 保留为既有兼容路线；其高放大问题在未修复前不作为日用默认。手机原生 SQLite 是否能被扩展直接调用须核对宿主公开能力，本轮未验证，不以“手机操作系统有 SQLite”推导“TT 插件已能直接使用”。

## 7. 一个后续任务的建议完成线

完成线建议是：可安装入口；正文/摘要分批入库与增量更新；复用现有检索和原文升级；单一召回注入者；重开/切聊天不串库；编辑及 swipe 的旧结果不误用；可在另一独立档案实例恢复并保留身份；明确展示缺失来源、索引滞后、容量和未完成状态。

不增加完整事件链、实体数据库、多主同步、自动维护/GC、全套新摘要引擎或新重型服务器。TT 旧物理库导出后必须经验证的逻辑迁移，不能静默替换正在使用的 provider 或覆盖旧库。没有恢复路径的“只有导出”不算跨设备完成。

真正待确认只有产品选型：首版采用本机可迁移库，还是直接部署跨设备共用的 VPS 库；以及是否按本文建议把事件链和独立摘要生成后置。其余本轮用户已明确的实体/状态边界不反复询问。正式卡发布前给实现与测试代码量估算；这轮不填虚假的实现/实机验收结果。

## 8. 核验来源

仓库内：`README.md`、`AGENTS.md`、`stages/S-B-archive-and-search.md`、`docs/01-architecture.md`、`docs/06-contracts.md`、`docs/09-storage-provider-and-recovery.md`、`docs/12-edit-review-policy.md`、`apps/manual-search/README.md`、`notes/manual-search-demo-0.1.2-review.md`、`evals/manual-search-demo/0.1.1-synthetic-cost.json`。

柏宝书固定版本源码：
- [聊天持久化与派生视图](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/store.ts)
- [结构化重放](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/apply.ts)
- [数据类型](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/types.ts)
- [状态和历史注入](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/inject.ts)
- [IndexedDB向量存储](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/vector/store.ts)
- [知识库](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/vector/knowledge.ts)
- [召回接线](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/vector/recall.ts)
- [融合与额度](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/vector/hybrid.ts)

成熟工具与边界：[Dexie](https://dexie.org/docs/Dexie.js)、[IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)、[存储持久性与配额](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)、[SQLite适用场景](https://www.sqlite.org/whentouse.html)。
