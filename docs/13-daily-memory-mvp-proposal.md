# 日用记忆初版：本机可迁移库与柏宝书渐进改造

更新：2026-09-23。状态：下文第1节选型/产品范围为用户已确认需求；具体新字段、存储迁移实现及事件算法仍为 proposed。未施工、未验收，不是 T-06/T-07 正式任务卡。

当前阶段入口：`../stages/S-daily-baibai-mvp.md`。事件设计见 `14-event-chain-mvp-proposal.md`。本次只改工程文档，没有修改柏宝书分支实现、运行测试、调用付费模型或操作用户设备。

## 1. 本轮已确认：不再重复询问

- 首版做 **本机可迁移库，使用 IndexedDB**。不先部署 VPS，不要求与 TT TriviumDB 的物理文件互读，不做离线多主自动合并。跨设备先通过明确导出/恢复和单权威设备交接。
- 实施位置可以直接是用户的 `Roballz/ST-BaiBai-Book` / `codex/item-keywords-presence` 分支。**扩展前端、摘要/状态生成及成熟召回体验仍以柏宝书为基础**，按需更换数据库结构、入库、对象名和接口；不是同时开发第二套独立前端/摘要器。待日常实机稳定后再改为 Mnemosyne 专用前端、增加其他功能。
- **事件记录、事件表、事件链召回进入初版**，不再按旧建议后置。事件页可折叠事件，展开显示有序摘要/楼层来源，默认短预览，支持用户手动关联。用户提出以“一到两句概述 + 命中记录 + 最新进展”而非整条长链注入；具体规则见14，仍是方案讨论。
- 现有 LLM Query、多查询向量、BM25、RRF、rerank、原文升级、BM25/RRF 摘要额度与独立知识库额度/阈值继续保留，能复用就复用，不重新调一套算法。
- 物品、地点、生活小档案及当前时间/地点继续使用聊天内记录/重放模式。人物/组织/设定沿用该模式不代表本轮必须启用用户未使用的角色记录；不建设独立实体/变量/眼下局势数据库。
- **用户已明确反馈：目前 TT 手机版 + 该柏宝书分支日常使用正常、流畅。** 这是用户实际体验事实，不需要用旧 Demo 反证；新增存储和事件模块仍待实现后实测。

历史调整：`c81feea` 初稿中的“事件链后置”“仅独立接收入库、以后再考虑沿用整个前端”“本机还是VPS待选择”已由上述确认取代；原稿保留于 Git 历史。初稿 Dexie 推荐不作为强制依赖，原生 IndexedDB 或封装库是实现细节，不能因改三个数据表就默认换栈。

## 2. 当前进度及旧 Demo 的准确边界

Mnemosyne 的 S-A、T-04/T-05 身份/版本、受控存储、只读导入和手动搜索已有验收；另有 `apps/manual-search` 0.1.2 Demo。它们不是本次柏宝书渐进改造已经实现的证据；本次不是必须先完成旧 T-06/T-07 全部范围才可进入日常试用。

旧 Demo 的高放大证据是 `evals/manual-search-demo/0.1.1-synthetic-cost.json`：27条、8927字符，80315次get、31258次put，明确标记 node-map-not-native。这是 **旧 Demo/Mnemosyne 特定分页目录实现的问题**，不是 IndexedDB 或柏宝书聊天内存储模式的问题，也不证明 TriviumDB 本身性能差。该 Demo 效率修复不作为本次开工前置，不原样搬其物理协议。

TT 原生 B provider 和既有恢复协议保留原验收范围，不在本次删除、降级或冒称新库可二进制兼容。复用的是已确认的 Story/Branch/来源/版本语义，不是必须照搬所有旧 Demo 存储实现。

## 3. 柏宝书源码核验事实

2026-09-23 再核对分支头仍为 `393873acd27906a09308ae65fe7e636a3d3941ab`。源码核验不等于已验证新增功能，更不需要否定用户手机已流畅使用的报告。

