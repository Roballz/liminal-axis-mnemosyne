# T-02A：TT 宿主身份与消息变更事件探针

状态：verified

## 目标

在用户固定的 Windows x64 TauriTavern 2.2.0 dev/Canary 环境中，用最小探针取得 **聊天稳定身份、Branch、Edit、Delete、Swipe／Regenerate** 的真实运行证据，为正式 T-02 身份／版本契约消除宿主事实不确定性。

本任务只回答“TT 实际提供什么”。**不设计 Mnemosyne 正式 Story／Branch／SourceMessage／Revision schema，不实现 Memory Engine，不决定数据库。**

## 前置与必读

- T-00：verified。
- T-01：verified；优先复用 `apps/tt-adapter-probe`，不要另造一套大探针。
- 必读：
  - `AGENTS.md`
  - `stages/S-A-foundation.md`
  - `docs/03-decisions-and-open-questions.md` 第 5～7 节
  - `docs/05-source-review.md` 的 T-01 / T-02 宿主补充
  - `notes/baseline.md`
  - `tasks/T-01-adapter-probe.md`
- 已知代码级候选事实：
  - character chat 的 `handle.stableId()` 当前读取 `chat_metadata.integrity`；
  - TT/ST 事件存在 `MESSAGE_EDITED`、`MESSAGE_UPDATED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED`；
  - 普通编辑源码路径会 emit `MESSAGE_EDITED(messageIndex)`；
  - Branch 创建会复制分叉点以前的历史；
  - 用户人工检查约 7～8 个实际存档（含多个 Branch），所见 `integrity` 均不同。
- 上述源码／人工观察都不能替代本任务的受控真机证据。

## 开工要求

开工前先报告：

1. 当前 Mnemosyne commit 与工作分支；
2. 已读文件；
3. 预计修改文件；
4. **预计新增／修改代码行数**；
5. 将如何避免接触真实长期 RP 数据；
6. 五项现场验证各自准备怎样取证。

优先修改现有 `apps/tt-adapter-probe`；若预计需要明显扩张探针结构，先停下并报告，不擅自扩大任务。

## 允许修改

- 对现有 TT adapter probe 增加最小事件监听／诊断 UI／脱敏 trace。
- 增加只覆盖探针纯逻辑的最小测试。
- 新增 T-02A 脱敏运行记录。
- 更新本 task、`notes/baseline.md`、`docs/05-source-review.md`、`CHANGELOG.md`。

## 禁止修改／禁止提前决定

- 不修改 TT / SillyTavern / 柏宝书源码。
- 不改真实长期 RP 聊天；只用隔离测试聊天或新建的虚构测试聊天。
- 不实现正式后端、数据库、同步器、导入器。
- 不冻结 Story / Branch / SourceMessage / Revision / head_revision / input hash 字段。
- 不把 `integrity`、楼层号、message index 直接升级成 Mnemosyne 永久主键。
- 不创建正式 T-02 或 T-03 任务卡。
- 不因发现宿主限制而顺手设计 repair/rescan 实现；只记录事实和后续要求。

## 验证 1：stableId / integrity / Branch

在同一个隔离测试聊天中：

1. 记录 parent chat：
   - `current.ref()`
   - `handle.stableId()`
   - `chat_metadata.integrity`（若扩展可安全读取）
   - 文件／session 显示名只记录脱敏标签，不保存真实路径正文。
2. 从明确楼层使用 TT/ST 原生 Branch 按钮创建子分支。
3. 对 child chat 读取同样三项。
4. 证明：
   - parent / child 的 stableId 是否相同；
   - stableId 是否与各自 integrity 一致；
   - Branch 后 child 是否拥有新的 chat ref / 文件身份。
5. 回到 parent，再打开 child，确认两边 stableId 在重开后保持稳定。

