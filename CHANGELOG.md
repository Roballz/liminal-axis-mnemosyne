# 更新记录

## 2026-09-21 T-03 P3-R1/R2返修

- 按main@d3726c9上的集成review，统一fork标签复用下的精确成员判定，保留结构共享与合法显式导入。
- 记忆校验、basis适用性、执行图、状态及纠错解析采用有界active/done工作集，保留拒环、current/checkpoint和R5；超限明确RESOURCE_LIMIT。
- 新增修复前失败对照、共享DAG逻辑访问计数、coordinator拒绝不变性及重开/完整恢复回归。原314项保留；协议v0.7、task和高难交接同步，状态implemented_unverified，自动维护门禁及P4/P5边界不变。

## 2026-09-20 T-03 P3三项端到端分页集成

- 从main@2f11c5b继续原P3；普通历史增量、记忆/纠错、绑定接入共享分页结构，单点发布、持久请求/结果索引及恢复checkpoint接通。v2逻辑指纹与语义保留，独立history-delta简写和分页格式边界写入09 v0.6。
- 固定页目录完整流式恢复：严格解析、暂存、页/引用核对、持久ID重编译审计后激活，保留确认和pending材料；不物化整个业务库。
- 314/314回归、52文件语法；66次提交/132消息/108万合成字符增长包恢复。真实隔离TT分页发布前/后强杀恢复通过；自动维护仍HOST_MAINTENANCE_UNSUPPORTED，未改TT/切B2/A。
- 更新原task、高难交接及受影响文档。仅受控集成为implemented_unverified，整个T-03与生产/手机未完成，P4/P5未开工。后续按用户偏好单线执行、按阶段切模型，不开子代理并发。

## 2026-09-20 T-03 P3受控隔离增量：有界基元与完整v1恢复

- 依专项回审从main@ea1eca4继续；新增不可变页、AVL目录/计数序列及JSON局部路径基元，保留自动外部维护门禁。业务编译/分页发布尚未集成，不将S05或整个P3标为完成。
- 新增现有intent格式完整业务恢复材料流，包含prepared请求/生成ID及logical、journal、ledger、markers；严格文本/资源限制，空目标暂存、持久回读审计后激活。恢复身份独立版本化，旧读者拒绝以保护staging。
- 275/275回归（保留原211），36文件语法通过；最终隔离TT 20260920p3e完成完整恢复、分页回读及新intent发布前/后强杀，与独立原ID/结果对照。证据见evals/t03/p3-structures-recovery。
- 更新原task、高难交接、S-A、README与协议v0.5。当前增量implemented_unverified；自动维护、普通业务有界化、分页checkpoint/规模化恢复和P4/P5/手机仍待完成。无新任务卡、TT修改或B2/A切换。

## 2026-09-20 T-03 P3前置增量：持久请求与维护缺口

- 拉取main至bd1f0e4并依G1最终回执进入原T-03 P3；新增独立版本化请求/生成ID准备与重开枚举，历史、记忆选择/纠错、绑定可按原operation恢复去重。仍保留P2上限，完整有界结构/恢复未实施。
- 新协调入口提供合作式维护排空/失效handle/身份与发布边界检查。固定TT公开API缺少原生代次隔离；两次隔离原生验证均复现旧handle重开后仍可写同名namespace，停止自动维护路径并带证据回审，不切B2/A。
- 原150项加新增61项共211/211通过，28文件语法通过；原生证据、部署哈希与校验见evals/t03/p3-prerequisites。没有新的真实sync/archive、断点强杀或手机验证。
- 更新原task、S-A、README、协议v0.4及notes/t-03-p3-handoff.md。P3部分实施/受阻，T-03仍in_progress；不创建新任务、不进入P4/P5。

## 2026-09-19 G1-R1/R2返修验证完成（待Chat review）

- 在固定 TT Canary 隔离副本上完成 `20260919g1`：旧 owner 关闭后 recover/read/native IO 分别拒绝为 `OWNER_CLOSED`/`STALE_HANDLE`/`OWNER_CLOSED`，替代 owner 重开保留确认状态和2条账本。
- 缺 `tip` 的 root 与已存在但 `payload:null` 的节点均报 `NEEDS_RESOLUTION`；物理节点数保持20，未降级为空库。证据、最终150项TAP、23文件语法结果和SHA-256清单见 `evals/t03/g1-repair/`。
- G1仍停在Chat review；P3未执行，T-03未完成，不创建下一张任务卡。

## 2026-09-20 G1-R1/R2返修检查点（用户要求暂停）

- 成功关闭的owner永久失效，失败关闭保留registry/同一队列；open/close竞争与旧owner原生IO受归属检查。
- 严格区分缺记录与损坏payload/root，要求显式合法tip/staging；不改变持久格式和发布顺序。
- 旧版定向18项中8项失败；修复后原131+新增19共150项通过。两处旧关闭测试调整为永久终止后的安全重开，保留状态/账本断言。
- 小型原生验证及最终语法/diff/哈希清单pending；代码未commit/push。按用户要求更新任务/导读后暂停，G1未放行，P3未执行。

## 2026-09-20 T-03 P0～P2（G1待review，整任务in_progress）

