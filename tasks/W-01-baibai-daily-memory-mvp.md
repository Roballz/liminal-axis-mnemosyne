# W-01 柏宝书基线的 Mnemosyne 日用记忆 MVP

状态：**implemented_unverified**（实现与有限自动测试完成；等待 Chat review + 用户 TT 手机实测。实施回执见 `../notes/w-01-final-review.md`。原用户施工授权保持有效。）
目标分支：`work/daily-memory-mvp-baibai`
目标仓库：`Roballz/liminal-axis-mnemosyne`
源代码基线：`Roballz/ST-BaiBai-Book@393873acd27906a09308ae65fe7e636a3d3941ab`（分支 `codex/item-keywords-presence`）
日期：2026-09-23。

> 本任务是当前“日用初版”支线，不是旧 T-06/T-07 自动开工。产品语义以 `docs/13-daily-memory-mvp-proposal.md`、`docs/14-event-chain-mvp-proposal.md` v0.2、`docs/15-event-batching-and-local-tables.md`、`stages/S-daily-baibai-mvp.md` 及现有 06/08/12 契约为准。冲突时用户最新确认优先。

## 0. Work 开工要求

先读取本卡、`AGENTS.md`、上述 13/14/15/stage 文档，再核对目标分支和源基线 commit。

开工第一条回执必须包含：
- 实际目标分支/HEAD、源基线 SHA、工作树状态；
- 计划修改/新增的主要模块；
- **实现代码预计约 3,500～6,000 行，测试预计约 900～1,800 行**；若审阅源码后偏差超过约 30%，说明原因并给新估算；
- 有限验收清单。

用户已经授权本任务施工。完成上述回执后，在没有真实架构冲突、权限问题或不可逆迁移风险时**直接连续实施到完成线，不要再次等待批准**。

不要调用用户真实付费模型或读取用户真实聊天做自动测试。LLM 路径用 fake/stub/固定响应测试；实机手机行为留给用户验收。

## 1. 代码基线和仓库布局

### 必须做

1. 本分支从 Mnemosyne `main` 开出，保留已有 `docs/`、`tasks/`、`stages/`、`packages/` 等项目资料。
2. 把柏宝书固定基线 `393873a...` 的扩展工程作为实现底座引入本分支，至少包括构建所需 `src/`、`scripts/`、`package.json`、lockfile、tsconfig、Vite 配置、`manifest.json`、必要静态资源/构建产物规则。
3. 为方便 TT/ST 通过 Git URL 安装，本分支最终必须在仓库根部形成**可安装扩展布局**（根部有有效 `manifest.json`，构建/发布后的入口路径有效），不能只把扩展藏在一个 TT 无法从仓库 URL 安装的子目录里。
4. 保留一份 `notes/baibai-upstream-base.md`，记录源仓库、源分支、固定 SHA、导入日期和主要偏差，方便以后继续同步上游。
5. 扩展显示名、数据库命名空间、注入 key 使用 Mnemosyne 独立名称，避免静默覆盖现有柏宝书本地数据库和 prompt key。兼容读取旧 `bbs_*` 数据可以保留，但不得主动迁移后删除旧数据。
6. 明确 README：测试本分支时建议停用原柏宝书，避免两个扩展同时摘要/注入；不能把“可同时安装”写成“可同时启用”。

### 不做

- 不把旧 Mnemosyne manual-search Demo 的物理分页协议搬进本任务。
- 不先重写一套新 UI；保持柏宝书现有前端为主，只增加必要页面/设置。
- 不部署 VPS、不做多主同步、不依赖 TT TriviumDB 文件互读。
- 不删除/覆盖主分支历史资料。

## 2. P0 要求列表

### R1. 本机可迁移 Canonical IndexedDB

新增独立 Mnemosyne IndexedDB，作为**正文、摘要、事件、自定义表**的正式本机库。原柏宝书聊天 delta 仍负责现阶段物品、地点、生活小档案、当前时间/地点等状态，不强制搬入新库。