**额外轻量检查：**
- 将测试聊天改名（若 TT UI 支持且不会破坏样本），确认 stableId 是否保持不变。
- 若改名行为存在风险或当前 UI 不支持，可标 unsupported，不为此修改宿主。

## 验证 2：手动 Edit

选择一条 **非最新的旧消息** 做明显但无敏感内容的编辑。

探针记录：

- 触发的事件名；
- 事件参数；
- 事件发生时 current stableId；
- message index；
- 事件回调内读取到的该消息正文指纹（只存 hash／长度／marker，不保存正文）；
- `MESSAGE_EDITED` 与 `MESSAGE_UPDATED` 的先后顺序；
- 保存完成后再次读取同 index，确认正文指纹已变化。

需要回答：

- 普通 UI 手动编辑是否稳定触发 `MESSAGE_EDITED(index)`；
- 回调时是否已经能读到新正文；
- 深层旧消息编辑是否与最新消息编辑表现一致；
- 是否足以让 Mnemosyne 自动把“该 source 需要生成新 Revision／重建派生记忆”列为候选动作。

最后一项只记录“宿主证据足够／不足”，**不实现 Revision**。

## 验证 3：Delete

在隔离样本删除一条明确标记的消息，记录：

- `MESSAGE_DELETED` 是否触发；
- 实际参数是什么；
- 参数表示被删 index、删除后的 index 还是其他值；
- 删除前后 `history.tail/summary` 的 message count；
- 删除位置之后的 message index 是否整体平移；
- 是否能仅凭事件 + 当前 history 定位“哪条旧 source 消失”。

不得据此实现 tombstone；只判断宿主可观测性。

## 验证 4：Swipe / Regenerate

使用 assistant 最新消息执行：

### Swipe
记录：

- `MESSAGE_SWIPED` 是否触发；
- 事件参数；
- message index；
- `swipe_id` / `swipes` 在事件前后的最小脱敏状态；
- 当前 active 文本指纹。

### Regenerate
至少执行一次重新生成，记录：

- 生成生命周期事件；
- 是否伴随 `MESSAGE_SWIPED` 或其他可识别变化；
- 是否仍对应同一 message index；
- active swipe / candidate 数量如何变化；
- 是否可以可靠判断“同一 assistant 楼的候选发生变化”。

不需要测试模型内容质量。

## 验证 5：能力矩阵

收尾必须给出表格，至少包含：

| 能力 | 实测结果 | 关键参数／身份 | 可否自动定位 | 宿主限制／降级 |
| --- | --- | --- | --- | --- |
| Chat reopen |  |  |  |  |
| Rename |  |  |  |  |
| Branch |  |  |  |  |
| Deep Edit |  |  |  |  |
| Delete |  |  |  |  |
| Swipe |  |  |  |  |
| Regenerate |  |  |  |  |

结果只能使用类似：

- verified
- degraded
- unsupported
- not_observed

不得用“应该可以”。

## 证据要求

- 只提交脱敏 trace：
  - stableId / integrity 可以记录完整值或稳定缩写；若认为属于用户敏感标识则只记录 hash；
  - 正文只能记录测试 marker、长度、hash，不保存真实 RP 内容；
  - 记录事件顺序、时间戳、message index、message count、swipe index 等。
- 源码观察与真机结果分开写。
- 如果源码行为与用户安装版不同，以真机结果为准，并记录版本差异。
- 至少一次关闭／重开聊天后复核稳定身份；若需重启 TT 才能判断某项稳定性，可执行一次，不要求重复多轮压力测试。

## 验收

T-02A 只有在以下条件满足后才可交 Chat review：

- Parent → Branch 的 stableId / integrity 关系有真实样本；
- 普通 UI 深层 Edit 有真实事件 trace；
- Delete 有真实事件参数与 index 变化 trace；
- Swipe 有真实事件 trace；
- Regenerate 有真实观察，能判断是否可自动识别候选变化；
- reopen 稳定性已验证；
- rename 已验证或明确标为 unsupported / 未安全执行；
- 能力矩阵完整；
- 没有修改真实长期存档、TT／柏宝书源码或正式数据；
- 没有提前冻结 T-02 schema。

