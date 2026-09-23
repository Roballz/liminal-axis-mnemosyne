# Mnemosyne 日用记忆 MVP（W-01）

本分支 `work/daily-memory-mvp-baibai` 的状态为 **implemented_unverified**，等待 Chat review 与 TT 手机实测。基于柏宝书固定提交 `393873acd27906a09308ae65fe7e636a3d3941ab`，保留原前端、状态重放和混合召回。

使用入口：[档案 / 迁移、事件设置与自定义表使用说明](docs/daily-memory-user-guide.md)。页面内也有对应按钮与设置说明。

## 安装与最短手机验收

1. 先备份 TT 聊天，**停用原柏宝书**。可同时安装不等于可同时启用；同时启用会造成重复摘要/注入或状态更新。
2. 在 TT/ST 扩展安装界面使用仓库 URL `https://github.com/Roballz/liminal-axis-mnemosyne`，分支填 `work/daily-memory-mvp-baibai`。若界面没有分支栏，先在扩展管理中切换分支再启用；不要把 GitHub `/tree/…` 页面当作 Git clone URL。私有仓库需要用户自己的 GitHub 访问权限。
3. 确认扩展显示名为 **Mnemosyne 日用记忆**。根目录 manifest 加载已提交的 `dist/index.js`；无需在手机上构建。
4. 打开一个合成测试聊天，检查物品、地点、生活小档案、当前时间/地点和原摘要流程。进入“档案”，确认正文/摘要计数；失败会显示 pending，点“刷新 / 重试归档”。
5. 如需沿用旧本机知识库，在“档案 → 数据包边界与恢复”点击复制。本操作只读旧柏宝书库、复制文件及现成向量，不调用模型、不删除旧数据。随后检查原知识库独立阈值与额度。
6. 新聊几轮并生成摘要，进入“事件”手动补齐。该按钮会调用所配置摘要渠道，未指定则使用主 API。自动整理默认关闭；可配置消息楼间隔（默认40）、保留最近楼数（默认0）、批量摘要条数与完整请求字符预算。
7. 展开折叠事件卡，看成员、来源与追加简史；修改标题/状态/关键词，手动加入或移出摘要。检查召回只增加“事件概述节选”与至多一条额外进展，同链只包装一次。
8. 在“自定义表”建表、加字段、改行、搜索和翻页。表列表 → 设计表设置字段说明和 AI 提示词；新摘要同一次模型调用增量填表。支持覆写、追加、首次写入后锁定，保留旧 manual 字段限制；隐藏行不发送。
9. 导出核心包，再恢复到独立空库。恢复会完整校验后切换活动库，原库保留。确认正文/摘要 ID、事件、进展、自定义表行仍在；重启 TT 后复查，不串聊天。

以上均需用户实际确认，本仓库的 Node/fake 测试不等于 TT 手机验收。

## 数据、来源与编辑

- 新 canonical 库命名为 `mnemosyne_daily_*`；向量、BM25、知识库、设置与注入槽使用独立命名。聊天中的旧 `bbs_leaf` / delta 继续维持原状态体验；不自动清理旧柏宝书库。
- 新消息有独立 Mnemosyne 身份。正文 edit/swipe/delete 发布新的当前视图，原 Revision 不硬删。相同内容不作为跨消息身份依据。
- 新 L0 记录实际正文输入；历史摘要不能证明的生成输入明确标为来源声明。兼容导入的同楼原文不是“证明已用于生成”。
- 编辑后的摘要进入待审核，用户可在档案页选择“保留摘要”（仅当前 Head）或重新生成。受影响的高层摘要保留，并逐层手动重建；不自动级联调用模型。
- 柏宝书生成流程写入的物品/变量旁注仍会形成正文 Revision。程序只对自己刚写出的、完全匹配的旁注记录明确兼容事实，保留原生成引用；用户随后编辑正文仍需审核。
- 复制聊天携带另一绑定时暂停自动归档，要求明确新故事、续接或固定前缀分叉。分叉先校验消息身份与正文；不存在可靠映射时不猜测。
- 召回继续使用 Query、多 query max、BM25、RRF、rerank 和原配额。后端返回的正文副本不能覆盖 canonical 正文。rerank 未执行/失败时分数为 null；回退选档仍可按原余弦阈值执行。

