# Liminal Axis: Mnemosyne

*A memory system for stories that refuse to remain fictional.*

面向长篇 AI RP 的平台无关持久化叙事记忆与检索基础设施。

> 核心原则：记忆属于 Mnemosyne，平台只是适配器。

## 当前状态

2026-09-19：T-00 环境基线、T-01 TT 接入探针、T-02A 身份/事件验证已通过 review。仓库包含隔离 TT 探针与建设文档，**不是已完成的记忆产品**。

当前待执行：**T-02 身份、历史版本与上下文契约**。Head 采用不可变快照与分块共享历史清单；正文是已发生剧情的权威，普通 User + Assistant 一轮一份记忆，受影响总结/事件按来源逐层重建。

后续预备：**T-03 可迁移、可恢复存储地基**，目前仅 proposal。优先评估依托 TT 的本机 B provider，保留迁往独立服务器 A provider 的能力；数据库尚未定型，实际持久化、恢复、正式剧情导入和手机生产使用未完成。

## 从哪里开始

先读 `AGENTS.md`、`stages/S-A-foundation.md`，再读当前用户指定的任务。不要根据旧 Blueprint 示例自行推断产品决定。

| 文件 | 用途 |
| --- | --- |
| `tasks/T-02-identity-version-context.md` | 当前 planned 任务：契约、最小参考逻辑与正反例测试 |
| `tasks/T-03-storage-foundation.proposal.md` | T-03 预案；T-02 review 后修订启用，不能自动施工 |
| `docs/08-history-snapshot-and-rebuild.md` | 已接受的 Head、正文权威、来源重建与分叉边界 |
| `docs/03-decisions-and-open-questions.md` | 当前决定、未决项与实验门禁 |
| `docs/06-contracts.md` | 契约说明；旧建议样例由 T-02 对齐成可执行规范 |
| `docs/07-t02-contract-proposal.md` | 首轮候选讨论；新确认以 03/08 为准 |
| `docs/01-architecture.md`、`docs/02-roadmap.md` | 总体架构与后续路线；当前进度以阶段导读和 task 为准 |
| `docs/04-working-with-chatgpt-codex.md` | 协作与交接流程 |
| `docs/05-source-review.md` | 宿主/外部来源核验及真机边界 |
| `evals/acceptance.md`、`examples/` | 验收场景与人工样例，不是真实 RP 数据 |
| `CHANGELOG.md` | 变更记录 |

## 实现与数据边界

目前实现位于 `apps/tt-adapter-probe/`。T-02 按需增加最小 contracts/测试目录，不一次生成大量空应用或提前搭建完整服务。

B/A 共用 Mnemosyne 的领域身份、规则与逻辑导出；宿主 stableId、数据库 NodeId 与物理文件格式不能替代正式 ID。用户主要在单手机长期 RP，已接受单权威写入与跨端明确交接，不建设离线多主自动合并。

代码和工程文档以本私有 GitHub 仓库为共享基准。真实聊天、模型密钥、数据库备份与生产配置留在独立受控数据存储；即使仓库私有，也不提交这些数据。

本仓库未复制柏宝书实现代码，也未导入真实聊天。未来若复用外部代码，先核查许可证与发布条件。任何 task 的 planned/implemented_unverified/verified 状态都与方案 accepted 分开；预备卡不得自动成为施工任务。
