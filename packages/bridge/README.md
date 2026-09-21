# T-04 只读桥接（待 review）

来源：TT 原始 `context.chat[].mes`，公开 `STBaiBaiBook` API v1。
固定核对安装版 1.2.9 / 32dbb48a0a643804256d496bc35bf7699dea9ebe。
只取字段白名单；不保存 header/extra/delta、人物/变量/计划/向量/配置。
`parseJSONL` 分开 header 和消息；不会把柏宝书清洗 body 当正文。

## 接口及持久范围

- `TTSource.capture(categories)` 用于人工预览/重新核对；显式输入最多 32MiB。
- `captureLocal(start,count)` 最多16条和两侧邻居，事件只是线索；观察代次、聊天身份、数量及目标版本需一致。
- `Importer.preview/confirm/resume` 两主入口；已有绑定优先。分叉输入限制到含端点 cutoff，不携带其后的摘要或无范围的可选资料；空续聊绑定保留原 Head 和前缀偏移。
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
含桥接请求的新包需要本提交之后的读者：旧读者在未知请求处拒绝审计，不降级或删记录。
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