## 若宿主能力不足

任何一项若无法可靠定位，不要绕过 TT 或加入复杂轮询方案来“做成”。

只记录：

1. 哪个事件／参数不足；
2. 最小可行降级需要什么（例如有限 rescan、用户手动 repair、手动映射）；
3. 正式方案应留给 T-02 决定。

## 回退

禁用或移除新增的 T-02A 探针逻辑；测试聊天允许直接删除。探针不得写正式 Mnemosyne 数据，因此无 schema / migration / 数据回退。

## 收尾回报

把实施回报追加到本 task，至少包括：

- 实际改动；
- 实际执行命令／测试结果；
- 五项现场实验步骤与脱敏证据位置；
- 能力矩阵；
- 与源码预期不一致之处；
- 未验证项与宿主限制；
- 对正式 T-02 的事实输入；
- 回退方式；
- **只报告下一步需要 Chat／用户决定的问题，不创建正式 T-02 任务卡。**

## Codex 实施回报（2026-09-19）

### 实际改动

- `apps/tt-adapter-probe/index.js`：在现有探针中增加事件参数脱敏、stableId/integrity/ref 的长度与短哈希、消息计数与邻近指纹、history tail/summary 摘要、swipe 候选数和事件序号；新增 `mnemosyneProbe.t02aTrace()` 读取脱敏事件记录。
- `apps/tt-adapter-probe/index.js`：增加 `Copy host`、`T-02A trace`、`Copy trace` 面板操作；版本升至 `0.1.3`，trace 导出按 sequence 排序，`windowInfo.chatRef` 只保留类型、计数和标识符哈希，integrity 不可读时输出 `null`。
- `apps/tt-adapter-probe/tests/probe.test.js`：新增消息指纹、事件参数脱敏、邻近状态窗口、windowInfo 脱敏和 trace 排序测试。
- `apps/tt-adapter-probe/README.md`：补充 T-02A 监听范围、脱敏边界和读取 trace 的方式。
- 已将 `0.1.3` 探针副本同步到用户确认的 `C:\Users\Administrator\AppData\Roaming\com.tauritavern.client\data\extensions\third-party\mnemosyne-tt-adapter-probe`，并核对仓库与部署副本 `index.js` SHA-256 一致；未修改 TT／柏宝书源码或聊天文件。

当前相对 `dc532a0` 的工作树 diff 统计为：`index.js` 307 行新增／6 行删除，纯逻辑测试 73 行新增，README 12 行新增；增量仍局限在现有探针边界内。

### 环境、命令与结果

- Mnemosyne commit：`dc532a00cb4502ee821564da3dc5b68af665256c`，分支 `main`；上游已快进同步。
- `node --test apps/tt-adapter-probe/tests/probe.test.js`：11/11 通过。
- `node --check apps/tt-adapter-probe/index.js`：通过。
- `git diff --check`：通过。
- 用户现场附件为脱敏 `HOST-REOPEN`、`EDIT-TRACE`、`DELETE-TRACE`、`SWIPE-TRACE`、`REGENERATE-TRACE`；仓库只写摘要，不保存附件原文。

### 五项现场验证与脱敏证据

用户在隔离虚构测试聊天中手工完成现场操作，并在 reopen 后刷新 host 复制 trace；未修改真实长期 RP。以下矩阵已按 Chat review 及 0.1.4 补测校正；整体保持 `implemented_unverified` 待 Chat 复核，面板拖动已由用户确认通过：

