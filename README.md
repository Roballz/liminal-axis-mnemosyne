# Liminal Axis: Mnemosyne

*A memory system for stories that refuse to remain fictional.*

面向长篇 AI RP 的平台无关持久化叙事记忆与检索基础设施。

> 核心原则：记忆属于 Mnemosyne，平台只是适配器。

## 当前状态

2026-09-21：**S-A已在受控能力范围收口；当前S-B/T-04。首轮Chat review未通过，R1/R3/R2返修候选已通过345项Node回归，真实插件已读到25条原文/2份摘要，导入超短时预算并暂停，落盘核验未完成；状态implemented_unverified，T-05不启动。**

当前入口是 `tasks/T-04-readonly-import-and-sync.md`：只读迁入 TT 原文和柏宝书旧摘要，可选薄接物品/地点/生活档案，精确映射与可恢复影子同步，删除/复杂变化人工确认。此阶段不照搬旧插件实体 schema，不生成新摘要、不注入、不建设 A 服务器。

T-05 后续提供用户手动原文搜索与最小工作台；向量/BM25自动召回及新摘要生成分别在 T-06/T-07。不要把任务卡发布视为功能已经可用。

## 已验收的地基及限制

T-02 以 `1891043` 为最终审查实现，冻结身份、固定历史快照/分叉、版本来源、检查点、纠错传播与逻辑包校验；仅是最小契约/参考模型，不代表全部业务已实现。

T-03 最终回执为 `notes/t-03-capability-final-review.md`，审核基线 de67c55（实现父提交 c1fce16）。受控 TT 接口、已验证正确性、分页提交/故障恢复和有限工作集已验收；旧机30分钟原生1x未完成不再阻塞后续接口开发，但未执行部分、5x/10x、手机容量/延迟与真实B→A迁移仍未验证。

自动外部维护继续 `HOST_MAINTENANCE_UNSUPPORTED`，合作式维护必须排空。只读导入源不消除目标库维护风险；当前不授权生产手机、长期真实档案、共享TT、新的破坏性测试或自动GC。B本机路线可在已有隔离条件推进，不等于生产准入或A服务已交付。

## 从哪里开始

先读 `AGENTS.md` → `stages/S-B-archive-and-search.md` → 用户指定的任务。旧roadmap/task中的历史状态不能覆盖最新阶段政策与最终回执。

| 文件 | 用途 |
| --- | --- |
| `stages/S-B-archive-and-search.md` | 当前阶段目标、已确认事项、权限与测试预算 |
| `tasks/T-04-readonly-import-and-sync.md` | implemented_unverified：只读导入、精确映射、暂停/确认与恢复的实施证据 |
| `docs/11-stage-b-import-policy.md` | 本轮导入白名单、两主入口、删除人工处理、配对及手动搜索边界 |
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

已有实现位于 `apps/tt-adapter-probe/`、`packages/contracts/`、`packages/storage/`。既有 Node 回归入口：`node --test packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js`。T-03最近完整333项为Codex记录，见 `evals/t03/p4-repair/`；不把历史通过数当作T-04已运行。

测试按风险清单执行：短反例/相关回归先行，最终候选稳定后一次全量；文档变更不自动重跑。T-04不跑旧机1x/5x/10x；长原生循环/新强杀/设备变更需单独许可。无新阻塞可在已授权任务内持续推进，检查点提交不是新审批关卡。

B/A共用Mnemosyne领域身份、规则和逻辑材料，宿主stableId与数据库NodeId不是正式主键。用户主要单手机长期RP，采用单权威写入和明确设备交接，不建设离线多主自动合并。

本私有仓库保存代码和工程文档，不保存真实聊天、模型密钥、生产日志/配置或数据库备份。默认合成与明确获准的脱敏样本。未来复用外部实现需核查许可；读取公开DTO不等于可以写回原插件。

accepted表示方案确认，planned表示任务发布，implemented_unverified表示待Chat验收；任何一种都不能冒充手机生产可用。T-04完成后review，T-05尚未发布，不自动顺延施工。
