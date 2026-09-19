# T-02：身份、历史版本与上下文契约

状态：implemented_unverified（实现与本地测试完成，交 Chat review）

创建：2026-09-19。规划阅读基线：`dd62510852c840e8cc2510348bbc90fa6d284b72`；开工必须读取包含本任务及本轮确认的最新提交。

## 1. 用户目标与完成线

把已确认的 Story/Branch、原文版本、Head、回合记忆来源与 B→A 可迁移规则，转成一套**能运行校验、有正反例和状态转换测试的最小契约**。

交付：契约说明 + 机器可校验 schema/类型 + 最小纯逻辑参考模型 + 虚构 fixture/测试。不是完整记忆引擎、数据库、生产导入器、摘要算法或注入 UI。

T-02 收尾为 `implemented_unverified`，由 Chat review 后升 `verified`。文档确认/测试通过不等于真机存储或数据库恢复已经通过。

## 2. 前置与必读

- T-00、T-01、T-02A 已 verified；沿用其证据，不重做宿主实验。
- 先读 `AGENTS.md`、`stages/S-A-foundation.md`、README 当前状态。
- 规则依据：`docs/03-decisions-and-open-questions.md` 最新确认、`docs/08-history-snapshot-and-rebuild.md`，再读 `docs/06-contracts.md`、`docs/07-t02-contract-proposal.md`。
- 参考：`docs/01-architecture.md` 0～4 节、`docs/02-roadmap.md` T-02/T-03 段、T-02A 任务和运行记录的最终 review/补测段、`examples/`。
- 旧文档中的每楼 Leaf、生成身份由宿主提供、角色知情过滤、head_revision 临时例子等，不覆盖较新的用户确认。保留历史说明，更新当前规范和样例。
- T-03 预备卡仅是下游依赖参考，不能据此开工 T-03 或提前选定数据库。

## 3. 开工报告与范围

开工先报告 Git commit、分支、工作树、已读文档、预计修改文件、实现/测试/schema 各自预计行数、命令与验收办法。已有设备、路径、模型配置不重复询问。

Chat 粗估：类型/schema/校验及参考逻辑约 500～1000 行，测试/fixture 约 500～1000 行；这不是配额，不能为凑行数扩展。若计划出现生产同步器、持久化树、真实模型请求或明显越界，先停止相关部分并说明。

允许：`packages/contracts/`（或同等单一最小目录）、`examples/`、`evals/`、必要文档/测试入口；需要时添加最小 package.json 与锁文件。JS/TS 与校验库按实际环境选择并说明，不引入大型服务或生成空 monorepo。

禁止：修改 TT/ST/柏宝书、部署新扩展、读取/上传真实 RP、调用付费模型、实现正式后端/检索/LLM 重建、完整旧 JSONL 模糊对齐器、生产级块树/GC、创建下一张任务卡。现有探针原则上不改，既有测试继续通过。

## 4. 已确定的语义

### 4.1 正文与身份

- Mnemosyne 自己的稳定 ID；宿主 stableId/integrity、文件名、数组 index、Trivium NodeId 只作映射/来源，不作领域主键。
- Story 与宿主聊天分离；显式续聊可同 Story/Branch 跨文件承载，普通新聊天不自动继承；分支继承固定历史前缀。
- SourceMessage 与不可变 SourceRevision 分离；同一快照一个 message_id 不重复。相同文本的不同消息不能合并。
- 有效历史正文是已发生剧情的权威；人物/物品/关系/势力等为派生。大纲指令不是已发生事实。
- 普通派生单位为 User + Assistant 一轮一份，不为 User 单独摘要；原文仍分别归档。

### 4.2 Head（本轮用户已确认）

采用 `Branch.head_snapshot_id` → `HistorySnapshot` → `HistoryManifest`。

- snapshot_id 为 `hs_<UUIDv4>`，安全随机生成，小写标准格式；ID 碰撞不得覆盖。其他实体前缀建立集中清单，不把剧情时间/楼层编码进 ID。
- 快照字段依 `08`：schema_version、snapshot_id、story_id、branch_id、previous_snapshot_id、manifest_root_id、message_count、change_kind、operation_id、created_at。
- 清单是有序 `(message_id, revision_id)`，正文不嵌入快照；块及根也用内部身份。
- fork 固定 parent_branch_id/source_snapshot_id/prefix_length 与最后一项校验锚；继承端点包含在前缀中。空前缀合法且无末项锚。
- 子线创建自己的初始快照；父线改旧楼不影响子线。不自动开 Branch C，不自动合并分支。
- 新增/编辑/切 active 版本/删除/重排推进快照；回滚建新快照但可复用旧根；重复导入相同有效历史、重摘摘要、改名不推进正文 Head。
- 只在完整提交后发布 Head，要求 expected head；同操作重试返回同一结果。持久性实现归 T-03。