| 能力 | 实测结果 | 关键参数／身份 | 可否自动定位 | 宿主限制／降级 |
| --- | --- | --- | --- | --- |
| Chat reopen | verified | stableId hash `58c6aa96`；chatId/ref 重开后保持 | verified（stableId） | metadata 交叉证据已补采 |
| Rename | verified | stableId hash `58c6aa96` 保持；chatId/ref 改变 | verified（stableId）；ref 需重新读取 | 文件身份变化，不能只依赖 ref |
| Branch | verified | parent `58c6aa96`；原 child `15d97193`；0.1.4 各自 stableId=integrity=contextIntegrity | verified（宿主身份可区分） | 另一个 CHILD-HOST 身份 c7f7849b 独立记录，不混同 |
| Deep Edit | verified | `MESSAGE_EDITED[3]` 后 `MESSAGE_UPDATED[3]`；index 3 指纹 `512b617a -> 502b5fe7` | verified（事件 index + 指纹） | 仅验证本次旧消息样本 |
| Delete | verified（明确目标样本） | N5、k3、UI#3；seq29 参数[4]，count5→4，旧 index4 指纹移至3 | 事件参数单独定位仍 degraded；本样本邻接可核对 | summary 在事件中暂为5，稳定后为4 |
| Swipe | verified（事件／候选定位） | `MESSAGE_SWIPED[5]`；候选 `1 -> 2`，swipeId 改变 | verified | 该次后续模型失败作为生成样本 degraded 单列 |
| Regenerate | verified（成功样本） | seq25～28：index4、count5，active 正文2297→2068字符、hash 改变 | 同一宿主槽位的新正文可定位 | 候选1→1、swipeId0，无 swiped 事件；不证明保留旧候选 |

脱敏证据摘要位置：`notes/t-02a-runtime-trace.md`。完整附件不入库。

### 源码观察与运行事实

- 源码观察：现有探针可从 `eventTypes` 注册 `MESSAGE_EDITED`、`MESSAGE_UPDATED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED` 和生成生命周期事件；T-02A 代码现在会保留事件参数的安全结构摘要，并以当前 chat 数组和 `history` 读取结果形成前后窗口。
- 运行事实：现场确认 reopen／rename stableId 保持、Branch 身份变化、Edit 双事件和正文指纹变化、Delete 后索引平移、Swipe 候选变化及 generation lifecycle；`integrity` 当前路径不可读，失败 regenerate 未形成可确认的新候选。
- 运行事实与设计决定分开：以上不把 stableId、chatId、ref、楼层号或 message index 升级为 Mnemosyne 永久主键，也不冻结 Story／Branch／SourceMessage／Revision/head 字段。

### 数据、契约与回退

- 未新增 schema、API、迁移、正式 Mnemosyne 数据或 Story/Branch/SourceMessage/Revision/head 字段决定。
- 正文只进入长度与 FNV-1a 短哈希；事件参数中的字符串也只保留长度与哈希；trace 不保存 prompt、路径正文或完整聊天对象。
- 回退方式：禁用或移除部署的 `mnemosyne-tt-adapter-probe`，并删除本次新增探针逻辑；探针不写正式档案，无数据迁移。不要删除用户聊天作为回退动作。

### 未验证项、下一步依赖与需要决定的问题

- 未验证项：stableId 与 integrity 的关系；Delete 参数的精确前／后索引语义；失败 regenerate 是否产生可复用的新 candidate／Revision；`history.summary` 的实际内容。
- 下一步依赖：正式 T-02 需要决定事件不足时的手动 repair/rescan／映射边界，并定义 Mnemosyne 内部版本身份；不由本 task 静默定案。
- 需要 Chat／用户决定：是否接受当前 Delete／Regenerate 的 degraded 证据作为 T-02 输入，或在独立虚构样本上补测；本回报不创建正式 T-02 任务卡。


## Chat review（2026-09-19）

结论：**暂不升为 verified，保持 implemented_unverified。**

主体实现与现场取证范围正确，没有越界冻结正式 T-02 schema；Branch、reopen、rename、Deep Edit 已形成可用真机证据。当前只需小范围返修，不重做整轮实验。

