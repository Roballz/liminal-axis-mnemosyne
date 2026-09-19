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
- T-00 路径补全：确认柏宝书 1.2.9 实际源码与 commit `32dbb48a0a643804256d496bc35bf7699dea9ebe`，确认测试聊天 JSONL 的实际路径与字段边界；运行时 payload 与取消／切聊天行为转入 T-01。

- 流程修正：正式 `T-XX` 任务卡由 Chat／用户在 review 后创建；Codex 默认只交付当前 task 的实施证据与下一步建议，不提前生成后续 task。T-00 中“直接产出 T-01”的旧指令标记为已废止。
- Chat review 修订 T-01：补回独立 HTTPS 接入验证，并保持真实 Memory Engine／正式身份契约在后续任务中处理。

- T-01 现场验证：确认 TT 2.2.0 的生成前 await、三类最终 payload、探针取消、原生 Stop、失败／超时清槽和运行时 request gate supersede；记录 HTTPS/CORS 限制，以及生成期间切聊天／并发生成的宿主限制。
- T-01 review 返修：修正异步 snapshot 乱序导致旧 request 夺回 active 的 gate 竞态，新增确定性 A/B 并发测试，逻辑测试通过 6/6。

- T-01 二次 Chat review 通过：核对 `dd3fa38` 的 gate 竞态修复与 A/B snapshot 乱序并发测试，任务升为 `verified`；阶段 A 下一步进入 T-02 方案／任务卡规划。

- 新增 T-02A 前置验证任务：在冻结 T-02 契约前，用隔离 TT 真机验证 stableId/integrity、Branch、深层 Edit、Delete、Swipe/Regenerate 与 reopen/rename 行为；禁止提前设计正式 schema。

- T-02A 探针实现增量：补充宿主事件参数、身份和消息/swipe 的脱敏 trace 与 9 项纯逻辑测试；首轮 computer-use 不可控仅作为历史现场记录，未冻结 T-02 契约。
- T-02A 探针版本升至 `0.1.2`：增加 `Copy host`、`T-02A trace`、`Copy trace` 面板操作，便于隔离 TT 手工复测并避免旧脚本缓存。

## 2026-09-19

- T-02A 收到用户提供的脱敏现场 trace：确认 reopen／rename 的 stableId 保持、Branch 产生不同 stableId、Edit 事件顺序及 Swipe 候选变化；Delete 与 Regenerate 因索引平移和模型失败分别降级记录，未冻结 T-02 契约。
- T-02A 探针升至 `0.1.3`：trace 导出按事件序号排序，`windowInfo.chatRef` 仅保留类型、计数与标识符哈希；`integrity` 不可读时以 `null` 表示未知。
- T-02A review 返修 `0.1.4`：以 `handle.metadata.get()` / `context.chatMetadata` 交叉检查 integrity；改用 `handle.summary({ includeMetadata: false })`。旧 null 是探针路径错误，不作为宿主限制。Delete 参数按删除后 chat.length 处理，Swipe 事件定位与模型失败分开记录。增加标题栏拖动、可选邻接观察索引及 7 项回归测试（总计 18/18）；成功 Regenerate、身份补采及明确 Delete 样本仍待用户实机验证。
- T-02A `0.1.4` 实机补测到齐：metadata 三方一致、summary 稳态计数一致、第三次 Regenerate 成功（同 index4，候选1→1，正文改变），明确 Delete 为 N5/k3/参数4并观测邻接平移；记录前两轮失败、过渡采样与 summary 时差，面板拖动及最小化不溢出通过。任务待 Chat review，无 schema 决定。

- T-02A 二次 Chat review 通过：核对 `214dcf9` 的 metadata/summary 修复、明确 Delete 样本、成功 Regenerate、18/18 测试与 UI 真机确认，任务升为 `verified`；正式 T-02 仍待 Chat／用户完成方案攻坚后创建。
