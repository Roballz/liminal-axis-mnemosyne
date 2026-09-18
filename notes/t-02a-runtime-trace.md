# T-02A 运行记录

状态：`implemented_unverified`。本记录只保存探针实现和用户提供的脱敏现场事实，不冻结 T-02 的身份、Story、Branch 或 Revision 契约。

## 基线

- Mnemosyne：`dc532a00cb4502ee821564da3dc5b68af665256c`，`main`；本轮工作树包含 T-02A 实现增量。
- TT 基线：Windows x64，2.2.0 dev/Canary；具体环境记录见 `notes/baseline.md`。
- 探针副本：`C:\Users\Administrator\AppData\Roaming\com.tauritavern.client\data\extensions\third-party\mnemosyne-tt-adapter-probe`。
- 探针版本：`0.1.3`；面板提供 `Copy host`、`T-02A trace`、`Copy trace`。
- 测试策略：只使用用户新建的虚构测试聊天；本记录不保存真实 RP 正文、完整 ref、路径或 prompt。

## 脱敏边界与实现验证

- 监听范围：`CHAT_CHANGED`、`CHAT_LOADED`、`MESSAGE_EDITED`、`MESSAGE_UPDATED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED`、`GENERATION_STARTED`、`GENERATION_STOPPED`、`GENERATION_ENDED`。
- 身份只保留类型、长度和 FNV-1a 短哈希；`integrity` 当前探针路径读不到时为 `null`，不得解释为与 stableId 不一致。
- `windowInfo.chatRef` 的角色标识符和文件名只保留长度／短哈希；消息正文和事件字符串只保留长度／短哈希及测试 marker。
- 事件回调可能异步完成乱序；面板、复制按钮和 `mnemosyneProbe.t02aTrace()` 均按 `sequence` 导出排序后的 trace。
- `history.tail` 可读；`history.summary` 在现场均为 `null`。

纯逻辑验证：`node --test apps/tt-adapter-probe/tests/probe.test.js`（本轮应为 11/11）；语法检查和 diff 检查结果写回对应 task。

## 用户现场证据

以下来自用户复制的 `HOST-REOPEN`、`EDIT-TRACE`、`DELETE-TRACE`、`SWIPE-TRACE` 和 `REGENERATE-TRACE`，仓库只保留本摘要，不提交附件原文。

- Parent stableId hash：`58c6aa96`。
- Branch child stableId hash：`15d97193`；child 的 chatId/ref 均不同，消息数由 `7` 变为 `2`，说明 Branch 产生新身份并截取分叉点以前的历史。
- Rename 后 stableId 仍为 `58c6aa96`，但 chatId/ref 变化。
- `HOST-REOPEN` 在刷新 host 后显示 stableId、chatId、ref 保持；reopen 的稳定性得到现场支持。
- 所有现场 identity 的 `integrity` 都是 `null`。旧版 trace 中的 `stableIdMatchesIntegrity: false` 只能归类为“不可比较”，不能作为 mismatch 证据；`0.1.3` 已改为缺失时输出 `null`。
- Edit：`MESSAGE_EDITED` sequence `26`、参数 `[3]`，随后 `MESSAGE_UPDATED` sequence `27`、参数 `[3]`；index 3 指纹由 `512b617a` 变为 `502b5fe7`。顺序和保存后正文变化均被观测。
- Delete：`MESSAGE_DELETED` sequence `28`、参数 `[6]`；删除前后消息数 `7 -> 6`。用户确认操作对象是中间层；删除后原先 index 6 的指纹出现在 index 5，说明后续内容发生索引平移。由于 trace 没有保留被删位置的完整前后邻接链，不能仅凭该次样本冻结参数是删除前索引、删除后索引还是其他标识。
- Delete 操作前没有额外 `Refresh host`；事件记录仍有 before/immediate/after 状态，但不把它当作独立的手工 host 快照。
- Swipe：`MESSAGE_SWIPED` 触发，参数 `[5]`；同一 assistant index 的候选数由 `1` 变为 `2`，`swipeId` 变化并记录 active 指纹。模型随后无输出并断开，因此事件能力可观测，但整体结果记为 degraded。
- Regenerate：触发 generation lifecycle；失败路径出现消息删除／重建相关事件，但模型没有有效输出，未能可靠证明同一 assistant 楼产生了新的可用 Revision/candidate。整体结果记为 degraded。