### 必须返修 1：integrity 读取路径错误

当前探针从 `getContext().chat_metadata.integrity` 读取，但 TT 当前 `getContext()` 暴露的是 `chatMetadata`（camelCase），不是 `chat_metadata`。因此现场 `integrity = null` 不能解释为宿主不可读，只能解释为探针读取路径错误。

优先使用正式 Chat API：`handle.metadata.get()` 读取 metadata，并与 `handle.stableId()` 比较；`context.chatMetadata` 可作为同轮交叉证据。修复后只需在 parent / branch 各刷新一次 host，确认：
- stableId 是否等于各自 metadata.integrity；
- parent / child integrity 是否不同；
- reopen / rename 结论不需要重做，除非修复后出现矛盾。

### 必须返修 2：chat summary API 调用位置错误

当前探针调用 `handle.history.summary()`，但 TT Chat API 的接口是 `handle.summary({ includeMetadata })`；`history` 下只有 tail / before / beforePages。

这里的 “summary” 不是 AI 剧情摘要功能，而是聊天文件概况 API，返回 message_count / metadata 等轻量信息，不依赖用户开启 TT 或柏宝书摘要。

修复后用 `handle.summary({ includeMetadata: false })` 记录 message_count；Delete 验证可用它与 context chat count 交叉检查。

### Delete：不要求重测参数语义

补充现场事实：用户确认删除前共有 7 条 chat message，删除的是倒数第二条 User 消息。若按 TT/JS `chat` 数组的 0-based index，该消息应为 index 5；事件实参却为 `[6]`，与删除后的 `chat.length = 6` 一致。这进一步排除了“参数是被删 index”的解释。前端楼层显示编号或日志中的 human-readable `message[n]` 不应与内部数组 index 混为一谈。

TT 当前源码在实际删除完成后执行：
`eventSource.emit(MESSAGE_DELETED, chat.length)`

所以事件参数在源码语义上是**删除后的聊天总长度**，不是被删除 message index。现有现场样本 `MESSAGE_DELETED[6]` 与 count `7 -> 6` 数值正好重合；若删除的恰好也是 index 6，这两个值会完全一样，因此该单一样本不能靠数值本身区分两种解释，语义以宿主源码为准。

T-02A 可据此收口为：
- 删除发生：可自动侦测；
- 删除后总长度：可直接得到；
- 深层“具体删了哪条 SourceMessage”：**不能仅靠事件参数定位**，需要删除前后指纹／有限 rescan 或后续手动 repair 策略；
- 这是正式 T-02 的事实输入，不是 T-02A 继续绕宿主解决的事项。

### Swipe：事件能力可接受

现有真机已经观测到 `MESSAGE_SWIPED[5]`、候选数 `1 -> 2`、swipeId 与 active 指纹变化。即使后续模型连接失败，也足够证明“Swipe 候选变化可被探针观察”。

因此 Swipe 不作为本轮返修阻塞；文档可把“事件／候选定位能力”标 verified，把“该次生成后续失败”单独记为运行样本降级。

### 必须补测 3：一次成功 Regenerate

现有 Regenerate 样本因模型无有效输出，只证明 generation lifecycle 与失败路径可见，没有回答任务卡要求的：
- 成功 regenerate 是否仍对应同一 assistant message；
- candidate / swipe 数量怎样变化；
- active swipe 是否可可靠定位。

修复上述两个读取路径后，在同一虚构测试聊天上补一次**成功的 regenerate** 即可。不需要重复其他真机实验。

若当前模型仍不可用，可临时换一个已确认能正常返回的测试模型；不测模型质量，只取宿主事件和候选状态。

### 返修验收