本任务需给出最小叶块/目录块 schema、逻辑展开与完整性校验（顺序、条数、引用、无环）；用小 fixture 验证结构共享和父子隔离即可。**不实现高性能持久化 B-tree/全套增删平衡，不固定块大小、扇出、缓存。** 这些参数留 T-03，但任一实现必须保留 T-02 的逻辑语义。

### 4.3 派生来源与有效性

- 只建轻量 `input_refs`（正文版本或下级派生版本）和 `coverage`，加规则/输入指纹；不建字段级角色状态依赖引擎。
- 概率模型实际读取了前文时，该前文也是同一份加工来源的一部分；未用的数据不凭想象加依赖。
- 变更回合 → 包含它的小总结/大总结/事件串及受影响累计状态逐层待重建；无关有效回合复用，有适用已有版本也可复用。
- 有效性相对于目标分支/快照/记忆选择视图，不在共享对象上全局 invalid。父线失效不能影响子线仍用的 R1。
- coverage 必须区分连续区间与明确成员集合，并保留当时成员、顺序及边界。区间中间新增消息也要更新，不能只检查旧引用仍在。
- 不把新插入项自动当作所有非连续事件的成员；标相关覆盖区间需重新核对，实际事件发现算法留后续。
- 从 User 楼分叉不能继承使用了下一条 Assistant 的完整回合摘要；跨 cutoff 的事件结果也不可带入。
- 只实现有效性判断和受影响对象/重建顺序的纯逻辑计划，不调用 LLM 或真的重建状态数据库。

### 4.4 Run / ContextBlock / 输入指纹

- 使用 Mnemosyne `run_id`，不假定 TT 提供。Head、run、宿主绑定/观察代次、记忆视图版本、策略版本分开。
- prepare 输入/响应回显 story_id、branch_id、head_snapshot_id、run_id、绑定/观察代次、输入指纹与策略/记忆版本；应用前核对当前值。存在已观察但尚未提交的历史变化时，不放行旧准备结果。
- Head 不变而摘要修正/策略变化/切聊天时，旧 prepare 仍应失效；后台历史摘要则核对自身 input_refs/coverage，不能因范围外追加而无条件丢弃。
- ContextBlock 沿用 `06` 的基础字段：block_id、kind、content、content_revision、来源、激活理由、placement、priority、compressible、token 估计信息；与本轮身份统一。role/语义位置分离，用户可调，不写死 system，不实现完整编译器或中文模板。
- 指纹基线：内容/输入使用带用途及版本标记的 SHA-256，结构化输入按 RFC 8785 JCS 后 UTF-8 编码；数组保持顺序，正文不做 Unicode/空白/标点改写。UUID 是身份，不由此指纹代替。
- 规范分别列出正文内容、派生输入、prepare 输入、写入 payload 四份字段包含/排除表。派生输入包括实际输入版本/顺序/coverage/规则版本与已知模型 profile；不混入 run_id、观察时间、可变宿主路径、物理 NodeId。prepare 包含当前运行所需历史/用户输入/记忆视图/策略，不以“查询字符串相同”代替完整输入相同。
- `operation_id` 与 payload fingerprint 配对：同键同语义请求重试复用；同键不同 payload 明确冲突。先检查已提交操作结果，再判断新提交的 expected head，避免已成功但响应丢失后被误判为新冲突。
- 不实现生产认证/HTTP server；错误码先定义独立领域含义，HTTP 状态映射只是 A provider 的建议映射。

### 4.5 缺失、不确定与故障

- 身份歧义/损坏引用不自动合并或填造正文；返回 needs-resolution，并说明受影响范围。
- 明确 derived-only 导入可召回、不能展开原文；它有显式作用域和来源声明，与损坏的悬空引用不同。
- 待重建对象不可参与注入，正常记忆准备不伪装成零命中成功；诊断、导出、有效原文归档和修复写入仍可进行。无关故事不被全局停用。
- 保留“缺字段/不支持、版本冲突、未就绪、空结果、索引落后、真实 IO 错误”的区别，不能都变成 null。
- V1 上帝视角，不按角色知情过滤；故事/分支/cutoff、用户排除及禁止发送的私有字段继续严格过滤。