建议 store（具体命名可调整，但语义不得缩水）：
- stories / branches；
- source_messages；
- source_revisions；
- history_snapshots 或等价的有序当前视图；
- host_bindings / message mappings；
- memories；
- memory_revisions；
- event_chains；
- event_memberships；
- event_progress；
- event_processing_receipts；
- custom_table_defs；
- custom_table_rows；
- library_meta / settings；
- 可重建索引投影如需新增，必须与事实层分离。

要求：
- ID 由 Mnemosyne 自己生成；TT 文件名、楼层号、host stableId 仅作为映射/provenance，不作永久主键。
- edit/swipe/regenerate 形成 Revision/当前选择，不原地抹掉历史正文。
- 同一 Branch 的“当前有效视图”和历史版本分开；查询必须有截止点。
- 楼层/来源顺序和剧情时间分开。
- 网络/LLM 请求在 IndexedDB 事务外；同库关联更新在有界事务内发布。
- 不把“聊天 saveChat + IndexedDB put”宣称为跨存储原子事务；要有可重试/待同步状态。

### R2. 正文与摘要增量入库

保留柏宝书现有摘要生成体验，但摘要落盘后同步写入 Mnemosyne 正式库。

正文：
- 当前聊天的 User/Assistant 正文进入 SourceMessage/SourceRevision；
- 当前选中 swipe 是有效 Revision；
- edit/swipe/regenerate/delete 后更新当前视图；
- 旧 Revision 默认不参与普通召回，但保留历史。

摘要：
- L0 与现有高层摘要均能映射成 memory/memory_revision；
- 保存实际来源 input refs / coverage；旧数据来源证明不足时标 source_declaration/unknown，不补造；
- 原文升级从 canonical SourceRevision 读取；找不到时才按兼容路径降级。

幂等：
- 已有 host binding + 同 revision fingerprint 不重复写；
- 不能只用“内容 hash 相同”证明跨来源是同一 SourceMessage。

### R3. 保持现有混合召回质量

必须尽量直接复用柏宝书源基线已有：
- LLM Query；
- 多 query 向量家族 max 合并；
- BM25；
- 向量/BM25 两榜 RRF；
- rerank；
- 原文升级；
- 原文 → BM25 摘要 → RRF 摘要 → 向量摘要补位；
- BM25/RRF 摘要 top-k 配额；
- 独立知识库额度与 embedding 阈值。

本任务不是重新发明检索算法。主要改**数据 adapter、ID、来源和过滤**。

过滤至少包含：
- story/branch；
- 当前 snapshot/head 截止；
- 当前有效 revision；
- recall_enabled / visibility；
- 旧结果返回前再核对 run/view 版本。

知识库功能继续可用，不因为接管摘要召回而一起关闭。

### R4. 事件表与事件链

初版必须实现事件页。

UI：
- 事件卡默认折叠；
- 展示标题、状态、累计概述短预览、关联数、最近进展；
- 展开分页显示关联摘要，默认每条约 50～100 字；
- 可查看完整摘要/来源；
- 用户可以手动加入/移除关联、修改标题/状态/关键词；
- 人工锁定关联不能被 AI 静默撤销。

数据：
- 一条摘要可关联多个事件；
- EventMembership 保存实际 memory_revision_id；
- 事件概述正文**只追加，不覆写历史段**；
- title/status/keywords 是可更新元信息，与追加叙事分开；
- 同一批同一事件涉及 5 条摘要，可追加 1～2 句进展，但 5 条 membership 全保留。

### R5. 独立事件 LLM 批量整理

事件任务与每回合摘要解耦，首版必须有独立入口。

设置：
- enable/disable；
- interval：用户可配，默认可先取 40；用户举例 30/50；
- optional delay：默认小值或 0，需 UI 说明单位；
- 手动“补齐未整理范围”。

任务输入：
- 本批正文/摘要及其稳定 ID；
- **当前合法 story/branch/截止范围内的全量事件目录**：event_id、标题、累计概述、状态、关键词；
- 事件专属提示词；
- 不附物品/人物/变量结算规则，不重新生成摘要。

全量目录超上下文预算：
- 明确显示“事件目录过大/任务暂停”；
- 不能偷偷只取 6～10 个候选事件；
- 不能暗中删旧事件。