## 迁移包边界与回退

新版核心包格式 v2，可恢复旧 v1；物理 IndexedDB 不升级。核心包包含：story/branch、正文及摘要版本、快照/映射、审核、事件及回执、自定义表与行、非秘密事件设置。只恢复到新空库，失败不替换原活动库。API 密钥不进入包。

**不包含**：TT 聊天文件及聊天内状态 delta、知识库原始文件/区块、向量/BM25投影、API 配置。核心包不是完整柏宝书体验备份；跨设备还需单独迁移宿主聊天和知识库原文件，并在目标设备重新配置模型。缺向量可重建，重建可能产生 Embedding 费用。

回退：停用 Mnemosyne fork，再启用原柏宝书；保留旧柏宝书库、TT 聊天备份及 Mnemosyne 核心包。不要手工删 IndexedDB。旧 Mnemosyne B provider 与本任务物理库格式不同，不能互换文件或直接合并。

## 当前限制与验证

- 仅本机单权威设备；无 VPS、多主同步或自动 GC。
- 旧后端 bundle 命中没有 canonical 身份证明时不会直接放行；旧聊天应先归档并明确续接/分叉。种子高层摘要仍保留兼容展示。此差异避免旧 bundle 跨身份注入，不声称覆盖旧后端快照的全部迁移能力。
- 事件目录完整发送，超预算暂停；不缩成少量候选卡。预算使用字符上限，不冒充精确 tokenizer。事件扩展有独立字符预算，属于额外上下文开销。
- 手动补齐固定上限并顺序提交；停止后等待在途请求返回、不再应用结果。关闭/后台暂停不承诺继续执行。
- 自定义表随最新楼摘要在同次请求填写；纯历史补摘/高层压缩不修改当前表。可见行并入原当前状态注入；隐藏行不发送。没有另起周期填表任务。删表/字段/行需确认，旧数据保留，不自动清理。
- 当前库接口针对日常单聊天规模；大型整库导出/导入与超大目录的手机内存、延迟、系统回收仍待实测。
- 本轮已完成合成 Chromium 手机宽度/桌面检查，包含弹窗、长按、隐藏/显示与零正文/摘要读取断言；TT 桌面/手机仍待实测。

构建与检查（Node 20.19+ / 22.12+）：

```sh
pnpm install --frozen-lockfile
npm run build
npm test
npx vue-tsc --noEmit
```

可选本机合成浏览器检查：安装 Playwright 与 Chromium 后运行 `node scripts/daily-ui-smoke.mjs`。该脚本仅访问本机合成页面，不接 TT、不调用模型。

详细范围、证据与20项反例映射见 `notes/w-01-final-review.md`；上游记录见 `notes/baibai-upstream-base.md`。

---

以下保留原主线 README，S-A/S-B 的历史验收不能用于证明本日用分支已通过手机验收。

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
| `tasks/T-05-manual-search-and-workbench.md` | verified（受控范围）：手动搜索、固定版本分页、旧摘要/来源查看与最小工作台 |
| `stages/S-B-archive-and-search.md` | 当前阶段目标、已确认事项、权限与测试预算 |
| `notes/t-04-final-review.md` | T-04受控验收及真实原会话内容核验，覆盖旧待审状态 |
| `tasks/T-04-readonly-import-and-sync.md` | verified（受控范围）：只读导入、精确映射、暂停/确认与恢复的实施证据 |
| `docs/11-stage-b-import-policy.md` | 导入白名单、两主入口、删除人工处理、配对及手动搜索匹配边界 |
| `docs/12-edit-review-policy.md` | accepted：正文编辑后摘要人工审核、保留兼容或逐层重建策略（未来T-07+实现） |
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

accepted表示方案确认，planned表示任务发布，implemented_unverified表示待Chat验收；verified也必须带上对应范围，不能冒充手机生产可用。Stage-B现已按受控范围收口；本次不创建或启动T-06。
