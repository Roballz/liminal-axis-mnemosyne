# Liminal Axis: Mnemosyne

*A memory system for stories that refuse to remain fictional.*

面向长篇 AI RP 的平台无关持久化叙事记忆与检索基础设施。

> 核心原则：记忆属于 Mnemosyne，平台只是适配器。

## 当前状态

2026-09-20：T-00 环境基线、T-01 TT 接入探针、T-02A 身份/事件验证及 T-02 最小可执行契约均已通过 review。仓库包含隔离 TT 探针、契约参考模型和有硬上限的存储原型，**不是已完成的记忆产品**。

已验收：**T-02 身份、历史版本与上下文契约，verified**。审核实现为 `1891043`，R1～R5 已关闭；Chat 独立复跑48项契约与11文件语法检查通过，R5同组测试在修复前实际旧版6项失败、修复后通过。Head、固定分叉、逐层失效、幂等和逻辑包校验限Node参考模型范围，不等于已有正式记忆引擎。证据见 `notes/t-02-final-review.md`。

当前正式任务：**T-03 可迁移、可恢复存储地基，in_progress**，入口 `tasks/T-03-storage-foundation.md`。**48663c4 已通过 G1，G1-R1/R2关闭，允许继续B1路线的P3；P3～P5尚未验收，整个任务未完成。** 旧 proposal 已 superseded。

**P3 当前交接（2026-09-20）：** 已实施持久请求/生成ID恢复与合作式维护诊断入口，仍保留P2上限。固定TT的namespace调用缺少原生代次隔离，已取得旧handle重开后仍可写的原生反例；自动外部维护路径受阻，有界存储/完整恢复未实施。见 `notes/t-03-p3-handoff.md`，不宣告P3或整个T-03完成。

当前关卡回执：`notes/t-03-g1-final-review.md`。Chat对齐15个文件blob后独立复跑84项存储测试及15文件语法，全部通过；同一最终19项定向测试在实际旧实现上10通过/9失败。完整150项Node回归、23文件语法/diff和隔离TT小验证为Codex提交的证据，本轮明确区分独立执行与证据审阅。

隔离 TT Canary `367b0c7e9410` 的小样本发布前/后强杀恢复、幂等和空库恢复，以及本次owner生命周期/异常root读取已有有限现场证据。B1获准作为下一增量实施路线，**不是手机生产provider最终准入**；持久请求已有小规模前置诊断实现；自动外部维护隔离受阻，有界结构、完整恢复及手机使用仍待完成。协议/限制见 `docs/09-storage-provider-and-recovery.md`，原始证据见 `evals/t03/`，返修证据见 `evals/t03/g1-repair/`；不冒充A服务器已经交付。

## 从哪里开始

先读 `AGENTS.md`、`stages/S-A-foundation.md`，再读当前用户指定的任务。不要根据旧 Blueprint 示例自行推断产品决定；历史文档中的任务状态以最新阶段导读及最终关卡回执为准。

| 文件 | 用途 |
| --- | --- |
| `tasks/T-03-storage-foundation.md` | 当前 in_progress：原任务范围、P0～P2实施证据及P3～P5要求 |
| `notes/t-03-g1-final-review.md` | G1通过、R1/R2关闭、独立测试边界与P3高难前置要求 |
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

实现位于 `apps/tt-adapter-probe/`、`packages/contracts/` 和 `packages/storage/`。Node回归命令为 `node --test packages/storage/tests/*.test.mjs packages/contracts/tests/*.test.mjs apps/tt-adapter-probe/tests/probe.test.js`。当前Codex完整结果为211/211（原150+P3前置61），见 `evals/t03/p3-prerequisites/`；G1最终review独立执行84项存储测试，不混称独立重跑150项。原131项记录继续保留在 `evals/t03/node-tests.tap`，不是最终返修结果。

B/A 共用 Mnemosyne 的领域身份、规则与逻辑导出；宿主 stableId、数据库 NodeId 与物理文件格式不能替代正式 ID。用户主要在单手机长期 RP，已接受单权威写入与跨端明确交接，不建设离线多主自动合并。

代码和工程文档以本私有 GitHub 仓库为共享基准。真实聊天、模型密钥、数据库备份与生产配置留在独立受控数据存储；即使仓库私有，也不提交这些数据。T-03默认虚构样本、隔离测试库，不授权改生产手机或真实档案。

本仓库未复制柏宝书实现代码，也未导入真实聊天。未来若复用外部代码，先核查许可证与发布条件。任何 task 的 planned/implemented_unverified/verified 状态都与方案 accepted 分开；预备卡不得自动成为施工任务，正式卡也不得跳过其内部关卡。
