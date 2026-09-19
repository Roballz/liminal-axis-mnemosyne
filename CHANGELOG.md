# 更新记录

## v0.1 — 2026-09-17

建立独立记忆引擎／TT Adapter／Workbench 的建议边界；记录每楼叶子与跨楼事件解耦方案；定义常驻、激活、展示、录入四种策略；纳入本地自定义模块、助手提案、注入位置编译、版本与同步要求。

保留 BM25 中文实现、RRF 家族融合、事件扩展、阈值和长剧情骨架为实验／未决项。新增开发任务、验收场景和人工接口样例。

核验用户指定柏宝书提交 32dbb48a0a643804256d496bc35bf7699dea9ebe。记录 FAQ／注释与本地检索实现的差异，不将其视为当前安装包的自动证明。

未创建远程仓库，未改现有插件，未导入真实聊天。

## 2026-09-18

- 明确第一阶段 TT 探针采用隔离桌面测试环境优先，现用手机端不做首轮破坏性测试。
- 记录玩家位共同探索的记忆语义：首版不把作者预设成长、未来计划或结局定性作为核心必填字段。
- T-00 记录用户已有 ST／TT 原始聊天备份，避免重复索要已确认信息。
- 建立 Chat ↔ Codex 的仓库交接协议：阶段导读放 `stages/`，Codex 实施证据写回对应 task，不维护无限增长的交流日志。
- 新增阶段 A 导读与 T-00 用户环境基线；记录 TT 2.2.0 dev/Canary、柏宝书 1.2.9 本地模式及当前副 API 模型。
- 明确 T-02 不沿用柏宝书 `Leaf` 作为 Mnemosyne 正式领域对象名。
- T-00 首轮现场复核：确认 `E:\TauriTavern\tauritavern.exe` 为 2.2.0；安装目录未发现柏宝书扩展源码或用户聊天数据，补充 T-01 探针任务卡，待扩展入口与安全测试样本。
- T-00 路径补全：确认柏宝书 1.2.9 实际源码与 commit `32dbb48a0a643804256d496bc35bf7699dea9ebe`，确认测试聊天 JSONL 的实际路径与字段边界；运行时 payload 与取消／切聊天转入 T-01。
- 流程修正：正式任务卡由 Chat／用户创建；Codex 默认只交付当前 task 的实施证据与下一步建议，不提前生成后续 task。T-00 中“直接产出 T-01”的旧指令废止。
- Chat review 修订 T-01：补回独立 HTTPS 接入验证，真实 Memory Engine／正式身份契约留后续。
- T-01 现场验证：确认 TT 2.2.0 生成前 await、三类最终 payload、探针取消、原生 Stop、失败／超时清槽和运行时 request gate supersede；记录 HTTPS/CORS 限制及生成期间不能切聊天／并发生成。
- T-01 review 返修：修正异步 snapshot 乱序导致旧 request 夺回 active 的 gate 竞态，新增确定性 A/B 并发测试，6/6 通过。
- T-01 二次 review 通过：核对 `dd3fa38`，任务升为 verified，下一步进入 T-02 规划。
- 新增 T-02A 前置任务：用隔离 TT 真机验证 stableId/integrity、Branch、深层 Edit、Delete、Swipe/Regenerate 与 reopen/rename，禁止提前设计正式 schema。
- T-02A 实现增量：增加宿主事件参数、身份与消息/swipe 脱敏 trace 及9项纯逻辑测试；首轮 computer-use 不可控只作为历史记录。
- T-02A 探针升至 0.1.2：增加 Copy host、T-02A trace、Copy trace 面板操作。

## 2026-09-19

- T-02A 收到用户脱敏 trace：reopen/rename stableId 保持、Branch 身份变化、Edit 顺序和 Swipe 变化；Delete 与 Regenerate 降级记录，未冻结 T-02。
- T-02A 0.1.3：trace 按序号导出，windowInfo.chatRef 仅保留类型/计数/标识符哈希；integrity 缺失为 null。
- T-02A 0.1.4 review 返修：改用 handle.metadata.get()/context.chatMetadata 和 handle.summary()，旧 null 不作宿主限制。Delete 参数按删除后 chat.length；Swipe 事件定位与模型失败分开。增加拖动/观察索引及7项测试（18/18）。
- T-02A 补测：metadata 三方一致、summary 稳态计数一致、第三次 Regenerate 成功（index4、候选1→1、正文改变），Delete 明确 N5/k3/参数4及邻接平移；记录失败、过渡采样/summary 时差与 UI 确认，无 schema 决定。
- T-02A 二次 review：核对 `214dcf9` 的修复、Delete/成功 Regenerate、18/18测试与 UI 证据，任务升为 verified。
- T-02 综合讨论：新增 07/08 设计文档，收口 B 单权威写入、正文权威、匹配复用/变化逐层重建及可迁移核心；Head 在本轮前保留 proposed。
- **Head 本轮获用户明确批准**：head_snapshot_id → hs_UUIDv4 不可变快照 → 有序分块共享清单；固定 fork、回滚新快照与安全发布设计进入 accepted，物理实现/数据库恢复仍未验证。
- 新增 **T-02 planned** 卡 `tasks/T-02-identity-version-context.md`：最小契约/schema/参考模型/正反例，含原24项状态映射、范围与难度提示；不实现生产数据库或完整导入/派生引擎。
- 应用户要求新增 **T-03 proposal** 卡 `tasks/T-03-storage-foundation.proposal.md`：B provider 能力实验、选型门禁、持久化块/提交、故障恢复、逻辑导出与迁移准备。T-02 review 后修订并明确启用，不能自动执行。
- 同步决策记录、08 的批准边界、S-A、README 与 AGENTS：保留非标准回合、模糊对齐、品牌名、自动清理和数据库参数等未决；旧建议不覆盖新确认。仅文档变更，未编写实现、未执行新测试、未部署或操作用户档案。
