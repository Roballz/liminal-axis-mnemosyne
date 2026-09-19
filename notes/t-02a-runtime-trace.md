# T-02A 运行记录

状态：`implemented_unverified`。本记录只保存探针实现和用户提供的脱敏现场事实，不冻结 T-02 的身份、Story、Branch 或 Revision 契约。

## 基线

- Mnemosyne：`dc532a00cb4502ee821564da3dc5b68af665256c`，`main`；本轮工作树包含 T-02A 实现增量。
- TT 基线：Windows x64，2.2.0 dev/Canary；具体环境记录见 `notes/baseline.md`。
- 探针副本：`C:\Users\Administrator\AppData\Roaming\com.tauritavern.client\data\extensions\third-party\mnemosyne-tt-adapter-probe`。
- 原始现场样本版本：`0.1.2`；后续代码修复 `0.1.3`。本轮返修 `0.1.4` 基于 `d235263`；已收到补测证据和面板拖动通过反馈，等待 Chat review。
- 测试策略：只使用用户新建的虚构测试聊天；本记录不保存真实 RP 正文、完整 ref、路径或 prompt。

## 脱敏边界与实现验证

- 监听范围：`CHAT_CHANGED`、`CHAT_LOADED`、`MESSAGE_EDITED`、`MESSAGE_UPDATED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED`、`GENERATION_STARTED`、`GENERATION_STOPPED`、`GENERATION_ENDED`。
- 身份只保留类型、长度和 FNV-1a 短哈希。旧版 integrity 为 null 是路径写错，不是宿主不可读；`0.1.4` 读取 handle metadata 与 camelCase context，直接比较原始值后只输出布尔／null。
- `windowInfo.chatRef` 的角色标识符和文件名只保留长度／短哈希；消息正文和事件字符串只保留长度／短哈希及测试 marker。
- 事件回调可能异步完成乱序；面板、复制按钮和 `mnemosyneProbe.t02aTrace()` 均按 `sequence` 导出排序后的 trace。
- `history.tail` 已有现场证据；旧版 `history.summary = null` 源于错误调用。`0.1.4` 改用 `handle.summary({ includeMetadata: false })` 取 `message_count`，已在稳定 HOST 中取得正确计数。

`0.1.4` 自动验证：`node --test apps/tt-adapter-probe/tests/probe.test.js` 18/18 通过；`node --check apps/tt-adapter-probe/index.js` 通过。封装测试与模拟 pointer 事件不代替 TT 真机验收。

## 用户现场证据

以下来自用户复制的 `HOST-REOPEN`、`EDIT-TRACE`、`DELETE-TRACE`、`SWIPE-TRACE` 和 `REGENERATE-TRACE`，仓库只保留本摘要，不提交附件原文。

- Parent stableId hash：`58c6aa96`。
- Branch child stableId hash：`15d97193`；child 的 chatId/ref 均不同，消息数由 `7` 变为 `2`，说明 Branch 产生新身份并截取分叉点以前的历史。
- Rename 后 stableId 仍为 `58c6aa96`，但 chatId/ref 变化。
- `HOST-REOPEN` 在刷新 host 后显示 stableId、chatId、ref 保持；reopen 的稳定性得到现场支持。
- 所有现场 identity 的 `integrity` 都是 `null`。旧版 trace 中的 `stableIdMatchesIntegrity: false` 只能归类为“不可比较”，不能作为 mismatch 证据；`0.1.3` 已改为缺失时输出 `null`。
- Edit：`MESSAGE_EDITED` sequence `26`、参数 `[3]`，随后 `MESSAGE_UPDATED` sequence `27`、参数 `[3]`；index 3 指纹由 `512b617a` 变为 `502b5fe7`。顺序和保存后正文变化均被观测。
- Delete：`MESSAGE_DELETED` sequence `28`、参数 `[6]`；消息数 `7 -> 6`，尾消息指纹由 index 6 移至 5。review 所核源码为 `emit(MESSAGE_DELETED, chat.length)`，故参数是删除后总长度，不是被删索引。具体来源不能仅凭该事件定位；按任务卡最新用户补充，另做明确目标、显示楼层、0-based index 与邻接指纹的复测。
- Swipe：`MESSAGE_SWIPED[5]`、候选 `1 -> 2`、swipeId 与 active 指纹变化足以确认事件／候选定位能力 verified；该次模型无输出并断开单独标为生成样本 degraded。
- Regenerate：触发 generation lifecycle；失败路径出现消息删除／重建相关事件，但模型没有有效输出，未能可靠证明同一 assistant 楼产生了新的可用 Revision/candidate。整体结果记为 degraded。