- 增加有硬上限的B1存储原型：变化记录/独立账本、单点发布、未知结果门禁、共享写队列、精确回读恢复及暂存空库导入。没有P3块树或生产业务入口。
- 契约UUID/SHA运行时适配TT WebView；保持JCS/指纹/领域语义与逻辑包v2。没有新增依赖。
- 隔离TT Canary367b0c7真实验证复杂JSON、发布前/发布后丢确认强杀恢复、小库导出恢复、并发/取消/句柄与中断导入。发现物理NodeId0不可写，适配映射为1；失败记录原样保留。
- Node131项通过（原66+新增65），原始TAP及原生合成证据入evals/t03；文档09和正式任务说明规模/维护/ID保留限制。G1未放行，未进入P3、未关闭T-03、未创建下一张卡；现用档案/手机/付费API未操作。

## 2026-09-19 T-03 正式任务发布（planned）

- 按用户授权核对4dcdaf5仓库基线与T-02最终契约，新增 `tasks/T-03-storage-foundation.md`；旧proposal改为superseded历史入口，原完整预案保留在Git历史。
- 固定1891043/06 v0.3/schema_version=1/逻辑包v2；存储必须保留checkpoint/current、分支corrections、R5选择交叉校验、幂等及完整恢复材料。
- 高难前置：P0必要前提 → P1提交/幂等/恢复协议 → P2极小真实TT故障闭环 → G1 review → P3有界清单/一致备份恢复 → P4索引/资源/设备验证 → P5诊断与说明。首次只允许P0～P2，G1未放行不得扩建。
- 不预先绑定B1数据库；能力不足时B2/A仍交Chat/用户选择。补充取消等待不等于原生写入取消、完整历史command/目录重复落盘的放大风险；不把内存oracle直接当生产存储。
- 收紧备份承诺到当前已建模对象及独立版本化恢复材料；默认合成数据、隔离桌面验收，手机另行安全准入；性能先探索测量，不编造达标阈值。
- 同步S-A、AGENTS与README。仅文档发布，未编写实现、未执行测试、未安装/升级TT、未读写真实档案、未选定生产provider。

## 2026-09-19 T-02 最终 Chat review（verified）

- 审核实现 `1891043`，R5 导入/选择交叉不变量与最终注入保护通过；R1～R5 在最小可执行契约范围全部关闭，T-02 升为 verified。
- Chat 在隔离 Linux / Node v22.16.0 校验13个源码/测试/样例blob后独立运行48项契约测试和11文件语法检查，全部通过；同组R5测试在实际旧memory blob上6项失败，在本次实现通过。
- 探针18项、完整diff检查及Windows合计66项通过仍单独注明为Codex回报，不混称Chat独立66项。完整结论、证据与边界见 `notes/t-02-final-review.md`。
- 同步任务、阶段导读、06契约、README及AGENTS；当前基线为06 v0.3 / schema_version=1 / 逻辑包v2。未修改实现、未执行持久化或手机联调；T-03卡保持proposal且未修改、未执行。

## 2026-09-19 T-02 R5 返修（implemented_unverified）

- 基线28b94d4：补齐selections/corrections交叉不变量，拒绝正确checksum但所选根版本已被纠正的矛盾逻辑包；最终注入检查同样拒绝已纠正旧摘要。
- 保留合法未纠正历史检查点、非当前历史纠错终点及固定子线隔离，不删除selection校验，不重写R1～R4；字段/schema/逻辑包版本不变。
- 新增6项确定性反例与正例，旧实现6项均失败，修复后原42项+新增6项契约及18项探针通过。未执行持久化/TT/手机验证，T-03未修改、未执行，待Chat复核。

## 2026-09-19 T-02 R1～R4 返修（implemented_unverified）

- 基线a679a20，落实Chat组合反例：同Record显式checkpoint/advance、分支corrections与历史检查点纠错；current依赖仍复核selection，执行图采用active/done检测环，拒绝伪拓扑顺序。
- HostBinding不可原地跨Story；derived-only同Branch声明前缀不变时续聊可用，前缀变化待确认，本轮必需不可用不再聚合为empty。
- 原32项不改动；新增10项确定性组合测试，总计42项契约+18项探针通过。逻辑包v2保留纠错关系，v1校验后显式补空关系，旧ID/输入指纹不改。
- 06 v0.3及样例说明/任务回报同步，待Chat二次review。无真实数据、持久化/手机验证；T-03卡与探针实现不改。

## 2026-09-19 T-02 实施（implemented_unverified）

- 基于 1f01168 新增 packages/contracts：显式字段/跨引用校验、不可变快照/分块共享 oracle、固定 fork、历史操作幂等和 expected Head、来源/coverage 逐层有效性与重建计划、prepare 过期门禁、逻辑包校验。
- 覆盖 A01～A18，含父线改历史不误伤子线、跨 cutoff 泄露、区间插删/非连续事件复核、摘要修正、范围外追加可复用、幂等确认丢失及错误分支。最终命令/结果与实际代码量见 T-02 回报。
- 06 升至 v0.2/schema_version=1；更新当前 prepare 样例、模块样例普通可见性、README/阶段/架构/路线中的旧术语。历史宿主证据及探针代码未改。
- 无新增依赖、真实剧情/付费模型/数据库/持久化或手机联调；derived-only 精确快照范围为待 review 的安全下界。T-03 预备卡未修改、未执行，T-02 不升 verified。

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
- T-00 路径补全：确认柏宝书 1.2.9 实际源码与 commit `32dbb48a0a643804256d496bc35bf7699dea9ebe`，确认测试聊天 JSONL 的实际路径与字段边界；首轮运行时 payload 与取消／切聊天转入 T-01。
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
