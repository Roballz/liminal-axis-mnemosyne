# Liminal Axis: Mnemosyne

*A memory system for stories that refuse to remain fictional.*

面向长篇 AI RP 的平台无关持久化叙事记忆与检索基础设施。

> 核心原则：记忆属于 Mnemosyne，平台只是适配器。

## 当前状态

2026-09-19：T-00 环境基线、T-01 TT 接入探针、T-02A 身份/事件验证及 T-02 最小可执行契约均已通过 review。仓库包含隔离 TT 探针、契约参考模型与建设文档，**不是已完成的记忆产品**。

已验收：**T-02 身份、历史版本与上下文契约，verified**。审核实现为 `1891043`，R1～R5 已关闭；Chat 独立复跑48项契约与11文件语法检查通过，R5同组测试在修复前实际旧版6项失败、修复后通过。Head、固定分叉、逐层失效、幂等和逻辑包校验限Node参考模型范围，不等于已有正式记忆引擎或持久化。证据见 `notes/t-02-final-review.md`。

当前正式任务：**T-03 可迁移、可恢复存储地基，in_progress**，入口 `tasks/T-03-storage-foundation.md`。2026-09-20：P0～P2小原型已交证据，**停在 G1 待 Chat review，P3～P5未执行，整个任务未完成。** 旧 proposal 已 superseded。

当前检查点：G1首轮提出R1/R2；返修代码、150项Node回归和隔离TT小验证已完成，证据见 `evals/t03/g1-repair/`；23个相关源码文件语法检查与diff检查通过。G1仍待Chat review，P3未执行，T-03未完成。评审见 `notes/t-03-g1-review.md`，本次状态见正式task末节。

隔离 TT Canary `367b0c7e9410` 的小样本发布前/后强杀恢复、幂等和空库恢复已实测；Node131项通过。B1生产选型尚未通过G1，完整有界存储、正式剧情导入和手机使用未验收。协议/限制见 `docs/09-storage-provider-and-recovery.md`，原始证据见 `evals/t03/`；不冒充A服务器已经交付。

## 从哪里开始

先读 `AGENTS.md`、`stages/S-A-foundation.md`，再读当前用户指定的任务。不要根据旧 Blueprint 示例自行推断产品决定；历史文档中的任务状态以最新阶段导读为准。

| 文件 | 用途 |
| --- | --- |
| `tasks/T-03-storage-foundation.md` | 当前 in_progress：P0～P2 回报、G1待review与最终验收 |
| `tasks/T-03-storage-foundation.proposal.md` | superseded，仅保留旧预案历史入口 |
| `tasks/T-02-identity-version-context.md` | 已 verified：实施证据、原验收范围与最终 Chat review |
| `notes/t-02-final-review.md` | T-02 最终结论、独立实测、R5关闭与未验证边界 |
| `packages/contracts/` | T-02 最小形状/跨引用校验、内存参考逻辑与确定性测试 |
| `docs/08-history-snapshot-and-rebuild.md` | 已接受的 Head、正文权威、来源重建与分叉边界 |
| `docs/03-decisions-and-open-questions.md` | 当前决定、未决项与实验门禁 |
| `docs/06-contracts.md` | v0.3 / schema_version=1、逻辑包v2；已验收最小契约基线 |
| `docs/07-t02-contract-proposal.md` | 首轮候选讨论；新确认以 03/08 为准 |
| `docs/01-architecture.md`、`docs/02-roadmap.md` | 总体架构与后续路线；当前进度以阶段导读和 task 为准 |
| `docs/04-working-with-chatgpt-codex.md` | 协作与交接流程 |
| `docs/05-source-review.md` | 宿主/外部来源核验及真机边界 |
| `evals/acceptance.md`、`examples/` | 验收场景与人工样例，不是真实 RP 数据 |
| `CHANGELOG.md` | 变更记录 |

## 实现与数据边界

已有实现位于 `apps/tt-adapter-probe/` 与 `packages/contracts/`。后者使用 Node 原生测试，不新增服务或依赖安装。运行 `node --test packages/contracts/tests/*.test.mjs`；当前测试及局限见 T-02 实施回报和最终review。探针18项及Windows合计66项通过为Codex回报，最终review明确区分各自实测范围；本轮发布T-03没有重新执行这些测试。

2026-09-20新增 `packages/storage/` P0～P2小原型；本轮重新运行原66项及新增65项，共131项通过，原始结果在 `evals/t03/node-tests.tap`。历史发布时未测试与此次实施重跑分开记录。

B/A 共用 Mnemosyne 的领域身份、规则与逻辑导出；宿主 stableId、数据库 NodeId 与物理文件格式不能替代正式 ID。用户主要在单手机长期 RP，已接受单权威写入与跨端明确交接，不建设离线多主自动合并。

代码和工程文档以本私有 GitHub 仓库为共享基准。真实聊天、模型密钥、数据库备份与生产配置留在独立受控数据存储；即使仓库私有，也不提交这些数据。T-03默认虚构样本、隔离测试库，不授权改生产手机或真实档案。

本仓库未复制柏宝书实现代码，也未导入真实聊天。未来若复用外部代码，先核查许可证与发布条件。任何 task 的 planned/implemented_unverified/verified 状态都与方案 accepted 分开；预备卡不得自动成为施工任务，正式卡也不得跳过其内部关卡。