返修后需：
1. 增加/调整纯逻辑测试，覆盖 metadata / summary 的正确读取封装（若相关逻辑可纯测）；
2. `node --test apps/tt-adapter-probe/tests/probe.test.js` 全通过；
3. `node --check apps/tt-adapter-probe/index.js` 通过；
4. parent / child 的 stableId ↔ integrity 关系有真机证据；
5. Delete 文档按“参数 = 删除后 chat.length”修正；
6. Swipe 事件定位能力与后续生成失败分开描述；
7. 至少一条成功 Regenerate trace；
8. 不创建正式 T-02 任务卡。

预计属于小返修，原则上只改现有探针、测试和事实文档；若实现明显超出该范围，先停下报告。

### 用户补充（2026-09-19）

- Delete 现场样本信息不足，用户要求下次返修时重新做一次更明确的删除实验；当前不把该样本作为最终 Delete 定位语义的唯一真机证据。
- 下次 Delete 复测应在操作前明确记录总 message 数、目标消息的前端楼层号、内部 0-based index、前后邻接指纹，并在删除后再次记录 count/邻接平移；同时保留源码事实 `MESSAGE_DELETED(chat.length)` 作为解释性证据。

## Codex review 返修（2026-09-19，0.1.4）

状态仍为 `implemented_unverified`；本段替代旧回报中“integrity 宿主不可读、summary 不可用、Delete 参数语义未定”的解释，不覆盖原始现场事实。

### 范围与实际改动

- 基线 `d235263`（本轮 `git pull --ff-only origin main` 快进），文档基线 v0.1 及 2026-09-19 review；已读 README、AGENTS、架构 0～3、决策、S-A 导读、T-02A、来源核验与运行记录。保留 `.codex/`，不创建正式 T-02 卡。
- `index.js` / `manifest.json`：探针 0.1.4，读取 `handle.metadata.get()` 的 integrity；以 `context.chatMetadata.integrity` 独立交叉取证，不回退伪装正式 metadata 成功。原始值比较后只输出布尔/null与身份短哈希；错误／缺失分开记录。
- 正确调用 `handle.summary({ includeMetadata: false })`，只导出 `status` 和 `message_count`。输出暂沿用 `messageState.history.summary` 分组，此分组不是宿主 API 路径；tail 失败不会阻止 summary 读取。
- Delete 事件数字标为 `post_delete_count`，不推断为被删索引；generation/chat 事件数字也不充当消息索引。增加 `Index (0-based)`，只采指定位置及邻居，不实现 rescan/repair。
- 补充 `MESSAGE_RECEIVED` 观察与 generation type 白名单；成功与否仍需用户确认非空有效回复并提交前后快照，不能凭 ended 事件判定成功。
- 用户明确要求的范围扩展：标题栏 pointer 拖动、pointer capture/cancel、视口限制及缩放／面板尺寸变化时回收；适配窄窗口，位置仅当前页面有效。无新依赖、无数据迁移。
- 修改现有探针／测试／README、任务卡、运行记录、基线、来源核验、CHANGELOG；不修改 TT/ST／柏宝书源码、模型配置或聊天档案。

### 环境、测试与事实边界

- Windows PowerShell / Node；`node --test apps/tt-adapter-probe/tests/probe.test.js`：18/18 通过（新增 7 项）。
- `node --check apps/tt-adapter-probe/index.js`、`git diff --check`：通过。
- 相对 `d235263`：探针 JS +113/-34 行，测试 +122 行；未引入 package.json 或依赖安装。
- 已用 `Copy-Item -LiteralPath` 更新既定 TT third-party 扩展目录的 index.js / manifest.json / README.md；`Get-FileHash` 核对部署与仓库两份 JS、manifest SHA-256 分别一致。JS：`BD69CDEC6937C9F1C57D519613630F66979FBA03875DA0914C28EA9269F968A2`。部署成功不等于 TT 已重新加载，待用户刷新确认 0.1.4。
- 自动测试涵盖 metadata 正确方法与 camelCase 字段、直接相等比较、缺失／异常、summary 正确调用和安全字段筛选、Delete 参数非索引、目标邻居平移、拖动捕获／取消／边界／缩放。
- 测试 stub 和模拟 pointer 不是真机结果；0.1.4 的 TT metadata/summary、成功 Regenerate 和拖动均已取得用户实机回传。此前缺失状态已由下方“0.1.4 实机回传核对”修正。
- Delete 源码事实、Swipe 已验证能力依据本任务卡 Chat review；本轮不重复访问外部上游源码，也不将“有限 rescan”实现为正式方案。