处理进度：
- 借鉴 yuzuki 的“指针 + 批量 + 成功后推进”，但不能只靠最大楼号；
- 保存 event processing receipt，记录实际处理的摘要 ID/revision、范围、输入指纹/操作 ID、结果；
- 明确判断“本批无事件”时也要写 success receipt 并推进；
- 解析失败、字段缺失、保存失败都不能冒充“无事件已处理”；
- 删除/edit/swipe 导致来源失效时，能标出需重查范围，不假称旧指针仍完整。

### R6. 事件判断规则

默认事件提示词必须贯彻：
- 围绕一个具体事项、目标、约定、冲突或重要变化归组；
- 同人物/地点/物品/时间接近本身不等于同事件；
- 已有事项的新行动、结果、转折、新证据加入旧链；
- 独立事项才新建；
- 单纯重复提及可以 reference，不冒充 progress；
- 没有值得追踪事件可以明确 none；
- 证据不足返回 needs_review，不编造旧 ID/动机/结局；
- AI 只能引用程序提供的合法旧 event_id；新 ID 由程序生成。

### R7. 事件召回扩展（三条规则已冻结）

事件包装发生在原召回候选最终选中之后，不改变前面的 BM25/向量/RRF/rerank。

**规则 1：每条链最多额外补一条进展。**
- 命中本身就是最新进展、已在其他召回块、或已在近期全文窗口时，不重复。

**规则 2：同链多个命中只包装一次。**
- 一份链名/位置/概述节选 + 至多一份额外进展。
- 不因为归链机械删除原本正常入选的有效召回结果。

**规则 3：同一历史范围。**
- 概述节选、最新进展、成员总数、链内序号必须基于同一个 story/branch/snapshot cutoff；
- 禁止旧回溯请求读取未来概述或未来 membership。

概述长期只追加，因此召回不能默认塞整份事件简史。首版实现**有界节选**：
- 优先保留事件起始段（若有）；
- 加命中关联所在 progress 段；
- 可再加当前截止范围的最近一段，若预算允许；
- 去重、设字符/token 上限；
- UI 明确它是“事件概述节选”，不是完整全链总览。

事件扩展额度独立配置并计入总上下文。建议默认最多扩展 2 条事件链、每链额外 1 条摘要；做成设置，不写死成领域规则。

### R8. 本地自定义表

初版实现本机自定义表，不要求后端同步。

底层不要每创建一张用户表就升级 IndexedDB schema；使用固定 store：
- custom_table_defs；
- custom_table_rows。

表定义最小字段：
- table_id、name、description；
- columns[]：column_id/name/type/description/update_mode；
- update_mode 至少支持 replace / append / manual；
- ai_enabled；
- created/updated/version。

首版 UI：
- 新建/重命名/删除表（删除需确认）；
- 新建/编辑/删除字段；
- 手工增删改行；
- 搜索/分页；
- 设置是否允许 AI 填写。

AI：
- 至少提供“对选定聊天/摘要范围手动填充选定自定义表”的入口；
- 输入表定义 + 当前已有行 + 选定范围；
- AI 只能按 schema 输出增量操作；
- manual 字段不得被 AI 修改；
- 无有效变化也允许明确完成，不反复补跑。

自动按 N 楼周期填写自定义表不是 P0 硬要求；若复用事件调度成本很低可做，否则记录为后续，不阻塞本任务收尾。

### R9. 导出 / 恢复

必须有可迁移闭环，不是只有 export。

导出包至少包含：
- format/schema version；
- story/branch；
- canonical 正文/摘要；
- event chain/membership/progress/receipts；
- custom table defs/rows；
- host mappings/provenance；
- 对象计数和基本完整性校验。

不得导出 API key/secret。

知识库：
- 如果本任务能低风险加入，可提供“包含本地知识库原始文件/区块”的选项；
- 否则导出 UI/README 必须明确“知识库不在核心包内”，不得假称完整柏宝书体验已经全部迁移。

恢复：
- 导入到空的新 Mnemosyne IndexedDB；
- 先验证格式/引用/计数，再切换 active library；
- 失败不覆盖当前活动库；
- 导入后正文/摘要 ID、事件关联、progress、custom rows 保持一致。