## 能力矩阵

| 能力 | 实测结果 | 关键参数／身份 | 可否自动定位 | 宿主限制／降级 |
| --- | --- | --- | --- | --- |
| Chat reopen | verified | stableId `58c6aa96`、chatId/ref 重开后保持 | verified（stableId） | 0.1.4 已另补 metadata 交叉证据 |
| Rename | verified | stableId `58c6aa96` 保持；chatId/ref 改变 | verified（stableId）；ref 需重新读取 | 文件身份变化，不能只依赖 ref |
| Branch | verified | parent `58c6aa96`；原 child `15d97193`；各自 stableId = integrity = contextIntegrity | verified（宿主身份可区分） | 新 CHILD-HOST 为另一身份 `c7f7849b`，不混为原 child |
| Deep Edit | verified | `MESSAGE_EDITED[3] -> MESSAGE_UPDATED[3]`；指纹变化 | verified（事件 index + 指纹） | 仅验证本次旧消息样本 |
| Delete | verified（明确目标实验） | N=5，k=3，UI #3；seq29 参数[4]，count 5→4，旧 index4 指纹移至3 | 参数单独定位仍 degraded；前后邻接可核对本样本 | 事件采样 summary 暂为5，稍后 HOST 为4 |
| Swipe | verified | `MESSAGE_SWIPED[5]`；候选 `1 -> 2`；swipeId 变化 | verified（事件／候选） | 该次后续模型失败单列 degraded |
| Regenerate | verified（本次成功样本） | seq25～28，index4，正文 bacb4d89→75257157，swipeId=0、候选1→1 | 同一宿主槽位的新 active 正文可定位 | 未证明保留旧候选；不能仅凭 ended/received 判成功 |

## 事实与设计边界

- 现场事实支持：当前安装版可观测 stableId 的 reopen／rename 保持、Branch 身份变化、Edit 双事件、Delete 后索引平移、Swipe 候选变化和生成生命周期。
- 0.1.4 补测已覆盖身份相等、明确目标 Delete 与成功 regenerate；跨消息版本的正式身份映射仍留给 T-02。Delete 参数语义由 review 源码与非重合目标样本共同支持。
- 这些事实不把 stableId、chatId、ref、楼层号或 message index 升级为 Mnemosyne 永久主键，也不决定 Story／Branch／SourceMessage／Revision schema。

## 回退与下一步依赖

- 回退：禁用或移除部署的 `mnemosyne-tt-adapter-probe`，或恢复本 task 前的探针版本；探针不写正式档案，无迁移和正式数据回退。
- 下一任务依赖：正式 T-02 仍需决定宿主事件不足时的手动 repair/rescan／映射边界，并单独定义内部版本身份；本 task 不创建正式 T-02 任务卡。


## Chat review 校正（2026-09-19）

- 用户补充确认：删除前共有 7 条 chat message，实际删除的是倒数第二条 User 消息；按 TT/JS `chat` 数组应为 0-based index 5，而事件实参为 `[6]`。这与删除后的 `chat.length = 6` 精确吻合，进一步确认 `MESSAGE_DELETED` 参数不是被删 message index。前端楼层号或人工显示的 `message[n]` 可能采用不同编号习惯，不作为内部 index 语义。

- 现场 `integrity = null` 不是宿主能力结论。探针读取了不存在的 `context.chat_metadata`；当前 TT `getContext()` 对外字段是 `chatMetadata`，正式 Chat handle 还提供 `metadata.get()`。等待返修后重新取得 parent/branch metadata。
- 现场 `history.summary = null` 也不是用户未开启“摘要功能”。探针误调用 `handle.history.summary()`；正确接口是 `handle.summary({ includeMetadata })`，它是聊天文件概况 API，不是 AI 剧情摘要。
- TT 当前删除源码在 splice / 截断完成后 emit `MESSAGE_DELETED(chat.length)`。现有 `[6]` 又恰好与用户所删楼层可能使用的 index 6 数值重合，所以现场单样本无法仅凭数字判断含义；宿主源码明确其语义为删除后的总消息数。Deep delete 的具体来源定位仍需要前后状态比较，T-02A 不把该参数当稳定 message-index。
- Swipe 的事件与候选状态变化已有足够现场证据；该次模型失败不否定 Swipe 事件能力。
- Regenerate 仍缺一条成功生成样本，返修后补测。

