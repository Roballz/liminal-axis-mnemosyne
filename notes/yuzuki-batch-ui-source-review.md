# yuzuki 手动分批与自定义表：补充源码核对

日期：2026-09-23。固定源码：`gaigai315/yuzuki-Memory@14ddb8df3207f5f8e0ac8af4c93b72edce00f704`。仅静态审阅指定函数/片段，未运行测试、UI、TT或手机；不是完整审计。

当前产品规范以 `../docs/14-event-chain-mvp-proposal.md` v0.2、`../docs/15-event-batching-and-local-tables.md` 及 `../stages/S-daily-baibai-mvp.md` 为准。本轮写入时发现这些文件已有并行更新，保留其新内容；不以旧SHA覆盖。下文只补15中尚未细读的手动批次UI路径，不重新发布任务卡或另一套方案。

## 核对结果

`ui/memory-window.js`：

- `getManualPointerSettings` 读取 `state.settings.manualPointers`，trace/summary/historySummary各自独立；`updateManualPointerSetting`允许人工设置指定指针并清除该类延期标记。指针是处理位置，不是表格行数。
- `buildTaskBatches`读取start/end和batchSize；未启用分批或范围不超过批次大小时只返回单批，分批时建立多个范围。
- 任务主循环按批次顺序调用 `runTaskBatchWithRetry`，显示第几批/总批次；支持停止。失败有重试、停止或由用户选择继续后续批次的分支。成功批次后调用 `markTaskStateUpdated` 和界面刷新，再处理下一批。
- `runSingleTaskBatch`把trace/summary/优化任务分别交给TaskRunner；确认模式使用previewOnly，不能把模型返回任意文本直接当作已入库。
- 有 `normalizeCustomTables`、`loadGlobalCustomTables`、`saveGlobalCustomTables`、`upsertGlobalCustomTable` 等表定义入口，配置键为 `yzm_memory_global_custom_tables`；优先GlobalSettings，缺少时回退localStorage。这不证明全插件资料仅存在localStorage，亦不等同于每张用户表对应一张原生数据库表。

`config/task-runner.js`另直接核对：normalizePointers、buildAutoTraceTask及按范围读取正文。自动填表条件为当前聊天长度减trace指针达到批次间隔加延后量；处理范围为指针起的一个批次。源码默认间隔40、延后2不自动成为Mnemosyne默认。成功提交路径保存结果与新指针，保存失败恢复原内存状态；不是跨宿主文件/数据库事务的实机证明。

`config/floor-ledger.js`另有消息增量标记和包含swipe/signature/rows/floorScope的账本；不能只借鉴最大楼层数而忽略实际来源版本。

## 对本项目的直接意义

手动回溯“选范围、拆批、顺序执行、显示进度、停止/续跑”可借鉴。若允许跳过失败批次继续，单个最高处理位置不足以证明中间无缺口；本项目须保留每批输入ID/版本及结果回执。事件已检查无事件应合法完成，与缺字段、解析失败和待确认分开。

自定义表先采用本机表定义与行数据即可，不以VPS或远端schema为前置；具体UI/AI填表范围仍按15收口。现有柏宝书的摘要、状态和原文升级召回不因此改成yuzuki实现。

资料：
- [UI源码](https://github.com/gaigai315/yuzuki-Memory/blob/14ddb8df3207f5f8e0ac8af4c93b72edce00f704/ui/memory-window.js)
- [任务源码](https://github.com/gaigai315/yuzuki-Memory/blob/14ddb8df3207f5f8e0ac8af4c93b72edce00f704/config/task-runner.js)
- [消息账本](https://github.com/gaigai315/yuzuki-Memory/blob/14ddb8df3207f5f8e0ac8af4c93b72edce00f704/config/floor-ledger.js)

本记录未复制第三方实现。完整UI及所有保存/故障路径没有逐项审阅，不能据局部函数存在宣称上游绝不漏记或已实现跨设备一致性。