| 数据 | 实际持久化位置 | 使用方式 |
| --- | --- | --- |
| L0 摘要与结构化变更 | `chat[i].extra.bbs_leaf`，摘要 `text`、变更 `delta` | `saveChat()`；有效叶子按聊天楼层顺序重放 |
| 高层摘要 | `chat_metadata.baibai_book.summaries`，含 `level,childIds` | 组织压缩文本，不承担实体 delta 重放 |
| 当前实体/状态视图 | Vue `memory` 派生镜像，不是独立实体持久数据库 | `deriveMemory` → `recomputeDerived` → 状态文本 → `setExtensionPrompt` |
| 本地摘要向量 | IndexedDB `bbs_vec_local` v1 / `items`；主键 `[database,scope,leafId]`、索引 `by_scope=[database,scope]` | `docHash,payloadHash,vector,dim,document,mesFull,storyTime,msgIndex`；document是摘要索引文本，mesFull为可空原文副本，不是全部聊天档案 |
| 知识库 | IndexedDB `bbs_knowledge_files` v1 / `files`，主键id、索引database | `id,database,name,delimiter,chunks,enabled,embedding,revision`；向量在前一库的 `knowledge:<fileId>` scope |

摘要向量可走柏宝库后端，本地降级按scope做JS余弦检索。新增知识库直接用localStore，不能因为装了后端就说它自动上云；知识库文件/块不在聊天文件备份内。

`hybrid.ts` 已有向量家族内max融合、向量/BM25两榜RRF及“原文→BM25摘要→RRF摘要→向量摘要”的去重补位。保留真实rerank分数，无执行时不以cosine/RRF冒充。

`engine.ts`、`prompts.ts` 已有历史摘要和状态输入以及结构化输出接线，适合在同一摘要请求增加事件操作。现有长期记录规则排除一次性事件，新增事件字段须有独立规则，单楼/批量/自定义提示词都需照顾；不是加了字段后模型自然会正确判链。

## 4. 数据权威与兼容改造建议

新正式库负责正文版本、摘要版本、事件和跨端身份；聊天内物品/地点/生活档案delta继续按用户确认方式保存和重放。旧`bbs_leaf`和metadata可作为兼容输入/输出，不默认全局替换所有bbs字段或破坏旧档读取。

同一正文/摘要变更通过统一入口落到正式库，再供旧前端的兼容适配读取；不能让聊天副本和新库各自独立决定不同的当前摘要版本。跨聊天文件与IndexedDB没有一个共同事务，需明确源写入/归档回执和可重试状态；不声称“同时saveChat和put”就是原子提交。

建议新库使用明确版本和独立命名，旧库先读不删；迁移校验完成后显式切换活动库。升级涉及新object store/index时用IndexedDB版本升级；新对象放自己的版本化模块，不在现有schema_version=1中偷偷添加未知字段。Dexie可选，不是产品选型的新待决项。

一次事件更新的事件版本/关联/当前指针应在同一新数据库的有界事务内发布；网络请求在事务外完成。只有明确受影响范围读写，事件表不每次复制全链全文，搜索和列表分页。原有可重建向量索引按实际模型身份、维度和文本指纹决定复用，不能仅维度相同就认定向量可比。

保留单一摘要/状态生成流程和单一召回注入者。知识库与摘要召回当前共用runVectorRecall，不能为了接管摘要召回把知识库一起误关，也不并行开启原柏宝书与第二个Mnemosyne注入器重复发送。

## 5. 逻辑字段基线

以下是数据组，不要求一概念机械对应一张SQL表。06 v0.3的正式规则继续约束身份/版本/来源；为当前改造新增的模块还需独立版本与校验。

| 数据组 | 字段/关系 |
| --- | --- |
| 故事与分支 | `story_id,branch_id,head_snapshot_id,fork`；固定父快照前缀，而非只存分叉楼层 |
| 原文身份与版本 | SourceMessage：`message_id,story_id`；SourceRevision：`revision_id,message_id,role,content,content_fingerprint,provenance` |
| 顺序与宿主映射 | HistorySnapshot及有序SourceRef；HostBinding：`binding_id,host_kind,host_scope,stable_id,mutable_ref,binding_generation,intent,message_map` |
| 摘要与回合记忆 | `memory_id,memory_revision_id,story_id,basis_snapshot_id,kind,origin,content,input_refs,coverage,recipe_id,model_profile,input_fingerprint,visibility,recall_enabled,source_declaration,scope_branch_id` |
| 分支记忆选择 | `version,selections,corrections`；有效性相对分支/视图，不在共享摘要写全局invalid |
| 事件模块 | 稳定EventChain、摘要版本关联/变更、EventRevision；细节见14，未声称现有Event契约已支持累计更新 |