向量索引可以作为可重建数据：未导入向量时能按现有 embedding 设置重新建立；不要因为缺 vector 破坏 canonical 事实。

### R10. UI 与兼容体验

尽量不改现有柏宝书日常交互。

新增建议入口：
- 设置页增加“Mnemosyne 档案/迁移”；
- 新“事件”页/tab；
- 新“自定义表”页/tab；
- 事件批量任务进度/补齐按钮；
- 导出/恢复。

继续保留用户当前实际使用的：
- 物品；
- 地点；
- 生活小档案；
- 当前时间/地点默认注入；
- 知识库；
- 混合记忆召回。

眼下局势、变量、角色记录不要求为本任务重构或增强。

## 3. 实现流程

### W0 — 基线移植和独立命名
- 固定两个仓库/commit；
- 导入柏宝书工程；
- 构建原基线，确认未改逻辑时能通过既有检查；
- 修改 manifest/display name/namespace/prompt keys；
- 保留旧 `bbs_*` 兼容读取；
- 记录 upstream base。

**W0 收尾：** 本分支能构建出可安装扩展，尚未启用新库也不应破坏原基线主要功能。

### W1 — Canonical IndexedDB 与迁移包骨架
- 实现 DB open/upgrade、schema、repo API；
- stories/branches/source/memory/host mapping；
- export/import 骨架与校验；
- 单元测试事务、幂等、失败不切 active。

**W1 收尾：** fake 数据可 round-trip；不接 LLM。

### W2 — 正文/摘要接线
- chat 当前视图 → SourceRevision；
- 摘要完成 → MemoryRevision；
- edit/swipe/delete 更新当前视图；
- 旧柏宝书数据首次读取时懒迁移/兼容映射；
- 记录 pending/retry，不做跨存储原子假设。

**W2 收尾：** Node/fake 能证明新增、编辑、swipe、重开不重复，旧 Revision 不参与当前召回。

### W3 — 召回 adapter
- 把摘要/原文数据源切到 canonical adapter；
- 保留现有 query/BM25/vector/RRF/rerank 配额和知识库；
- run/snapshot 结果返回前复核；
- 原文升级读取 SourceRevision。

**W3 收尾：** 固定合成数据上，迁移前后候选排序/额度语义不出现无理由回退；差异需解释。

### W4 — 事件模型、UI、独立批处理
- event stores/repo；
- 事件表 UI；
- 全量目录 prompt；
- interval/delay/manual backfill；
- receipts 与失败恢复；
- append-only progress；
- 人工关联/锁定。

**W4 收尾：** 新链、续链、同楼多事件、none、needs_review、保存失败、重开续跑均有测试。

### W5 — 事件召回包装
- 从最终命中的 memory 找 memberships；
- 同链去重；
- 有界概述节选；
- 最多一条额外进展；
- cutoff/version 复核；
- 独立预算。

**W5 收尾：** 长链不会灌入全部成员；旧截止点不泄露未来 progress。

### W6 — 自定义表
- defs/rows store；
- UI CRUD；
- 手动 AI 填选定表/范围；
- schema 验证和 update_mode；
- 导出/恢复纳入。

**W6 收尾：** 无需改 IndexedDB version 就能新增用户表；manual 字段不会被 AI 操作。

### W7 — 安装产物与有限回归
- 最终 build；
- 只跑受影响测试 + 一次最终全量测试；
- 生成 TT/ST 可安装产物；
- README 写清测试安装、与原柏宝书不可同时启用、数据包边界和回退；
- 记录 `notes/w-01-final-review.md`。

完成状态只能写 `implemented_unverified`，等待 Chat review + 用户 TT 手机实测后才可 verified。

## 4. 必测反例

至少覆盖：

