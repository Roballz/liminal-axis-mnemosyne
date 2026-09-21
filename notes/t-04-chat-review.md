# T-04 首轮 Chat review

日期：2026-09-21。审核实现：`ba9422c56a5f7ef5e72edbdd687f73b9a6598358`；前置文档基线：`9cb33a5`。

## 1. 结论与本轮范围

**T-04 暂不通过，保持 implemented_unverified。关闭下文 T04-R1～R3 后再交 review；T-05 不启动。** 这些是当前只读桥接/人工入口的既定语义与接线问题，不是重开 T-02/T-03，不要求复杂模糊匹配、自动剧情修复或性能优化。

没有迁移用户真实聊天，不是单独否决原因：原任务完成线明确允许独立 TT 与合成数据。必须区分“虚构内容经过真实读取接口”与“虚构 API 提供内容”。本次 native-demo 调用真实 TT 数据库，但只检测真实柏宝书 API 的方法存在/版本；导入内容来自局部 synthetic-v1 API，未调用实际插件的 getFloor/getSnapshot/getHistory 读取已有摘要。面板显示也不等于面板事件流程已经验证。

保留的成果：薄桥接白名单、原文/旧资料分离、不捏造旧摘要的完整生成输入、原分页协议内持久回执与批次、暂停/恢复、完整分页包及旧逻辑包明确拒绝降级的边界。legacy-inputs-unproven 是有明确限制的承接方式，不把它冒充正式 TurnMemory。没有发现本轮需要更换 provider 或引入 LLM 的理由。

## 2. 证据与独立执行口径

- 已读取固定提交的 task、bridge source/importer/panel/records/native-demo/tests、paged-bridge、README、verification.json，并核对改动清单。
- Codex 记录：339/339 最终全量一次、6 组 bridge 集成，原生虚构源/真实隔离数据库恢复核对。原生结果的 resumedExistingSource/resumedExistingTarget 与交接一致，不能改称新增真实源导入或重新完成一次空目标原生恢复。
- Chat 独立执行：Linux / Node v22.16.0，**7 个方法级定向模拟**，包括 2 个正向对照和 5 个待修行为。使用复制的 Importer.preview、TTSource.identity、面板通知分流逻辑，以及 applyLocal 的写前条件；宿主、存储、hash/equality 由评审替身提供。applyLocal 的写入尾部不模拟、不执行。诊断中的成功断言是确认观察结果，包含错误行为，不是 T-04 产品测试通过。
- 没有独立重跑 339 项或 6 组分页集成，没有操作 TT、真实柏宝书、真实档案或手机；没有对完整运行时做本地 blob 复验。一次直接下载失败于 DNS，未循环重试。
- 固定柏宝书公开 DTO 已核对：`Roballz/ST-BaiBai-Book@32dbb48a0a643804256d496bc35bf7699dea9ebe/src/public/types.ts`。当前评审不凭空宣称 getFloor 字段不兼容。
- TT ChatRef 已核对：`Darkatse/TauriTavern@367b0c7e9410/src/tauri/main/api/chat.js`；character ref 包含 kind、characterId、fileName。这不是对新版 TT 二进制的复测。

诊断摘要见 `evals/t04/chat-review-ba9422c.json`。完整本轮诊断输出和脚本另交用户；不把模拟读取次数或状态当作原生读写结果。

## 3. T04-R1：继承前缀与新宿主输入范围混淆（高优先级）

位置：`packages/bridge/importer.mjs` 的 preview / messageBatch；`packages/bridge/source.mjs` 的 restrictSnapshot。

### R1a：非空新文件续聊被规划成替换旧历史

preview 仅在 choice.mode=continue 且 input.messages.length=0 时设置 inherited.length 偏移。若用户已在新文件写下开场/新一轮，再明确选择“接着原剧情续聊”，代码将整个父历史当作本文件的待对账旧内容。

模拟：原分支 A/B，新文件 E/F，mode=continue。实际计划 offset=0、removed=2、changed=2；messageBatch 的删除数量公式为 oldCount-prefix-suffix=2。空文件续聊正例则 offset=2、removed=0。

此处未执行真实删除。问题是计划语义：用户选择“接着聊”不应隐含授权用新段替换旧剧情。即使预览里显示 removed，也不能把错误归类交给用户猜。对于新段、带重叠尾部副本或完整历史副本，应明确区分/确认；不能靠是否为空决定。没有充分证据时保守要求局部范围确认，不要求万能自动对齐。

### R1b：已有子分支的独有尾部被截掉

parent A/B/C/D、真实子聊天 A/B/E/F、分叉截止=2。preview 先 restrictSnapshot(input,2)，结果本次输入变成 A/B，报告 originals=2；E/F 不进入本次导入。

父线继承截止与子聊天实际输入范围不是同一个范围。若操作是在父聊天上新建截至 B 的分支，截父线 C/D 是合法的；若识别/导入的是已有子聊天，则应保留其 E/F，而不是把它误当父线未来。无法分辨这两种意图时，在现有继承面板补必要确认，不静默丢弃输入尾部，也不取消父线未来过滤。

### 返修验收

沿用固定 Head/父前缀规则；分别覆盖空文件续接、非空新段续接、完整/有重叠副本需确认、已有子线尾部、父线未来禁止继承。用真实 Importer→PagedCoordinator 小样本断言拟变更与最终历史；失败/取消时旧 Head、旧版本和其他分支保持。至少对一种继承结果做重开/完整包恢复，不扩展长测。不能只测 prefix helper。