普通回合按相邻User+Assistant；特殊消息仍完整归档、不伪造回合。显示楼层与剧情时间不作永久主键，来源顺序与剧情日期分开。旧摘要无完整生成证据时用来源声明，不把导入时同楼原文当成已知的全部生成输入。

建议版本化补充元信息：摘要`level,story_time_start,story_time_end,display_anchor`；索引`target_revision_id,document_hash,index_version,embedding_profile_id,dimensions,vector`，词法另记tokenizer版本；兼容审核保存`review_id,story_id,branch_id,memory_revision_id,target_snapshot_id,source_changes,decision,created_at`。这些字段需正式定义必填/null和引用检查，不代表06校验器已经接受。

物品/人物/组织/设定、变量及眼下局势不新增实体表。对象名统一只改新模块和必要接口，旧数据字段保留兼容；不把品牌全量重命名混入首版稳定性任务。

## 6. 初版召回与完成线

初版：既有混合召回/原文升级/独立知识库；正式正文/摘要档案；明确同故事同分支继承；编辑/swipe/截止过滤与摘要审核；事件页、事件判链/概述更新、有界事件召回。

事件首版目标是关联索引，而不是复杂因果图。用户方案采用“命中记录+短概述+至多一条额外进展”，同链去重并服从全局预算；当前范围的概述和进展必须同样排除未来/其他分支。不能只过滤成员而泄露未来版概述。事件细则和默认数字仍是14的建议。

建议一个后续任务收尾：沿用柏宝书的可安装分支；正文/摘要增量入库；新回合自动建/续事件、人工改关联；事件补充注入受控且不重复；重开/切聊天/swipe/编辑不串档；另一独立设备/实例导入后保留身份和关系。用户实机日常测试后再推进专用前端。

旧摘要不默认全库付费重摘或补事件。建议新回合先启用，旧资料允许人工关联/显式分段补建；补事件不重复应用旧状态delta。已有受控验收不重复跑作本轮前置，新增实现的测试预算在正式卡内给出。

## 7. 可迁移库不是自动同步

导出包应保存固定检查点、schema/format版本、正文/摘要/事件/映射及计数/校验材料；恢复到新库先校验再切换，不能只有导出按钮就宣称可迁移。保留原设备资料直到用户确认交接，不自动合并两端冲突。

需明确包内模块清单：聊天内delta、宿主聊天文件、知识库原始块、可重建向量及非秘密配置是否包含。仅导出Mnemosyne正文/摘要/事件不等于柏宝书完整体验备份；未包含的聊天delta应随宿主聊天备份迁移，知识库需有对应迁移路径，不能悄悄遗漏。密钥不默认写入普通明文迁移包。

TT物理B库如需迁入，必须经过明确逻辑转换与校验；不替换旧实验库、不把两套物理文件称为兼容。手机存储容量、后台中断及新模块性能以新增实现的有限实测为准，不承诺永不清理或零故障。

## 8. 尚待收口与授权

不再询问本机还是VPS、是否沿用柏宝书前端、是否把事件链放进初版，这三项已确认。剩余是14中的事件粒度/候选范围/不确定归组/概述更新与注入预算，以及新schema和迁移校验的具体落地。

本轮不生成正式任务卡，不写实现代码。发布实现卡前分别预估实现与测试行数；取得相应施工授权后再改柏宝书。用户计划亲自实机日常测试不等于授权本助手访问、清理或批量重写手机私人档案。

## 9. 来源

仓库内：`AGENTS.md`、S-A/S-B最终回执、`docs/06-contracts.md`、`docs/12-edit-review-policy.md`、`apps/manual-search/README.md`和合成cost记录；原方案版本`c81feea`保留历史。

柏宝书固定版本：
- [聊天存储/派生](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/store.ts)
- [类型](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/types.ts)
- [注入](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/inject.ts)
- [本地向量库](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/vector/store.ts)
- [知识库](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/vector/knowledge.ts)
- [混合配额](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/vector/hybrid.ts)
- [摘要引擎](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/engine.ts)
- [提示词](https://github.com/Roballz/ST-BaiBai-Book/blob/393873acd27906a09308ae65fe7e636a3d3941ab/src/memory/prompts.ts)

平台边界：[MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)。同一库事务可指定多个object store，schema升级有独立版本流程；不推导成聊天文件/跨数据库事务或自动跨设备同步。