1. 同文本出现在不同消息/不同分支，不因 hash 相同合并身份。
2. edit 旧楼后创建新 Revision；旧摘要按既定审核/有效性规则退出或待审。
3. swipe A→B 后 recall 不再返回 A；切回 A 时能恢复对应历史版本而不是复制一条新消息。
4. delete 后当前视图不召回已删正文/摘要；历史材料未被静默硬删。
5. 两次同步相同当前聊天不产生重复 canonical 对象。
6. 摘要写成功但 canonical 同步失败：显示 pending，可重试；不能假称已完全归档。
7. 事件批次明确无事件：receipt success，进度推进。
8. 事件解析失败/保存失败：进度不推进。
9. 一批 5 条摘要都属于同事件：5 membership + 1 段 progress，不是只留 1 个 ID。
10. 同链多召回：只出现一次事件包装。
11. latest progress 已在近期全文：不额外重复。
12. 旧 snapshot 回溯：成员数、序号、概述节选、latest 全都不读取 cutoff 后材料。
13. 长事件 20+ membership：注入仍保持固定预算，不灌全链。
14. 自定义表新增字段不触发物理 DB schema upgrade。
15. custom manual 字段遇到 AI 操作时拒绝。
16. export→清空新实例→import：ID、正文、摘要、事件、custom rows 一致。
17. 坏包/引用缺失：恢复失败且原 active library 不被替换。
18. 知识库仍按独立额度工作；接管摘要召回不能误关 knowledge recall。
19. 原柏宝书停用后只启 Mnemosyne fork，不重复注入；若两个都启用，UI/README 明确提示风险而不是悄悄双注入。
20. 请求开始后 chat/edit/swipe 改变，迟到 recall/event 结果不得按旧 view 写入或注入。

## 5. 非目标

- 不做 VPS 服务。
- 不做自动多设备冲突合并。
- 不做任意事件之间的因果图。
- 不重建人物/组织/变量/眼下局势数据库。
- 不把自定义表扩成完整 Airtable/Notion 式无代码平台。
- 不自动全库付费回填旧事件。
- 不为测试调用用户真实付费 API。
- 不重跑旧 T-04/T-05 原生大循环或旧 Mnemosyne Demo 性能矩阵。

## 6. 数据和迁移安全

- 新 DB 使用新名字；旧柏宝书 DB/聊天字段默认只读兼容，不自动清理。
- 任何不可逆删除必须单独确认；本任务不得自动 purge 旧资料。
- export/import 在切 active 前先完整验证。
- 事件/自定义表/摘要的新格式都必须有 schema/format version。
- 索引是可重建派生物，canonical 正文/摘要/事件关系才是事实来源。
- 密钥不进导出包、不进仓库、不进测试 fixture。
- 不把用户手机当前柏宝书流畅体验冒充新增功能已验证。

## 7. 交付物

必须提交并 push 到 `work/daily-memory-mvp-baibai`：

- 可构建源代码；
- 根目录可安装 manifest/产物；
- 新 canonical IndexedDB 与 repos；
- 正文/摘要接线；
- 现有混合召回 adapter；
- 事件模型/UI/批量任务/召回包装；
- 本地自定义表；
- export/import；
- 新增及受影响测试；
- `notes/baibai-upstream-base.md`；
- `notes/w-01-final-review.md`；
- README 安装和实机验收步骤。

最终回执必须列：
- 实际 commit；
- 实现/测试实际新增修改行数；
- 测试命令与结果；
- 哪些仅 Node/fake，哪些需 TT 桌面/手机；
- 数据兼容/迁移影响；
- 已知限制；
- 用户手机最短验收流程；
- 回退方法。

## 8. 手机实测完成线（Work 只准备，不冒充执行）

用户在 TT 手机版最终至少验证：
1. 通过本分支 Git URL 安装并启用；原柏宝书停用。
2. 现有聊天打开后，物品/地点/生活档案、时间/地点、知识库、原混合召回仍工作。
3. 新聊若干回合后正文/摘要出现在 Mnemosyne 档案。
4. 触发/手动执行事件批量整理，事件页能看到链和成员。
5. 召回一个长链中间摘要时，只增加有界事件信息，不注入整链。
6. 新建自定义表，手动编辑并跑一次 AI 填表。
7. 导出，换到独立空库恢复，正文/摘要/事件/自定义表仍在。
8. 重启 TT 后仍能继续使用且不串聊天。