## 5. 24 项收口表及剩余边界

“确定”指领域规则确定，不表示生产功能已实现。技术拼写/校验约束在本任务落实并交 Chat review，不能据此发明新的产品行为。

| 原项 | 当前处理 |
| --- | --- |
| 1 Story | 确定：逻辑故事；普通新建与显式续聊分开 |
| 2 Branch | 确定：同 Story 下独立线，固定前缀 |
| 3 副本/分叉/迁移 | 有证据或用户指定用途，不自动猜；复杂对齐算法后续 |
| 4 SourceMessage | 内部 ID/来源映射确定；不以 hash 或楼层认同一消息 |
| 5 Revision | 确定：不可变正文版本与当前选择分离 |
| 6 Swipe | 确定：只选当前版本；只归档实际取得的候选 |
| 7 Edit/Swipe/Regenerate | 保留操作来源；不把中间删/建事件直接当永久领域删除 |
| 8 删除 | 当前分支退出使用；物理保留期/自动 GC 留 T-03 后确认，本任务不硬删 |
| 9 顺序 | 有序清单；剧情时间与宿主 index 是另外的维度 |
| 10 分叉点 | 固定父 snapshot + 包含端点前缀/锚，确定 |
| 11 Head | 本轮已接受 head_snapshot_id 方案 |
| 12 有效历史 | 按分支快照选版本，不全局 invalid |
| 13 派生来源 | 正文/下级记忆版本 + coverage，逐层重建 |
| 14 对象名/边界 | 工程暂用 TurnMemory、Summary、Event、Record；品牌名待定。普通回合已定，非标准分组不猜 |
| 15 ContextBlock | 依据 06 + 本任务落实最小字段/正反例，不做完整渲染/配置 UI |
| 16 Run | 本系统生成、每次准备生命周期隔离 |
| 17 Head snapshot | 与 11 同一机制，不重复造 head_revision |
| 18 Hash | 本任务固化字段表、规范编码与测试，不保证 LLM 确定性 |
| 19 旧档缺 ID | 精确已知映射/确认后的变更有契约；模糊自动归并不在本任务实现 |
| 20 重复导入/幂等 | 同操作复用结果、同键异内容冲突；重试与故意复制分开 |
| 21 来源 | 最小宿主种类/绑定范围/稳定 ID/可变 ref/观察位置/导入批次，不持久化密钥 |
| 22 无原文 | 显式 derived-only 可用，损坏引用不可伪装 |
| 23 知识边界 | V1 上帝视角；实际隐私与分支边界不能取消 |
| 24 错误/修复 | 范围化阻塞、允许修复；不确定不写正常历史 |

**尚未最终决定但不阻塞本任务：** 开场白、连续多条 User/Assistant、Continue、群聊的自动回合分组；品牌名称；模糊对齐阈值；物理块/数据库选择；自动清理周期；完整摘要/检索模板。

本任务对非标准回合仅保留全部来源，并返回可区分的 pending/needs-resolution/unsupported，不伪造配对、不丢消息。普通单条待回复 User 是正常 pending，不算损坏。某项会改变已确认规则时，记录问题交 Chat，不让 Codex自行定案。后续特性开工前必须关闭对应未决，不能把本任务的安全兜底当作永久拒绝支持。

## 6. 实现增量（同一任务内，不另生成任务卡）

### C1：规范与机器校验

整理字段字典、不可变/可变边界、跨对象引用约束、四类指纹输入表、错误结果；提供 schema/类型与验证入口。JSON 形状校验之外必须有跨引用/状态转换校验，不能用 TypeScript 类型或 regex 代替。

### C2：最小纯逻辑参考模型

用内存虚构数据验证快照、fork、选版本、幂等操作结果、有效性/重建计划与 prepare 过期检查。小清单的简单参考实现可作测试 oracle；不假装它就是未来大规模生产存储。

### C3：正反例与交接

每项测试固定 ID/随机种子，失败能复现；清点旧 docs/examples 中已被替代字段。更新当前契约/样例，不改历史运行原始证据。给 T-03 列明确必需 provider 能力与仍未决定参数，只做交接，不提前改 T-03 状态。

## 7. 必须验收的场景

