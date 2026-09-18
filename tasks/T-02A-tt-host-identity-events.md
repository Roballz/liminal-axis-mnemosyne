# T-02A：TT 宿主身份与消息变更事件探针

状态：implemented_unverified

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

用户在隔离虚构测试聊天中手工完成现场操作，并在 reopen 后刷新 host 复制 trace；未修改真实长期 RP。以下为运行事实，整体任务仍保持 `implemented_unverified`，因为 integrity、Delete 参数完整语义和失败 regenerate 的新候选仍未确认：

| 能力 | 实测结果 | 关键参数／身份 | 可否自动定位 | 宿主限制／降级 |
| --- | --- | --- | --- | --- |
| Chat reopen | verified | stableId hash `58c6aa96`；chatId/ref 重开后保持 | verified（stableId） | integrity 不可读 |
| Rename | verified | stableId hash `58c6aa96` 保持；chatId/ref 改变 | verified（stableId）；ref 需重新读取 | 文件身份变化，不能只依赖 ref |
| Branch | verified | parent `58c6aa96`；child `15d97193`；child chatId/ref 不同，count `7 -> 2` | verified（stableId 可区分） | integrity 缺失，未比较其关系 |
| Deep Edit | verified | `MESSAGE_EDITED[3]` 后 `MESSAGE_UPDATED[3]`；index 3 指纹 `512b617a -> 502b5fe7` | verified（事件 index + 指纹） | 仅验证本次旧消息样本 |
| Delete | degraded | `MESSAGE_DELETED[6]`；count `7 -> 6`；用户确认删除中间层，后续指纹由 index 6 移到 index 5 | degraded | 参数是删除前/后索引还是其他标识未冻结；summary 不可用 |
| Swipe | degraded | `MESSAGE_SWIPED[5]`；候选 `1 -> 2`，swipeId 改变 | degraded | 模型无输出并断开，但事件检测有效 |
| Regenerate | degraded | generation lifecycle 可见；失败路径有删除／重建相关事件 | degraded | 模型无输出并断开，未证明新的可用 candidate/Revision |

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
