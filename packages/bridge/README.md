# T-04 只读桥接（待 review）

来源：TT 原始 `context.chat[].mes`，公开 `STBaiBaiBook` API v1。
固定核对安装版 1.2.9 / 32dbb48a0a643804256d496bc35bf7699dea9ebe。
只取字段白名单；不保存 header/extra/delta、人物/变量/计划/向量/配置。
`parseJSONL` 分开 header 和消息；不会把柏宝书清洗 body 当正文。

## 接口及持久范围

- `TTSource.capture(categories)` 用于人工预览/重新核对；显式输入最多 32MiB。
- `captureLocal(start,count)` 最多16条和两侧邻居，事件只是线索；观察代次、聊天身份、数量及目标版本需一致。
- `Importer.preview/confirm/resume` 使用已确认绑定。非空续聊须显式选择仅新段、完整副本或已确认重叠数，校验继承前缀后追加；空续聊保留 Head。分叉须区分父聊天截取和已有子聊天：前者裁掉截止外资料，后者核验继承前缀、保留子线自己的尾部。父截取档不直接启用影子同步。
- `TTSource` 身份采用 TT/角色作用域 + stableId，文件名独立作为 locator。定位变化必须确认是同一来源，副本冲突不自动合并。identity 回执持久指向原 binding_source，保留正式绑定ID/Story/Branch和旧映射。旧v1键在原定位下可精确接续；定位已变须选择旧绑定并确认，已知身份/作用域不符仍拒绝。
- `BridgeEvents` 是面板与事件测试共用的真实订阅控制器，稳定后按总数与局部映射区分 append/版本变化；结束事件本身不证明生成成功，空结果/删除/歧义暂停，迟到跨聊天结果丢弃。
- `captureLegacy` 比较已选类别内容指纹，最多64个高层节点、每个可选类别64项、16个变化楼层/资产；超出自动预算转人工。读取公开快照/历史索引，但不为每条通知逐楼扫描全档；宿主构造这些公开DTO的内部成本不作有界保证。无关分类通知无写入，明确更新保留 previous 链。
- `applyLocal` 保存明确的 append/edit/swipe/regenerate；同正文重复事件保留 Head，真实编辑保留 message_id、产生 revision_id。
- `setState` 的 pending/paused/partial 均持久化；忽略警告不会解除暂停。部分导入恢复必须重供相同固定输入；输入变了先保留已提交批次，不从半份映射猜测新计划。
- `bridgeRead('bridge-v1:...')` 读最小回执。`manifests` 的保留前缀存 session、binding、逐楼 map、不可变 asset 和 assetMap，单请求最多64记录，正文/旧资料每批16条。HostBinding 保存正式身份；完整逐楼映射在分页桥接记录，不反复扩写整份 message_map。
- `kind: bridge / payload.version:1` 在原 prepare/execute 协议内一起编译正文和 CAS 回执。操作及生成ID由原持久请求恢复；不能在未知结果下生成另一ID重试。`recoverPending()` 只恢复原已准备 bridge 请求。
- 宿主与目标不能原子提交：提交前后检查来源，期间变化时保留已落盘版本并持久暂停，不将结果继续展示为当前同步完成。取消不声称已取消正在进行的原生写入。

## 旧摘要与来源声明

单楼 valid 摘要、高层选中 comp 节点和可选 items/scenes/lifeDetails 都保存为不可变旧资料。
API没有证明完整生成输入，统一 `legacy-inputs-unproven`，带原 ID、版本内容指纹、旧类型/subject/描述、抓取会话和目标快照作用域。可配对的 User→Assistant 标注 ordinary_pair，但不因此捏造 SourceRef 或 TurnMemory。连续 User、连续 Assistant、system、开场白和待答消息完整归档。

assetMap 是该来源最后观察版本的索引，不是“可直接注入的当前有效记忆”。历史资产仅在其保存的 Story/Branch/快照作用域查看；不自动跨分支继承、不调用模型补摘要。更新保留 previous 链，不覆盖子线固定历史。公开 getHistory 只暴露选中高层节点，报告明确不是全部层级；可选资料默认关闭。

## 导出、兼容和回退

完整 `handle.export()` 分页包包含桥接记录及持久请求，恢复到空库时重放核验。
原始分页 root/page-directory 格式不变；无 bridge 请求的旧包继续可读。
含桥接请求的新包需要支持对应记录类型的读者；本次新增 identity 回执及会话旧资料选择指纹。旧记录仍可读取，首次人工核对建立选择基线；缺基线时自动旧摘要核对暂停。旧读者遇到未知记录拒绝审计，不降级或删记录。
带桥接记录时 `logical()` 明确拒绝 v2 小包导出，避免静默漏掉回执/旧资料；此拒绝不使 owner 进入 recovery-required。

`apps/tt-import` 部署时将 packages/bridge、storage、contracts 的运行时模块放在入口旁的 packages/ 下。
面板仅开放现有 `mnemo-t03-paged-*` 隔离 namespace，不是生产手机准入。
提供新聊天/继承、类别/范围预览、确认/暂停/恢复、显式启停同步、分页包下载和空库恢复。
停止桥接移除监听，排空后关闭目标；不删除库、不回写源、不启用自动维护。
回退先停扩展、保全完整包和本版读者；不能让旧 writer 写含 bridge 请求的库。

## 验证

有限断言见 `tests/bridge.test.mjs`，对应 B01～B07；`native-demo.mjs` 为 B08 虚构源、真实隔离 DB 的短功能演示。
后者仅报告版本能力/计数/虚构哈希，不调用用户当前聊天的保存、模型或注入接口。
`native-entry.js` 仅用于隔离演示部署，普通扩展入口不包含收集器。
测试实际状态及未验证边界见任务卡；不跑旧机1x/5x/强杀矩阵。

返修反例见 `tests/review.test.mjs`，经过实际读取适配、Importer和面板共用事件控制器。`native-live-entry.js` 仅在用户点击后运行真实公开接口与面板确认，限1–32条已有摘要的小样本，4分钟停止新操作；只保存脱敏计数/相等断言，不保存正文或摘要。该演示未收到成功回执前均为 pending，不能拿旧 synthetic 演示替代。

实际TT导入档案可包含null候选槽；rawMessage原样保留null及swipe索引，当前mes仍为正文权威，不补造候选文本。未知对象/数字/undefined候选仍拒绝。完整分页包保留这些空位，见native-null-swipe-short.tap。