| ID | 场景/预期 |
| --- | --- |
| A01 | 首次/空历史合法；错误 UUID、重复消息身份、错属 revision、悬空引用/清单环拒绝 |
| A02 | 深层 edit 后 count 与尾正文不变，Head 仍改变；旧快照保持不变 |
| A03 | 从 User/Assistant 节点及空前缀 fork；越界/末项锚不符拒绝 |
| A04 | 父线改共同过去，子线历史与适用旧记忆不变；父线后续不能进入子线 |
| A05 | 切回旧候选可复用适用记忆；恢复旧清单产生新 snapshot，不复活旧 run |
| A06 | 相同文本不同消息不合并；楼层移动不改消息身份；缺映射不让 LLM 猜 |
| A07 | 已成功提交但确认丢失：同 operation 重试仍返回原 snapshot；同键异 payload 冲突 |
| A08 | 两项不同操作基于相同旧 Head，只有合法顺序提交可成功；失败校验不改变参考模型状态 |
| A09 | 改一轮使其上级大小总结/事件失效；无关回合保留；重建计划下级先于上级 |
| A10 | 区间中插入/删除/重排触发 coverage 更新；范围外追加不无条件重摘旧轮 |
| A11 | 跨 fork cutoff 的完整回合摘要/事件不能复用；非连续集合不静默吞掉新增成员核对 |
| A12 | 正文不变而修正摘要，正文 Head 不变，上级记忆/prepare 按记忆版本失效 |
| A13 | derived-only 合法与损坏引用非法分开；待重建/不确定不伪装零命中 |
| A14 | prepare 的 run/head/绑定/观察代次/记忆/策略任一相关变化均拒绝旧结果；后台历史任务核验自身来源 |
| A15 | JSON key 顺序不影响指纹，数组顺序/正文空白/来源版本变化影响指纹；NaN/非法 Unicode 等按规范拒绝，原始数据不偷偷修复 |
| A16 | Regenerate 成功、失败、删除/重建序列的领域解释不靠 ended 或同 index 判成功；用 T-02A 脱敏事实构造 fixture |
| A17 | 非标准回合/孤立消息不丢原文、不伪造 User；未识别分组能明确返回待处理 |
| A18 | 虚构数据逻辑导出/导入参考校验保留 ID、顺序、fork 和引用；不依赖物理 provider ID |

测试数量不是验收标准，上表语义覆盖才是。运行现有 `node --test apps/tt-adapter-probe/tests/probe.test.js` 和 `node --check apps/tt-adapter-probe/index.js` 作回归；新契约测试命令按实际工程建立并记录。执行 `git diff --check`。所有未执行项必须写 pending，不把计划中的测试写为通过。

## 8. 文档更新、回退与收尾

更新本任务、`docs/06-contracts.md`、受影响 examples/README、架构/路线中相关旧术语、阶段导读与 CHANGELOG；`03` 中已确认规则不可改成别的方案。`08` 的 Head 设计已接受，物理实现参数仍需实测。

回退：撤回本任务新增契约/测试及对应文档，保留原探针；本任务无生产数据写入，无迁移/用户存档回退。

收尾写实际变更、实际代码量/命令、测试证据、24 项状态映射、偏差、未验证项、正式字段与旧例子的迁移说明、T-03 provider 必须提供的能力。不得宣称持久性或手机性能通过，不自动创建/批准/执行后续任务。

## 9. 难度与模型使用提示

最难的是 C2/A02～A14 的组合不变量：固定分叉历史、分支相对有效性、coverage 插入遗漏、幂等重试和不同种类的过期判定。推荐把更强推理档位用于这部分的实现和反例审查。

schema 搬写、字段注释、文档样例相对常规。模型更强不替代运行测试；不能用“所有 schema 通过”证明所有跨对象关系正确。

## 实测/实施回报

### 开工基线与范围（2026-09-19）

- Git：main，从 214dcf9 快进至 `1f01168b0757b99b73173519bb347ba188f49fc4`；施工收尾时未 commit/push，随后用户明确要求提交并推送以供 Chat 线上 review。原工作树只有未跟踪 `.codex/`，排除在提交之外。
- 已读：README、AGENTS、S-A、当前 T-02、架构 0～4、03/06/07/08、路线 T-02/T-03、T-02A 最终 review 和脱敏 trace、examples、模板/CHANGELOG。T-03 仅只读了解依赖。
- 文档输入：架构/决策 v0.1 及 2026-09-19 收口，08 accepted Head；交付的 06 为 v0.2/schema_version=1。宿主输入沿用 T-02A verified 证据，没有重做现场取证。
- 已知环境：Windows PowerShell、Node v24.19.0；仓库无 package.json，不臆造 npm 命令，无新安装依赖。原拟逻辑500～800行、校验250～400行、测试/fixture600～900行，先 C2 再补 C1/C3。无必需输入缺失。

