# liminal-axis-mnemosyne
A memory system for stories that refuse to remain fictional.

# RP Memory Blueprint

版本 v0.1 · 2026-09-17 · 设计与实施文档包

这不是已完成的软件，没有可启动的记忆服务。它是为球球的长期 RP 记忆系统准备的可版本化建设基线：独立后端、TT 适配器、可复用管理界面、可选 MCP。

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

## 建议仓库结构

现在只创建文档。实现阶段再逐个增加 `apps/memory-server`、`apps/tt-adapter`、`apps/workbench` 与 `packages/domain`、`packages/contracts`、`packages/context-compiler`。不要一次生成一堆未验证的空实现来冒充项目进展。

建议代码与文档放同一私有 GitHub 仓库；真实聊天、密钥、备份留在独立私有数据存储。私有仓库也不应提交生产密钥。

## 状态

已完成：v0.1 文档、示例与验收设计。
未完成：代码实现、VPS 部署、TT 真机联调、实际数据导入与性能测量。

本包未复制柏宝书实现代码，也未创建远程仓库。未来若复用现有项目代码，先单独核查其许可证与发布条件。
