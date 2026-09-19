# Liminal Axis: Mnemosyne

*A memory system for stories that refuse to remain fictional.*

面向长篇 AI RP 的平台无关持久化叙事记忆与检索基础设施。

> 核心原则：记忆属于 Mnemosyne，平台只是适配器。

## 当前状态

2026-09-19：T-00 环境基线、T-01 TT 接入探针、T-02A 身份/事件验证已通过 review。仓库包含隔离 TT 探针与建设文档，**不是已完成的记忆产品**。

当前交 review：**T-02 身份、历史版本与上下文契约，implemented_unverified**。已增加机器校验、内存参考模型和 A01～A18 正反例；Head 不可变快照、固定分叉和逐层失效仅在此参考逻辑中验证，不等于已有正式记忆引擎或持久化。

后续预备：**T-03 可迁移、可恢复存储地基**，目前仅 proposal。优先评估依托 TT 的本机 B provider，保留迁往独立服务器 A provider 的能力；数据库尚未定型，实际持久化、恢复、正式剧情导入和手机生产使用未完成。

## 从哪里开始

先读 `AGENTS.md`、`stages/S-A-foundation.md`，再读当前用户指定的任务。不要根据旧 Blueprint 示例自行推断产品决定。

| 文件 | 用途 |
| --- | --- |
| `tasks/T-02-identity-version-context.md` | 当前 implemented_unverified：实施证据、范围与 Chat review 事项 |
| `packages/contracts/` | T-02 最小形状/跨引用校验、内存参考逻辑与确定性测试 |
| `tasks/T-03-storage-foundation.proposal.md` | T-03 预案；T-02 review 后修订启用，不能自动施工 |
| `docs/08-history-snapshot-and-rebuild.md` | 已接受的 Head、正文权威、来源重建与分叉边界 |
| `docs/03-decisions-and-open-questions.md` | 当前决定、未决项与实验门禁 |
| `docs/06-contracts.md` | v0.2 / schema_version=1 契约、指纹字段表和迁移边界，待 review |
| `docs/07-t02-contract-proposal.md` | 首轮候选讨论；新确认以 03/08 为准 |
| `docs/01-architecture.md`、`docs/02-roadmap.md` | 总体架构与后续路线；当前进度以阶段导读和 task 为准 |
| `docs/04-working-with-chatgpt-codex.md` | 协作与交接流程 |
| `docs/05-source-review.md` | 宿主/外部来源核验及真机边界 |
| `evals/acceptance.md`、`examples/` | 验收场景与人工样例，不是真实 RP 数据 |
| `CHANGELOG.md` | 变更记录 |

## 实现与数据边界

实现位于 `apps/tt-adapter-probe/` 与 `packages/contracts/`。后者使用 Node 原生测试，不新增服务或依赖安装。运行 `node --test packages/contracts/tests/contracts.test.mjs`；当前测试及局限见 T-02 实施回报。

B/A 共用 Mnemosyne 的领域身份、规则与逻辑导出；宿主 stableId、数据库 NodeId 与物理文件格式不能替代正式 ID。用户主要在单手机长期 RP，已接受单权威写入与跨端明确交接，不建设离线多主自动合并。

代码和工程文档以本私有 GitHub 仓库为共享基准。真实聊天、模型密钥、数据库备份与生产配置留在独立受控数据存储；即使仓库私有，也不提交这些数据。

本仓库未复制柏宝书实现代码，也未导入真实聊天。未来若复用外部代码，先核查许可证与发布条件。任何 task 的 planned/implemented_unverified/verified 状态都与方案 accepted 分开；预备卡不得自动成为施工任务。