## 能力矩阵

| 能力 | 实测结果 | 关键参数／身份 | 可否自动定位 | 宿主限制／降级 |
| --- | --- | --- | --- | --- |
| Chat reopen | verified | stableId `58c6aa96`、chatId/ref 重开后保持 | verified（stableId） | integrity 不可读 |
| Rename | verified | stableId `58c6aa96` 保持；chatId/ref 改变 | verified（stableId）；ref 需重新读取 | 文件身份变化，不能只依赖 ref |
| Branch | verified | parent `58c6aa96`；child `15d97193`；child chatId/ref 不同 | verified（stableId 可区分） | integrity 缺失，未比较其关系 |
| Deep Edit | verified | `MESSAGE_EDITED[3] -> MESSAGE_UPDATED[3]`；指纹变化 | verified（事件 index + 指纹） | 仅验证本次旧消息样本 |
| Delete | degraded | `MESSAGE_DELETED[6]`；count `7 -> 6`；后续指纹 `6 -> 5` | degraded | 参数的前/后索引语义未冻结；summary 不可用 |
| Swipe | degraded | `MESSAGE_SWIPED[5]`；候选 `1 -> 2`；swipeId 变化 | degraded | 模型无输出并断开 |
| Regenerate | degraded | lifecycle 事件可见；失败路径未形成可靠新候选 | degraded | 模型无输出并断开 |

## 事实与设计边界

- 现场事实支持：当前安装版可观测 stableId 的 reopen／rename 保持、Branch 身份变化、Edit 双事件、Delete 后索引平移、Swipe 候选变化和生成生命周期。
- 现场事实不支持：stableId 与 `chat_metadata.integrity` 的相等关系、完整 Delete 参数语义、失败 regenerate 后的新候选 Revision 语义。
- 这些事实不把 stableId、chatId、ref、楼层号或 message index 升级为 Mnemosyne 永久主键，也不决定 Story／Branch／SourceMessage／Revision schema。

## 回退与下一步依赖

- 回退：禁用或移除部署的 `mnemosyne-tt-adapter-probe`，或恢复本 task 前的探针版本；探针不写正式档案，无迁移和正式数据回退。
- 下一任务依赖：正式 T-02 仍需决定宿主事件不足时的手动 repair/rescan／映射边界，并单独定义内部版本身份；本 task 不创建正式 T-02 任务卡。


## Chat review 校正（2026-09-19）

- 现场 `integrity = null` 不是宿主能力结论。探针读取了不存在的 `context.chat_metadata`；当前 TT `getContext()` 对外字段是 `chatMetadata`，正式 Chat handle 还提供 `metadata.get()`。等待返修后重新取得 parent/branch metadata。
- 现场 `history.summary = null` 也不是用户未开启“摘要功能”。探针误调用 `handle.history.summary()`；正确接口是 `handle.summary({ includeMetadata })`，它是聊天文件概况 API，不是 AI 剧情摘要。
- TT 当前删除源码在 splice / 截断完成后 emit `MESSAGE_DELETED(chat.length)`；因此现有参数 `[6]` 表示删除后的总消息数，而非被删除 index。Deep delete 的具体来源定位需要前后状态比较，T-02A 不再把该参数当 message-index 候选。
- Swipe 的事件与候选状态变化已有足够现场证据；该次模型失败不否定 Swipe 事件能力。
- Regenerate 仍缺一条成功生成样本，返修后补测。
