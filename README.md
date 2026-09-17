# Liminal Axis: Mnemosyne

*A memory system for stories that refuse to remain fictional.*

面向长篇 AI RP 的平台无关持久化叙事记忆与检索基础设施。

> 核心原则：记忆属于 Mnemosyne，平台只是适配器。

## Mnemosyne Blueprint v0.1

2026-09-17 · 设计与实施基线

这不是已完成的软件，目前还没有可启动的记忆服务。当前仓库保存 Mnemosyne 的可版本化建设基线：独立后端、TT 适配器、可复用管理界面、可选 MCP，以及后续实现需要遵守的接口、验收与数据保护约束。

## 从哪里开始

先读 `docs/01-architecture.md` 的第 0～3 节和第 15～17 节；开发前读 `AGENTS.md`。完整开发清单在 `docs/02-roadmap.md`，第一项具体任务是 `tasks/T-00-baseline-and-probe.md`。未确定的决策不能由编码助手默认为已批准。

| 文件 | 用途 |
| --- | --- |
| `docs/01-architecture.md` | 需求、边界、数据与生成链路 |
| `docs/02-roadmap.md` | 分阶段任务、依赖、验收与回退 |
| `docs/03-decisions-and-open-questions.md` | 建议基线与实验／延后事项 |
| `docs/04-working-with-chatgpt-codex.md` | 文档怎么存、讨论怎么转成代码 |
| `docs/05-source-review.md` | 柏宝书／TT 源码核验及官方来源 |
| `docs/06-contracts.md` | 接口与示例的实现约束 |
| `evals/acceptance.md` | 功能、正确性与规模验收场景 |
| `examples/` | 人工样例，不含真实 RP 数据 |
| `AGENTS.md` | 给 Codex／编码助手的仓库工作约束 |
| `CHANGELOG.md` | 文档版本更新记录 |

## 仓库结构

当前阶段以文档为主。实现阶段再逐个增加 `apps/memory-server`、`apps/tt-adapter`、`apps/workbench` 与 `packages/domain`、`packages/contracts`、`packages/context-compiler`。不要一次生成一堆未验证的空实现来冒充项目进展。

代码与工程文档以本私有 GitHub 仓库为主版本。真实聊天、模型密钥、数据库备份和生产配置保存在独立受控的数据存储中；即使仓库是私有的，也不提交生产密钥或真实 RP 档案。

## 当前状态

已完成：v0.1 架构、路线、接口示例与验收设计；项目已建立私有 GitHub 主仓库。

未完成：代码实现、VPS 部署、TT 真机联调、实际数据导入与性能测量。

本仓库未复制柏宝书实现代码，也未导入真实聊天。未来若复用现有项目代码，先单独核查其许可证与发布条件。