这些实机项由用户确认后，Chat 才决定是否从 `implemented_unverified` 升级。

## 9. 本轮手机反馈修订（2026-09-23）

用户已明确授权修复页面卡顿、补充按钮/事件设置说明并重做自定义表。最新要求覆盖初版 R8 的独立手动选摘要填表 UI：改为原生摘要同次调用携带定义、提示词与当前行，返回增量表格 JSON；表列表/设计页/行详情弹窗、锁定策略、长按多选和隐藏行按用户描述实现。默认档案/自定义表页面不再加载正文或摘要列表。

稳定行为补入 docs/15 第8节；使用说明为 `docs/daily-memory-user-guide.md`。本轮仍沿用原分支、原柏宝书固定基线，状态保持 `implemented_unverified`，不创建下一张正式卡。

## 10. 2026-09-24 分支选择反馈

沿用用户 W-01 授权：档案冲突页将内部 branch ID 输入改为当前角色已归档聊天的名称下拉菜单，优先选中继承来源；解释续聊、分叉及消息条数。不变更身份/分叉语义、不迁移 schema，不在选项加载时读正文或摘要。状态保持 implemented_unverified；验证见最终回执。

## 2026-09-24 用户确认修订：手动事件与正文补表修订

用户本轮明确要求覆盖此前自动归组方案：事件归属由楼层卡片手动选择；AI 仅创建用户指明的一条链，或更新已有链的概要/关键词。仅入库不调用模型，待更新成员可批量整理；旧自动归组入口停用，召回算法保持。当前概要可编辑并保留版本，追加进展继续服务原召回；确认删除时完整删除选定链的事件记录，不删除正文或摘要。

自定义表新增多表、可指定正文楼层范围的手动补表，独立于自动填表开关，按成功批次记录实际 SourceRef 与范围；重叠范围提示只补缺。导出逻辑包 v3，兼容读取 v1/v2，物理 IndexedDB v1 不变。档案页移除续聊与重复导航，分叉按钮改“继承档案”。详见 daily-memory-user-guide.md（docs 内）和 W-01 最终回执。状态仅 implemented_unverified，待 Chat review 与 TT 手机实测。

## 2026-09-24 楼层浮层与视觉反馈

按用户截图修复事件菜单被聊天容器裁剪；调整主次按钮（取消用暗色），完整摘要改为独占正文宽度、移除关联缩小。仅 UI / 交互修订，不改事件归组、召回或数据库格式。状态仍 implemented_unverified，有限验收和最终提交见回执。

## 2026-09-24 楼层反馈与概要精简

按最新用户要求，楼层事件成功/失败/超限改为确认关闭的弹窗，不占卡片下方空间；两个动作简称“立即更新 / 仅入库”。事件页删除最新进展块，概要新增500字上限与核心变化提示词，覆盖手动新建、手动/批量/自动更新及人工概要编辑。旧概要不自动改写，历史进展、召回和数据库格式保持。状态仅 implemented_unverified，实际测试及提交见最终回执。

## 2026-09-24 事件概要提示词编辑

沿用用户授权，在现有自定义提示词列表与编辑弹窗增加事件概要项，支持显示默认、草稿取消、保存、恢复默认；写入既有宿主设置，新建/立即更新/批量/自动事件请求全部读取。500字和输出协议仍保留，不自动重新生成历史概要。无新库格式/迁移，状态仅 implemented_unverified；验收包含设置回读、真实编辑器和请求接线。

## 2026-09-24 追加事件归档需求

用户在提示词编辑施工中追加事件归档：长按折叠卡片弹出归档操作，“新建事件”右侧提供归档入口，支持取消归档。按随后补充，归档页折叠卡片仅显示标题，展开显示原有详情和编辑/删除。归档只收纳主页，不影响召回、关联或概要更新。增加 EventChain 的 archiveSchema=1 标记，核心包升级 v4并兼容 v1～v3，物理库不升级；仅有界字段增补，无不可逆数据迁移。状态仍 implemented_unverified。新增验收覆盖长按/滚动取消、标题折叠、召回等价、在途概要保持标记、恢复与非法包。