### 实际改动与代码量

- 新增 `packages/contracts/`：primitives（UUID/JCS/指纹/错误）、schema（精确字段形状）、history（不可变快照/分块共享/固定 fork/幂等/expected Head）、memory（来源/coverage/分支视图/逐层重建计划）、context（prepare/绑定/确认后 regenerate 解释）、transfer（逻辑包及跨引用校验）、index 和 README。
- 测试先覆盖父线改共同历史、跨 User fork cutoff、区间插入、非连续事件复核、上级/累计状态逐层失效、丢确认幂等重试和两种异步过期判定；然后补形状、导出、样例和异常输入。
- 实际 .mjs 行数（含空行/注释）：逻辑及跨对象校验697行，形状schema129行；测试451行、fixture84行，共535行；合计1361行。不含文档/JSON。较开工估计更少，无凑行数扩展。
- 更新 06、当前 prepare request/response、examples说明及模块样例普通可见性；同步 README、架构相关旧术语、路线、03任务进度、S-A、AGENTS当前状态和CHANGELOG。未改 accepted 决定、历史原始证据、探针或 T-03 卡。

### 环境、命令与测试证据

所有最终测试为本机纯逻辑，不是 TT/Android 或生产 IO 结果。

| 实际命令 | 结果 |
| --- | --- |
| `git pull --ff-only` | 首次 FETCH_HEAD 权限失败；获授权后 fetch 成功，但本地 main 无 upstream |
| `git pull --ff-only origin main` | 获授权后快进 214dcf9 → 1f01168；未修改远程/跟踪配置 |
| `node --version` | v24.19.0 |
| `node --test packages/contracts/tests/contracts.test.mjs` | 最终32/32通过，0失败/跳过；A01～A18和额外反例，约1.14秒仅供本次运行记录 |
| `node --test apps/tt-adapter-probe/tests/probe.test.js` | 18/18通过，0失败/跳过 |
| `node --check apps/tt-adapter-probe/index.js` | 通过 |
| `Get-ChildItem packages/contracts -Recurse -Filter *.mjs … node --check` | 9个.mjs语法检查通过；完整可复现命令见下 |
| `git diff --check` | 授权宿主身份后通过；仅LF→CRLF提示，无空白错误 |

```powershell
Get-ChildItem packages/contracts -Recurse -Filter *.mjs | ForEach-Object { node --check $_.FullName; if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $($_.FullName)" } }
```

过程中真实失败：测试 runner 在沙箱首次 spawn EPERM，获授权后重跑；首轮25/26为非连续 fixture 错用默认 interval，修正后通过；补充样例测试曾因相对路径多一层报 ENOENT，已修正重跑。Git 后续沙箱身份出现 dubious ownership，改为授权宿主只读检查，未修改全局 safe.directory。没有把失败记录当通过。

可复现证据：`packages/contracts/tests/contracts.test.mjs` 测试名含 A 编号，fixture 每次重置固定 UUID序列；组合测试固定 seed=20260919，30步保留所有旧快照并校验逻辑往返。没有保存真实剧情/模型请求/凭证或生产日志。

### A01～A18 对应

| 范围 | 已运行断言 |
| --- | --- |
| A01～A03 | 空历史/UUID/重复与错属引用/计数/清单环；深层edit保留count与尾部却变Head；空/User/Assistant fork及锚反例 |
| A04～A06 | 父线edit/delete与子线隔离；旧swipe复用及restore新快照/旧run不复活；同文本不同身份与重排/映射缺失 |
| A07～A08 | 丢确认重试先于expected Head；同键异payload冲突；两个竞争操作/失败校验/ID碰撞不改原状态 |
| A09～A12 | 回合→大小总结/Event/累计状态依赖序；额外实际前文也失效；coverage中插删重排；范围外推进可用；跨cutoff拒绝；修摘要不改正文Head |
| A13～A15 | derived-only与悬空/隐私区分；必需待重建不伪装empty；prepare各相关身份/输入与pending变化；后台按自身来源判断；JCS顺序/数字/非法Unicode反例 |
| A16～A18 | T-02A失败/中间删除/成功Regenerate解释；非标准回合保留来源不伪造配对；逻辑往返保留ID/fork/操作结果/记忆选择并拒绝损坏 |

