# Liminal Axis: Mnemosyne

*A memory system for stories that refuse to remain fictional.*

面向长篇 AI RP 的平台无关持久化叙事记忆与检索基础设施。

> 核心原则：记忆属于 Mnemosyne，平台只是适配器。

## 当前状态

2026-09-22：**S-A 与 Stage-B（T-04～T-05）均已在受控能力范围 verified。** T-05 最终审核实现为 `11e5eef`，回执见 `notes/t-05-final-review.md`：手动正文搜索、旧摘要/历史查看、固定版本分页、档案回退与完整库导出已收口。当前不自动进入 T-06/T-07；如先做日常试用，只需另行规划薄的安装/固定入口/既有库选择封装，不需要新的存储后端或 A 服务器。

T-04最终回执为 `notes/t-04-final-review.md`，审核实现5fe2706；原会话25/25正文、2/2摘要complete，正文/候选槽/摘要逐项相等、源及正文Head不变、pending为空、关闭成功。历史证据在 `tasks/T-04-readonly-import-and-sync.md`；不因开始T-05重新导入或复测这份档案。

T-05默认查单一Story/Branch的当前已发布正文，旧快照显式选择，旧摘要作为有来源标签的辅助资料。先用有界分页扫描和临时搜索投影，不加载全库，不把“本批未找到”说成“全库没有”；来源跳转不可靠时回退到档案原文。向量/BM25自动召回及新摘要生成分别在T-06/T-07，不提前实施。

## 已验收的地基及限制

T-02 以 `1891043` 为最终审查实现，冻结身份、固定历史快照/分叉、版本来源、检查点、纠错传播与逻辑包校验；仅是最小契约/参考模型，不代表全部业务已实现。

T-03 最终回执为 `notes/t-03-capability-final-review.md`，审核基线 de67c55（实现父提交 c1fce16）。受控 TT 接口、已验证正确性、分页提交/故障恢复和有限工作集已验收；旧机30分钟原生1x未完成不再阻塞后续接口开发，但未执行部分、5x/10x、手机容量/延迟与真实B→A迁移仍未验证。

自动外部维护继续 `HOST_MAINTENANCE_UNSUPPORTED`，合作式维护必须排空。只读导入源或只读工作台不消除目标库维护风险；当前不授权生产手机、长期真实档案、共享TT、新的破坏性测试或自动GC。B本机路线可在已有隔离条件推进，不等于生产准入或A服务已交付。

## 从哪里开始

先读 `AGENTS.md` → `stages/S-B-archive-and-search.md` → 用户指定的任务。旧roadmap/task中的历史状态不能覆盖最新阶段政策与最终回执。

| 文件 | 用途 |
| --- | --- |
| `tasks/T-05-manual-search-and-workbench.md` | planned，当前正式卡：手动搜索、固定版本分页、旧摘要/来源查看与最小工作台 |
| `stages/S-B-archive-and-search.md` | 当前阶段目标、已确认事项、权限与测试预算 |
| `notes/t-04-final-review.md` | T-04受控验收及真实原会话内容核验，覆盖旧待审状态 |
| `tasks/T-04-readonly-import-and-sync.md` | verified（受控范围）：只读导入、精确映射、暂停/确认与恢复的实施证据 |
| `docs/11-stage-b-import-policy.md` | 导入白名单、两主入口、删除人工处理、配对及手动搜索匹配边界 |
| `stages/S-A-foundation.md` | 已收口地基及未验证项 |
| `notes/t-03-capability-final-review.md` | T-03最终能力验收，覆盖旧P3/P4/P5待审状态 |
| `notes/t-02-final-review.md`、`docs/06-contracts.md` | T-02最终契约、逻辑包v2与正确性边界 |
| `docs/08-history-snapshot-and-rebuild.md` | Head、正文权威、来源重建与分叉设计 |
| `docs/09-storage-provider-and-recovery.md` | 存储provider、分页/发布/恢复与维护限制 |
| `docs/10-t03-storage-operations.md` | 隔离诊断与备份回退，不是手机生产运维承诺 |
| `docs/03-decisions-and-open-questions.md` | 历史决策；Stage-B新确认由11文档细化 |
| `docs/01-architecture.md`、`docs/02-roadmap.md` | 总体路线；旧服务器/Leaf示意不覆盖当前B路线与契约 |
| `docs/04-working-with-chatgpt-codex.md`、`docs/05-source-review.md` | 协作规则及固定外部来源/宿主证据 |
| `tasks/T-03-storage-foundation.md`、`evals/t03/` | T-03完整历史实施记录与原始实验材料 |
| `CHANGELOG.md`、`examples/`、`evals/acceptance.md` | 变更历史与人工/合成示例，不是真实RP数据 |

## 实现、测试和数据边界

已有实现位于 `apps/tt-adapter-probe/`、`apps/tt-import/`、`packages/contracts/`、`packages/storage/`、`packages/bridge/`。回归入口见当前任务卡，含bridge集合；没有新代码/失败依据不因阅读文档重新运行。T-04既有验证是R1/R3/R2候选一次345/345全量，现场null候选修复另有1项针对性测试，以及原会话查询和43.343秒实际续传/内容核验；不能合称最终代码另跑346项。Chat最终review只审阅源码与提交证据，未独立重跑测试或TT。

T-05本次仅发布文档，未编写实现或运行测试。后续按S01～S08风险清单：短反例/受影响集成先行，最终候选稳定后一次全量、一次小型隔离功能演示；文档变更不测。T-05不跑旧机1x/5x/10x或旧强杀矩阵，不重导私人样本。新长原生循环/破坏性操作/设备变更需单独许可；预算到点不启动下一页/动作，单独核对在途排空和关闭。无新阻塞可在已授权任务内持续推进，检查点提交不是新审批关卡。

B/A共用Mnemosyne领域身份、规则和逻辑材料，宿主stableId与数据库NodeId不是正式主键。用户主要单手机长期RP，采用单权威写入和明确设备交接，不建设离线多主自动合并。

本私有仓库保存代码和工程文档，不保存真实聊天、模型密钥、生产日志/配置或数据库备份。默认合成与明确获准的脱敏样本。未来复用外部实现需核查许可；读取公开DTO不等于可以写回原插件。

accepted表示方案确认，planned表示任务发布，implemented_unverified表示待Chat验收；verified也必须带上对应范围，不能冒充手机生产可用。T-05通过后S-B才可在受控范围收口；本次不创建或启动T-06。