## 0.1.4 补测结果（2026-09-19）

本节更新此前“待补测”状态。附件标识 `c356e6b7-741c-4b48-8396-754406e5eac9`，仅记录以下脱敏摘要，不入库附件、模型请求或无关聊天数据。用户说明中间有额外操作，前两次 regenerate 失败、第三次成功；据 sequence 和身份分段，不把整份 BEFORE/AFTER 当作单操作。

- `PARENT-HOST` observedAt=1789795891993：stableId / metadata.integrity / contextIntegrity 均 hash `58c6aa96`，metadataStatus=ok，三个直接值比较均 true；summary.message_count=contextCount=6。
- 原 child 在 seq7/8：三种身份均 `15d97193`，三个比较均 true，count=2。`CHILD-HOST` observedAt=1789796013721 为另一宿主身份 `c7f7849b`，三个比较也均 true、count=2；不将两个 child 身份混同，不从这次切换推断改名导致 stableId 改变或新建关系。
- 所有六份 HOST 的 summary.status=ok，message_count 与 contextCount 一致，依次为 6、2、6、5、5、4。修复调用取得真机证据；summary 在事件过程仍可能不同步，不能视作原子实时 head。

| 分段 | 事件证据 | 观察 |
| --- | --- | --- |
| 失败一 | seq16～19：started(regenerate)、deleted[5]、ended[6]、received[5,...] | index5 最终长度0 |
| 失败二 | seq20～23，同类事件 | index5 最终长度0；ended/received 也会在失败路径出现 |
| 中间操作 | seq24 deleted[5]，count6→5 | 尾部空消息消失，index4 原正文 hash bacb4d89、长度2297 |
| 成功三 | seq25 started(regenerate) → seq26 deleted[4] → seq27 ended[5] → seq28 received[4,...] | 前后 index4、count5；hash bacb4d89→75257157，长度2297→2068；swipeId0、swipeCount1→1，activeSwipe 与新正文一致 |
| 稳定后快照 | REGEN-AFTER observedAt=1789796277803 | 身份58c6aa96不变，count5、index4长度2068，与成功 trace 一致 |

成功 regenerate 只证明同一宿主 assistant 槽位的 active 正文改变；该路径出现删除/重建事件，没有 MESSAGE_SWIPED，未观察到候选数增加，不能推断旧候选仍由宿主保留。用户已确认有效输出；失败原因未有错误响应证据，“连续两条 assistant 被上游拒绝”仅为猜测。

Delete：用户明确 N=5（含开场白），内部 k=3、UI #3，最高 UI #4。DELETE-BEFORE 的邻接为 index2=`1b93c8ef`、index3(User)=`502b5fe7`、index4(Assistant)=`75257157`；seq29 参数[4]（不等于被删 index3），context count5→4；DELETE-AFTER 中 index2 不变、原 index4 指纹移到 index3。该次删除定位／平移样本完整，不需重测。

seq29 的 immediate/after 中 summary.message_count 仍为5，稍后 DELETE-AFTER 更新为4；这证明采样存在时间差，不说明 summary API 失效，也不足以确定缓存或落盘原因。seq9 为切聊天过渡（identity null、context/summary count 不一致），不用于身份判定。跨聊天的 before 来自旧采样，不能当作当前聊天的事务前态。

用户补充：删除两条连续 assistant 中后一条后，第三次 regenerate 才成功；这支持“上游输入要求 USER/ASSISTANT 交替”的运行猜测，但没有 API 错误证据，不能写成宿主契约。它不影响本轮对同一 assistant 槽位事件与 active 指纹的结论。

面板标题栏拖动、TT 窗口最小化后不溢出、按钮可用均已由用户确认。任务保持 `implemented_unverified`，等待 Chat review；本轮不重做宿主实验。