额外断言：上级不能采用生成基线之外的传递前文；source对象键顺序不改变引用匹配；私有/禁发/重点详情压缩/rerank冒充拒绝；当前JSON样例真实指纹与canApply通过。测试数量不是性能或生产完备性证明。

### 观察事实与设计落实分开

- 本次观察：Node 能运行零安装依赖的校验器/纯模型；克隆返回的新状态与冻结旧状态在上述序列中满足不变量；只有内存提交边界得到测试。
- 宿主事实来自既有 T-02A：stableId是宿主证据；Delete参数是删除后长度；成功Regenerate可删/重建且候选数不增；summary可滞后。此次未接 TT，不新增宿主 API 结论。
- 设计落实：采用已确认的固定snapshot/fork、User+Assistant回合、分支相对有效性、来源/coverage逐层重建。新增技术字段拼写、严格 schema、错误码、指纹投影交本次 review，不把设计 accepted 当实现 verified。

### 24 项与偏差/未验证

1～3：Story/Branch/显式绑定和固定fork；4～12/17：来源版本/清单/Head转换和隔离；13～14：input_refs/coverage、普通TurnMemory和Summary/Event/Record；15～18：ContextBlock/run/分离视图与指纹；19～21：已知映射/历史操作去重/provenance；22～24：显式derived-only、V1普通可见性、范围化未就绪/修复入口。均有最小契约/测试，不宣称24项生产功能全部实现。

- 技术偏差：采用可执行JS shape schema，而非新增TS工具链或通用JSON Schema库；对象/状态转换同样做机器校验。无package.json/依赖下载。
- 安全下界待 review：derived-only 当前只在声明的精确 Branch/snapshot完整视图可用，不自动扩展到未来Head/子线；非标准分组unsupported保留全部来源；成员事件span变化needs-review，不自动吸纳新成员。上述不是永久产品拒绝规则。
- pending：数据库/块树/持久化与崩溃恢复、TT新联调/Android、百万/亿字性能、完整模糊导入/repair-rescan、真实摘要与自动重建、完整查询编译/预算/字段权限UI、认证/HTTP、模块存储与完整生产备份、自动GC/purge。未调用模型，未触碰真实存档。
- 包只接内存JSON值；生产文本入口的重复key/大小限制、跨语言JCS及资源上限尚未实现。Node crypto需在B运行时另适配/验证；不能直接当作TT WebView可导入库。
- archiveMemory/selectMemory是逻辑步骤，无持久化作业账本或通用写入幂等包装；需要调用者显式选适用版本。后台自动找旧版本、实际重建与重放执行仍后续，当前仅有效性/计划。

### 契约与数据影响、回退

06 v0.2/schema_version=1取代旧人工prepare示意：head_revision/generation_id/input_hash/memory_revision不机械改前缀，分别对应真实snapshot、Mnemosyne run、用途指纹及分支记忆视图。Leaf与角色知情示意按新决定对齐；模块/提案JSON仍标draft，不冒充生产schema。

无线上协议/生产数据写入，无真实存档迁移。回退时撤销本次新增 `packages/contracts/` 及配套文档/样例diff，恢复到1f01168对应内容；先保护用户后来改动，不用全仓库reset。保留原探针和 .codex，勿删除聊天或清理共享历史。若代码尚未提交，按本次文件清单逐项撤回；未来提交后可单独revert该实现提交。

### 下一任务依赖与 Chat review 事项

T-03 文件保持原样proposal，未执行、未改planned、未创建新task。review后由Chat/用户修订启用；需提供精确ID/完整枚举、不可变冲突保护、Head/操作结果/重建标记的完整持久发布、失败恢复、稳定导出与空环境恢复、索引重建及设备实测。内存双条目叶块不是冻结的生产参数，逻辑包不包含未来全部模块/作业状态。

请Chat审查：正式技术字段/指纹投影和错误码；derived-only精确快照下界后续如何扩展；required_memory_revision_ids作为本轮必需范围的界面/调用约定；是否接受当前Node参考模型/机器schema作为T-03测试oracle。非标准分组/模糊阈值/GC/品牌/完整模板仍按原未决表，不由本轮静默定案。最终保持 implemented_unverified。