### 用户复测顺序

只用既有虚构测试聊天；刷新 TT 前端，确认面板 `0.1.4`、`arm` 不勾选。每次点击 Refresh host 后，等 host 的 observedAt 更新再 Copy host；Copy trace 是当前页面最近 40 条累计事件，测试中不要刷新前端。

1. 拖标题栏到左上／空白位置，滚动面板、缩小再放大窗口，检查标题栏始终可拖，按钮仍能点击。回传“DRAG：通过／问题描述”。
2. 打开原 parent，清空 Index，Refresh host → Copy host，标为 `PARENT-HOST`。打开已有 child 同样操作，标为 `CHILD-HOST`。检查 integrity/contextIntegrity 与 stableId 哈希及三个比较字段，summary.message_count 与 contextCount 交叉比较；不重新创建 Branch，不重做 rename/reopen。
3. 回到 parent。先确保测试模型能返回有效回复，最新消息为非空 assistant；必要时只在测试聊天发送一条简短虚构请求取得正常回复。清空 Index，Refresh host → Copy host 为 `REGEN-BEFORE`。执行原生 Regenerate，等待有效非空输出完整结束；不要点 Stop。再 Refresh host → Copy host 为 `REGEN-AFTER`，Copy trace 为 `REGEN-SUCCESS-TRACE`，附“看到有效输出：是/否”。若仍失败，回传失败，不把空候选标为成功。
4. 最后在虚构聊天选择一条有前后邻居的中间消息。记录前端显示楼层号和内部 0-based index k（从第一条含开场白算 index 0，不从 UI 显示号猜）；若选择倒数第二条，k = 当前 contextCount - 2。在 Index 填 k，Refresh host → Copy host 为 `DELETE-BEFORE`；附总数 N、UI 楼层号（无则写无）、k。只删除目标一条，不选择“从此往后删除”。等保存后保持 Index 不变，Refresh host → Copy host 为 `DELETE-AFTER`，Copy trace 为 `DELETE-TRACE`。若界面只支持截断删除，停止并说明，不改为批量删除。

预期检查：Delete count 由 N 到 N-1，事件实参为 N-1，旧 k+1 指纹移动到 k；summary 与 context count 若不同，保留实际返回，不手改结果。成功 regenerate 的候选数是否增加不预设结论，由 trace 决定。

### 回退、未验证与后续

- 回退：禁用探针，或将 `d235263` 中的 index.js / manifest.json / README.md 恢复到部署目录并刷新；不要回退／删除聊天。
- 契约影响：仅诊断输出新增 status、交叉身份、generationType/watchIndex；无正式 schema、存档或迁移变更。
- 仍需上述真实回传与 Chat 复核；T-02 依赖的是已核实宿主事实和明确降级边界，不自动推进任务或冻结身份契约。

### 0.1.4 实机回传核对（2026-09-19）

已收到用户附件 `c356e6b7-741c-4b48-8396-754406e5eac9`，详细脱敏证据见 `notes/t-02a-runtime-trace.md` 的“0.1.4 补测结果”。本段更新前文等待实测的状态：