## 4. T04-R2：可变文件定位参与来源主键，改名丢失已有绑定（中高优先级）

位置：`packages/bridge/source.mjs` TTSource.identity：`digest({ ref, stable: await handle.stableId() })`；Importer 以 input.source 查持久绑定。

固定 TT 的 character ChatRef 含 fileName。模拟在 characterId/stableId 不变时，仅改 fileName，source digest 已变化；已有绑定按旧 source 保存，新 source 无法直接找到它。正常改名由此变成未知新来源，默认预览可落入新 Story，而非更新原绑定的可变定位。

返修：宿主稳定身份、宿主/角色作用域和可变定位分离。保留原绑定的正式 ID 和历史；确证是同一来源才更新 locator/alias，冲突仍人工确认，不能把 stableId 在任何平台/副本下都当绝对全局唯一。不以文件名或搜索规范化文本作为长期身份。说明本版旧 source key/回执如何兼容/显式重绑，不删旧资料。

验收：同 stableId、同作用域改名后复用绑定/Story/Branch，不重复原文与摘要；不同作用域/同文档案仍不误合并；原生读改名不必破坏真实档案，可用同一合成测试聊天。新增实际 Importer/读取适配组合断言。

## 5. T04-R3：面板事件接线不支持正常新轮次，旧摘要通知总是暂停（高优先级）

位置：`packages/bridge/panel.mjs` 通知队列、`source.mjs` 订阅/生成状态、`importer.mjs` applyLocal/reconcile。

### 当前行为

1. GENERATION_STARTED 把绑定设为 pending。
2. GENERATION_ENDED 无论新生成还是 regenerate，都固定分派为 regenerate，读取旧 bound.count-1。
3. applyLocal 对 pending 只允许 regenerate；regenerate 又要求 total===bound.count。正常新增 User+Assistant 后，总数增加，必然不满足这项条件。
4. 方法模拟从已存2条到源4条，START→RECEIVED(生成中)→END 后的结果是 pending→paused，已存 count 仍2；不是正常 append。
5. LEGACY_CHANGED 不读/比较新的白名单资料，直接走最后的 setState(paused)。即使是普通摘要完成或无实质白名单变化的通知，也没有自动精确处理路径。

原测试直接调用 applyLocal(edit/append/regenerate) 和手工设 pending，绕过了面板如何选择这些操作；因此这些测试通过不覆盖上述接线问题。任务 I2 要求证据充分的 append、同消息版本变化及来源明确旧摘要变化可同步；不能把所有正常变化都降为手动处理而仍报告该要求完成。

### 返修原则与验收

- 先依据已知生成类型及稳定后总数/局部身份变化判断 append、regenerate、未变化或真正歧义；GENERATION_ENDED 只是结束通知，不单独证明 regenerate 成功。
- 保留 pending/取消/迟到结果、切聊天和真实删除的安全处理；不靠取消校验让 append 通过。
- 柏宝书通知仅作线索：核对实际选中类别/版本，无变化时 no-op；可确认局部旧摘要变化时保存新资产/回执，无法证明时才暂停。不要每条通知都遍历完整档案，不调用模型生成新摘要。
- 小型事件序列测试必须穿过面板/事件适配→Importer 接口，而非只手调内部函数：正常新增一轮、成功/失败 regenerate、重复通知、摘要更新及无关分类通知、切聊天/晚到结果。可组合在少量测试内，不要求为每个排列建大矩阵。

## 6. 最小真实接口补证，不要求迁移私人故事

修复稳定后，在既定隔离实例准备一份很小、已有摘要的虚构聊天，通过**实际 TTSource.capture + 实际 STBaiBaiBook 读取 + 面板确认**导入，再核对原文/实际摘要内容与来源计数。一次演示可覆盖正常新增、摘要更新、改名/继承中的代表路径及停止；完整恢复复用已有短集成，必要时核对本次新增材料。

虚构的是内容，不应再把被测读取 API 替换成 synthetic-v1。样本准备和读取应符合既有许可，不擅自改长期档案、调用付费模型或新装设备；没有获准可用样本则明确记录缺口，不伪称已测。无需要求用户交出整份真实 RP，也不将真实私人数据提交到仓库。

原 native-demo 的恢复证据仍保留；它验证了真实隔离 DB 上的虚构数据路径，只是不能替代真实源接口和事件接线证据。只打印 capability/固定 summaries:1 不能作为实际摘要已读入的唯一断言。

## 7. 续工与测试成本

继续原 T-04，优先 R1，再 R3/R2。先报告修复范围和实现/测试预计行数；针对上述有限反例与正例实施，不另造任务卡。短模拟/真实分页集成在前，最终候选稳定后一次相关全量，最后一轮短原生真实接口演示。原339项不删除，允许完善对既定语义的覆盖；不追求测试数量。

不跑1x/5x/10x、性能调参、整套强杀矩阵或无变化重复回归。超过现有小型演示预算、需要新的权限/破坏性操作时先说明并获许可。自动外部维护门禁、手机pending、旧资料不写回及不调用模型均保持。

收尾状态仍为implemented_unverified，回到T-04 review，不进入T-05。
