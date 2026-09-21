# 日常搜索 demo：0.1.1 返修与性能阻塞

日期：2026-09-22。状态 implemented_unverified。起点 main cec4436；用户手机反馈27条/约9000字同步2～3分钟、旧L0漏读、气泡大且不可拖动、桌面侧栏被挤压。另明确本版优先正文及L0，L1～L4不要求全收集。未读取用户聊天、未重新导入手机大档。

## 已修复范围

- source.projectLegacy 原先在调用getFloor之前跳过raw role不是assistant的消息。安装版柏宝书32dbb48的engine.ts隐藏旧聊天时会设置is_system=true，而public/query.ts的getFloor.role仍能辨识助手。因此读取所有楼层公共DTO，并据公共role挑选助手摘要，保留原文的原始role不改写。有效性、番外和版本一致性校验不放宽；不读取extra/delta绕过白名单。
- 预览分别列出L0、隐藏楼L0、选中高层、番外、存有但失效、未存摘要数量。getHistory仍只取公开接口选中节点，不声称全量L1～L4；原始摘要结果标L0，高层仅在公开level是整数时显示相应L标签。
- 根节点使用inline important固定定位及零宽高，不作为TT flex项目占空间；Shadow host同样隔离。44px圆形M入口支持指针拖动/视口夹取，拖动后的点击不误开面板。
- Pages.put复用已有128项有界不可变页缓存，命中仍核对页内容；不同hash或淘汰后仍走物理碰撞检查。未改原生syncMode=full、发布flush、Head协议、存储格式或恢复规则。这只是少量重复读取消除，不宣称修复性能。

## 为什么小档仍慢

一次合成探针：27条、8927字、无摘要和swipe。轻量Node Map IO，无真实磁盘、Rust调用或fsync延迟；计数包括空库创建和一次完整demo建库。与有限测试同时运行，墙钟约22秒不作手机速度或优化前后对比。

- io.get：80315；io.put：31258；物理节点：31248；显式flush：22。
- 目录实际持久写23566，约占全部写入75%。缓存命中5232次普通页put和1028次目录页put，未消除数量级问题。
- 数值与调用层级见evals/manual-search-demo/0.1.1-synthetic-cost.json，复现命令node packages/demo/tests/cost-probe.mjs。脚本仅含合成数据，输出无原文。

根因链：JSON字段拆页、字符串拆块→不可变树路径复制→领域/请求/回执等对象反复编码→为众多小页建立并持久化物理目录→读取重建/校验叠加。本轮不是手机Rust存储性能结论；在无磁盘的模拟里已经出现巨大放大。现有测试验证了语义/恢复，不等于日常成本合格。

**当前路径不满足百万/千万字日常归档目标；导入性能仍为真实阻塞，不能因为其他返修完成便标为已解决。** 不继续要求用户拿大档反复导入。

## 待审的最小性能方向（不是正式任务卡，也未施工）

1. 把正文和L0按完整记录或适度大小的块编码，避免每个标量各占树节点；区分业务身份/版本与物理存储粒度。
2. 优先减少逻辑/目录页数量，再评估宿主有证据的批量持久化能力；不能假设换数据库、关同步或跳过校验就解决。
3. 明确保留旧库读取、完整导出和失败恢复的兼容路径后，才能更换编码或发布布局。现有docs/09以及AGENTS要求底层协议/数据语义变化带证据回审，本轮没有静默重写。
4. 全文搜索索引另行评估：先让导入成本随正文/摘要体量合理增长；不能用倒排索引掩盖目前写入放大。无需进入T06自动召回。
5. 验收先固定27条/约9000字的调用数及字节放大门槛，再用一次获授权的小型手机写入核对延迟；不是重跑旧1x/5x/10x矩阵。大档搜索吞吐目标应独立确定。

## 本轮有限验证

- node --test packages/demo/tests/repair.test.mjs packages/demo/tests/demo.test.mjs packages/storage/tests/pages.test.mjs packages/storage/tests/paged-recovery.test.mjs packages/workbench/tests/workbench.test.mjs：45/45。
- node --test --test-name-pattern='B01/B02/B07' packages/bridge/tests/bridge.test.mjs：1/1。既有正确反例未修改。
- 新增3条反例（隐藏500楼、缓存淘汰/碰撞、实际气泡处理器）与一次合成成本探针；不跑全仓、不跑原生强杀或手机生产数据测试。
- 浏览器合成实页：入口44×44、host position=fixed且width=0；拖动到新坐标不展开，随后点击正常开窗。真实TT侧栏和手机L0计数待用户更新后只做预览确认，不冒充已验证。
- 发布0.1.1时整棵runtime路径更新；安装分支codex/manual-search-demo。旧已完成档案可手动同步补L0；若旧版导入仍partial，先保留旧版本和固定输入处理，新增报告字段会改变指纹，不保证跨版本续传旧partial。

实际代码差异较原100～180行估算小；新增测试与探针约80行。最终统计见提交diff。保持implemented_unverified，性能阻塞留待Chat/用户收敛；不自动创建T06或更换B2/A。