- 两处 API 修复均取得现场证据。parent、原 child（seq7/8）及本次 CHILD-HOST 中，stableId/metadata.integrity/contextIntegrity 的三个比较均 true；六份 host 的 summary.message_count 均与 contextCount 一致。
- 第三次 Regenerate 有成功证据（用户确认输出 + seq25～28 + REGEN-AFTER）。前两次失败与 seq24 中间删除单列；不能把 REGEN-BEFORE 的 count6/index5 直接与成功后 count5/index4 当作单轮变化。第三轮前后 index4/count5，候选数1→1，active 正文指纹 bacb4d89→75257157，长度2297→2068。宿主删除／重建不等于领域 SourceMessage 永久身份改变，此问题由 T-02 决定。
- 明确 Delete 样本也已补齐：N5、内部k3、UI#3，seq29 参数4，后续指纹从index4移至3；参数不是被删index，和删除后长度一致。事件参数独自定位具体来源仍不足，不实现 rescan。
- 额外限制：事件采样期间 summary 与 context 可不同步；seq29 时 summary5/context4，稳定 HOST 后两者均4。切聊天过渡 seq9 不作为身份比较证据；before 不是事务快照。ended/received 也在失败轮出现，不能单凭事件名称判成功。
- 面板标题栏拖动、TT 窗口最小化后不溢出、按钮可用已由用户确认；宿主三项返修及 Delete 样本无需重做。任务保持 implemented_unverified，等待 Chat review，不自动升级 verified。
- 用户补充：删除两条连续 assistant 中后一条后第三次 regenerate 成功，支持“上游要求 USER/ASSISTANT 交替”的猜测；没有 API 错误证据，记录为非正式运行假设，不影响宿主事件结论。
- 本轮仅写事实记录／矩阵、来源和基线／CHANGELOG，未修改代码或部署；最终测试命令见本段更新后的环境记录。附件用 PowerShell ConvertFrom-Json 解析按序核对，原始附件不入库。回退仍为禁用探针／恢复 d235263 探针，正式数据与契约无变更；本提交待 push。


## Chat 二次 review（2026-09-19）

结论：**通过，T-02A 升为 `verified`。**

- 已核对返修提交 `214dcf96192fc75f78332571eb9aa4473c711a47`，`origin/main` 当前指向该提交。
- integrity 读取已改为 `handle.metadata.get()`，并以 `context.chatMetadata.integrity` 交叉验证；parent 与已观测 child 的 stableId / metadata.integrity / contextIntegrity 在真机样本中三方一致。TT 宿主 stableId 可作为 adapter provenance / host identity，但不升级为 Mnemosyne Story/Branch 永久主键。
- 文件概况已改为正确的 `handle.summary({ includeMetadata: false })`；稳定 HOST 样本的 `message_count` 与 contextCount 一致。事件过程中的短暂不一致只记录为采样/落盘时序边界，不把 summary 当原子实时 head。
- Delete 补测使用非重合样本：N=5、内部 k=3、事件参数=4，且旧 index4 指纹移动到 index3。结合 TT 源码 `MESSAGE_DELETED(chat.length)`，确认事件参数表示删除后的总长度，不能单独定位被删 SourceMessage；正式 T-02 必须保留前后状态比较 / repair-rescan 边界。
- Swipe 已有事件、candidate 数与 active swipe 真机证据；该轮后续模型失败与 Swipe 事件能力分开记录。
- 成功 Regenerate 已补齐：同一宿主 assistant 槽位 index4 / count5，active 正文指纹与长度发生变化，candidate 数仍为 1，且未触发 MESSAGE_SWIPED。只能确认“当前槽位正文被替换并可定位”，不能据此推断宿主保留旧 candidate。
- “删除后一条 assistant 后第三次才成功”仅保留为上游输入格式猜测，没有错误响应证据，不作为 TT 或 Mnemosyne 契约。
- 18/18 纯逻辑测试、`node --check`、`git diff --check` 均记录通过；面板拖动与最小化不溢出也有用户真机确认。
- 未发现提前冻结 Story / Branch / SourceMessage / Revision / head / input hash schema 的越界改动。
- 正式 T-02 仍由 Chat / 用户继续方案攻坚；本 review 不创建 T-02 任务卡。
