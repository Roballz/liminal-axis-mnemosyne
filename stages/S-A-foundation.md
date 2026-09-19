# S-A：接入验证与工程地基

状态：in_progress。范围：T-00～T-03。

## 1. 阶段目标

证明 Mnemosyne 能在隔离 TT 环境可靠接入生成链路，冻结自己的身份／版本契约，并建立可部署、可备份、可恢复的最小后端地基。

## 2. 任务地图

| Task | 一句话目标 | 完成标志 |
| --- | --- | --- |
| T-00 ✅ | 固定真实 TT／柏宝书／测试数据与副 API 基线 | 已验证；后续不再靠猜测安装版本、存储模式或测试输入 |
| T-01 ✅ | 做最小 TT Adapter 探针 | 已验证：真实 await、三类 payload、取消/清槽、宿主限制与 request gate 防过期响应边界 |
| T-02A ✅ | TT 宿主身份与变更事件验证 | 已验证：stableId/integrity、Branch、Edit/Delete/Swipe/Regenerate、reopen/rename 的能力边界与降级路径 |
| T-02 | 定义 Mnemosyne 自己的身份、版本和上下文契约 | T-02A review 后冻结编辑、swipe、分叉、引用和错误语义 |
| T-03 | 建立最小可恢复后端 | 数据重启仍在，能迁移、导出、备份并在空环境恢复 |

## 3. 阶段完成线

阶段 A 结束时：隔离 TT 测试环境中的生成前接入可行性已证实；Mnemosyne 的核心身份／版本契约已冻结到可编码状态；最小后端可持久化并完成真实恢复演练。

本阶段不要求完成正式剧情导入、自动记忆、混合召回、自定义模块或 MCP。第一个可日常使用的档案／原文搜索闭环属于阶段 B。

## 4. 已确认输入

环境基线见 `notes/baseline.md`。关键事实包括 Windows 10 x64、TT 2.2.0 dev/Canary（git `5e33bf6fead6`）、柏宝书 1.2.9 纯前端本地模式、现有 `system @d0` 召回注入配置，以及当前副 API／embedding／rerank 模型。

用户已有电脑端测试聊天与 ST／TT 导出能力；现用手机 TT 不用于首轮破坏性实验。

T-02 重新定义 Mnemosyne 领域术语，不沿用柏宝书 `Leaf` 作为正式对象名。

## 5. 本阶段需要确定的方案

- T-01 后：TT 三类注入语义与真实能力矩阵。
- T-02 前／中：Story、Branch、SourceMessage、Revision、单段派生记忆对象、ContextBlock 的正式字段与命名；稳定身份、swipe／编辑／分叉语义；规范化 input hash。
- T-02 首轮讨论已确认：Story 与宿主聊天文件解耦；同一 Story 可跨聊天文件续聊；平台分支映射为同 Story 下 Branch，并按 fork cutoff 引用复用祖先历史；SourceMessage/Revision 分离；swipe/regenerate 采用候选 Revision；共享 canonical store 按 story/branch 逻辑隔离。
- T-02 综合候选方案：`docs/07-t02-contract-proposal.md`。后续用户已接受固定分支历史、基于证据的映射、B/A 共用核心与停写迁移等方向；不能把首轮候选文档全体当作逐字段批准。
- T-02 最新收口：`docs/08-history-snapshot-and-rebuild.md`。第 1 节为用户确认的正文权威、逐层重建及 B 版单权威写入；第 2～7 节给出轻量加工来源关系、`head_snapshot_id`/不可变快照/有序分块清单、fork cutoff 与提交恢复的具体建议。与旧候选的依赖描述冲突时，以本轮收口为准；不是正式任务卡。
- T-03 前：最小后端技术栈、正式存储、认证、migration／backup／restore 方案。2026-09-18 TT 已合并 `window.__TAURITAVERN__.api.db`（TriviumDB 0.8.8）；新增“TT 宿主内嵌 TriviumDB provider”作为候选，与独立 Engine 存储方案对照，不因宿主提供 DB 而把 Mnemosyne 核心领域模型绑定 TT。
- T-03 实验：中文词法／BM25 候选实现，以及 Qdrant / TT-TriviumDB 各自在向量、文本、图查询中的角色；同时验证超长 RP 数据量、备份恢复、索引重建和跨宿主迁移。只冻结已测试边界。

## 6. 当前阻塞

无新增宿主事实阻塞。T-01 已于 2026-09-18 二次 Chat review 通过并升为 `verified`；request gate 并发竞态已在 `dd3fa38` 修复并由确定性乱序并发测试覆盖。

T-02A 已于 2026-09-19 二次 Chat review 通过并升为 `verified`。已确认 stableId/integrity 三方一致、Branch 身份变化、Deep Edit、Delete 后索引平移、Swipe 候选变化、成功 Regenerate、reopen/rename，以及 summary 的稳定计数能力；同时明确 Delete 事件参数只给删除后的总长度、Regenerate 不保证保留旧 candidate、事件过程中的 summary 可能短暂滞后。

当前继续 T-02 契约定稿；正式 T-02 主任务卡仍由 Chat／用户在讨论完成后创建。

2026-09-19 本轮确认：用户主要在单台手机长期 RP，接受 B 版单权威写入与跨端交接；有效历史正文为已发生剧情的权威，状态等仅为派生；可复用回合保留，变化回合及包含它的大小总结/事件/累计状态逐层重建。不为“只改单个状态、不改正文”的假定玩法建设通用依赖框架。

本轮已给出 Head 具体设计（08 文档），待确认具体格式并补齐导入对齐规则、非标准回合、ContextBlock/错误接口与保留清理规则。T-03 另需验证 TT provider 的业务提交完整性、无 embedding 原文存储、完整枚举/逻辑导出、崩溃恢复与索引重建；本轮设计不等于数据库验收通过。

工程流程要求：Codex 只实现当前 task，并在收尾报告下一任务依赖／建议验证点；不得自动创建 T-02。

## 7. 需要用户提供

当前没有新的必需资料阻塞。TT 安装、柏宝书扩展目录、测试聊天和模型配置均已记录；T-02 规划优先复用仓库现有证据，不重复询问。

用户已确认单手机为主要使用方式，无需再次询问能否接受 B 版单权威写入。

## 8. 阶段收尾 review

待 T-00～T-03 完成后由 Chat 填写。
