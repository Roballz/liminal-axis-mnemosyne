# W-01 最终施工回执

状态：**implemented_unverified**。仅交 Chat review 与用户 TT 手机实测；未标 verified。

日期：2026-09-23（UTC）。目标：`Roballz/liminal-axis-mnemosyne` / `work/daily-memory-mvp-baibai`。

## 版本与工作树

- 开工目标 HEAD：`cd728fde7b133b41db512efbc5c1358f439c03d4`，工作树干净。
- 柏宝书固定基线：`Roballz/ST-BaiBai-Book@393873acd27906a09308ae65fe7e636a3d3941ab`，实际 detached checkout 一致。
- 远端实现及最终构建产物 commit：`f1d735d74f6bbb60a1132e0fbe68e906f56d1e57`。
- 本地实际测试实现 commit：`64ef43370d52a7e5218933a1e5c6b0ca5ade93f1`。远端通过GitHub连接器创建的commit元信息不同，但tree精确相同：`84630284c38d30600b3b06772c277b3517c36b69`。
- 本回执为后续纯文档提交；上述实现 commit 已包含最终测试的源代码与 dist。
- 推送前 fetch 核对远端仍是开工 HEAD。CLI HTTPS push 因无写入凭据失败；GitHub连接器确认push权限后上传Git对象，逐个核对大文件blob SHA，并核对整树SHA一致，最后使用非强制ref更新。未强推、未改主分支。最终发布HEAD由本回执所在提交及Git分支记录定位。
- 单线施工，无子代理。已读 AGENTS、W-01、13/14/15/stage 及06/08/12契约。未生成后续任务卡。

## 实际改动与行数

| 范围 | 实际差分 |
| --- | --- |
| 相对固定柏宝书基线的实现增量（src及实现脚本） | +2,198 / −71 行 |
| 新增测试及合成 fixture/browser harness | +928 / −0 行 |
| 实现提交相对原 Mnemosyne 分支的整体差分 | 133文件，+38,605 / −2 行；含原样上游、文档、lockfile及生成产物 |

统计口径：逐文件与固定上游比较；`.test.ts`、测试脚本、fixture、smoke harness归测试，其余TS/Vue/CSS/实现脚本归实现；生成产物、依赖锁、manifest、文档不混入实现增量。

开工预估实现3500～6000、测试900～1800。实现低于下限约37%，施工中已报告新估算约2200行：直接复用原生成器、检索/配额、组件及现有渠道，采用薄的原生IDB模块，没有重造引擎或UI。测试接近原下限。代码量偏差不是范围授权变更。

主要模块：

- `src/mnemosyne/model.ts / db.ts / canonical.ts`：独立schema、IDB事务、正文版本、分块历史清单、映射、摘要选择/来源审核、固定前缀分叉。
- `bridge.ts`：宿主自有消息标记、增量幂等同步、跨存储pending/retry、观察代次、正文/摘要来源接线。
- `events.ts / jobs.ts`：全量合法目录、独立批量/手动补齐、成功回执、none/needs_review、只追加进展、人工锁定、截止一致的有界包装。
- `tables.ts`：固定defs/rows、类型与更新模式验证、手动增量AI填写、无变化成功回执。
- `json.ts / migration.ts`：重复JSON键拒绝、格式/计数/引用/领域检查、固定事务导出、独立空库恢复及成功后切active。
- `pages/archive / events / tables`：档案/审核/来源、事件折叠与成员分页、进度与设置、自定义表、迁移入口。
- 原 `memory/engine、apply、inject、vector/index、recall、hybrid、knowledge`：最小接线与独立命名；根 manifest/dist 可安装。

## 构建与测试事实

所有模型路径只使用 stub/固定响应；未读取用户真实聊天、未调用用户付费API、未连接用户手机。

| 命令/检查 | 本轮结果 |
| --- | --- |
| 固定未修改上游 `npm run build` | 通过 |
| 固定未修改上游 `npm test` | 14文件/244测试；脚本810/12/53断言通过 |
| 受影响组测试 | 按新增存储、事件、表/迁移、bridge、adapter和真实失败逐组执行；全部收敛通过，不累加重复执行数冒充独立测试 |
| 最终实现 `npm run build` | 通过；JS 697.85 kB，gzip 242.50 kB；CSS 94.71 kB |
| 最终实现 `npm test` | **20文件 / 308测试通过**；timeRel **810**、vector depth **12**、memory regressions **53**断言通过 |
| `./node_modules/.bin/vue-tsc --noEmit` | 通过 |
| 根部安装入口静态检查 | manifest的JS存在、CSS存在、`mnemosyne_generateInterceptor`存在 |
| `git diff --cached --check` | 通过 |
| `node scripts/daily-ui-smoke.mjs` | 未完成：环境没有 Chromium 可执行文件；下载返回无效ZIP，停止重试。没有渲染/点击通过证据 |
| TT桌面 / TT手机版 | **未运行**，由用户验收 |

第一次候选全量为307测试通过；之后源码复核发现高层审核接线仍沿用上游移除行为，并补了事件发送前版本复核。实际修改这两处后，先跑受影响集，最后再次构建/全量得到上面的308测试。第二次全量由真实实现变化触发，不是重复“再确认”。夹具缺`queryIndex`的类型错误也已修正。

环境说明：pnpm 11 安装命令完成依赖下载但以esbuild安装脚本未批准为由返回非零，后续pnpm依赖状态检查同样阻断；现成平台二进制可用，使用npm执行源项目脚本成功。未改供应链/权限策略。Vite有原有大chunk警告，没有为本任务另做性能重构。

## W-01 二十项反例映射

| # | 反例与对应证据 | 层级 |
| --- | --- | --- |
| 1 | canonical：同文本不同消息/故事不合并；固定分叉复用有证据的身份 | Node/fake-IDB |
| 2 | canonical/bridge：edit创建Revision，摘要待审；保留仅当前Head，后续再编辑重审；上级按依赖显式重建 | Node/fake-IDB |
| 3 | canonical：A→B→A复用历史Revision，新Head不复活旧run | Node/fake-IDB |
| 4 | canonical：删除退出当前视图，旧正文/摘要仍保留 | Node/fake-IDB |
| 5 | canonical/bridge：重复同步不新增对象 | Node/fake-IDB |
| 6 | bridge：宿主成功/IDB失败保留pending；宿主保存失败重试身份标记 | Node/fake-IDB |
| 7 | events：明确none写success且不重复处理 | Node/fake-IDB |
| 8 | events：解析缺字段/保存失败均不推进；注入磁盘失败回滚全部事件写入 | Node/fake-IDB |
| 9 | events：5条摘要→5关联+1进展 | Node/fake-IDB |
| 10 | events：同链多个正常命中只包装一次，不删除命中 | Node/fake |
| 11 | events：latest在命中/近期集合时不补充 | Node/fake |
| 12 | events：旧snapshot/cutoff不读未来标题、成员、计数、概述；跨批次段整段排除 | Node/fake-IDB |
| 13 | events：25成员链仍固定字符预算、至多1额外进展 | Node/fake |
| 14 | tables：增表/字段不升级物理IDB版本 | Node/fake-IDB |
| 15 | tables：AI写manual字段/删整行/未知字段/类型错误拒绝 | Node/fake-IDB |
| 16 | tables-migration：事件、正文、摘要、custom行全包往返逐对象相等 | Node/fake-IDB |
| 17 | tables-migration/boundaries：坏计数、checksum、引用、selection、事件结构拒绝，原active不变 | Node/fake-IDB |
| 18 | adapter/既有knowledgeRecall：canonical不可用仍独立知识库；旧库只读复制并可搜索 | Node/fake-IDB |
| 19 | 独立manifest/interceptor/注入命名源码检查；README/档案页明确停用原柏宝书 | 静态；双扩展及实际注入待TT |
| 20 | bridge/events/adapter：观察代次、正文、事件epoch变化拒绝迟到结果，发请求前/发布前复核 | Node/fake-IDB |

另覆盖全量目录超预算暂停、已有链续接、reference/none/needs_review、多事件、操作幂等/冲突、人工移除锁不能被AI重新激活、自定义表已有行/选定范围/无变化回执、严格JSON重复键等。

## 数据、兼容与重要实现选择

1. canonical事实与向量投影独立。IDB事务中只作数据库请求；hash、模型与网络在事务外。历史清单按128条引用分块共享，追加不复制整段正文。
2. saveChat与IDB不伪装成原子事务。宿主消息身份先保存；宿主metadata保留pending；失败可重复观察重试，不换ID盲写。前端另显示错误。
3. L0实际正文引用记录在生成前；非标准回合完整归档但不伪造User+Assistant coverage。旧资料无证明时保留声明。高层保留实际child版本依赖；旧生成上下文不补造。
4. 上游自己写入的物品/变量旁注会产生正文新版本。仅完全匹配本次程序写出的内容、且其它实际输入未改变时，写`origin=generated_sidecar`兼容事实；生成inputRefs不改。用户编辑走人工review。
5. 事件概述只追加。元信息/关联/进展/回执同事务；人工关联使用保留历史的锁定修订。失效或被移除关联依赖的段不注入。
6. 全量目录与本批材料采用明确字符预算；先确定批次截止再读取目录，不带后面楼层的事件信息。事件额度默认2链、每链最多1额外摘要、1600总字符，设置可改。
7. 默认不开自动事件调用。手动补齐固定目标、逐批推进；停止不冒称取消宿主请求。needs_review持久化并等待人工处理，不自动反复付费。
8. 自定义表用固定stores。删表/字段/行确认后逻辑隐藏，旧字段单元格保留但不再发给AI；类型改变要求新字段，不偷偷转换历史值。自动周期填表未做。
9. 根部保留可安装产物。物品/地点/生活档案、时间/地点与原UI继续读取旧聊天delta。独立公共接口/按钮/设置/注入命名避免静默覆盖原扩展。
10. 迁移核心包明确排除宿主聊天/delta、知识库、索引、密钥。旧知识库另有显式只读复制本地文件与向量入口，按完整embedding身份判断可用；不称核心包为完整柏宝书备份。

## 偏差、未验证与限制

- 实现增量小于预估，原因和口径见上；不把原样导入3万余行当成本轮新设计。
- 旧后端bundle没有canonical身份/来源证明时不直接进入新召回；这会减少该特定旧档路线候选。需要先归档旧聊天并明确续接/分叉，或保留种子高层的兼容展示。未声称旧后端bundle无损全量转换已经完成。
- rerank失败时，真实rerank分数为null；为了保持基线选档行为，仍独立使用余弦阈值选择回退原文。此差异有adapter反例，不将余弦值作为rerank展示。
- 当前实现对所有canonical对象作全包逻辑导出，导入亦需在内存校验。大库/超长目录性能、手机存储回收、后台恢复与真实host保存事件顺序未做容量/设备验证。
- 未执行真实模型质量评估、TT安装、双插件现场、桌面/手机UI测试。合成浏览器harness保留可复现入口，但当前环境未能运行，不把截图/页面断言写为通过。
- 保留旧B provider和主线历史资料，不做物理迁移，不重跑T04/T05原生/强杀/性能矩阵，不访问私人档案。

## 用户最短验收与回退

1. 备份宿主聊天，停用原柏宝书，按README安装本分支。
2. 打开合成/明确愿意测试的聊天：状态功能、时间/地点、知识库与原混合召回均检查一次；档案显示已归档。
3. 生成数条摘要，做一次编辑→保留/重新生成，检查旧版本仍在、待审核状态正确。
4. 手动整理事件，展开看成员；同链中间命中检查有界注入，确认最新已在近期全文时不重复。
5. 建自定义表，人工编辑与一次选定摘要AI填写，manual字段不被修改。
6. 核心包导出→新空库恢复→重启，确认ID/正文/摘要/事件/行仍一致、不串聊天。
7. 记录TT版本、手机环境、实际问题与注入片段（分享前脱敏），交Chat review后再判断验证状态。

回退：停用本fork，重新启用原柏宝书；保留旧库和聊天备份，以及Mnemosyne核心导出包。不要自动删库，不把核心包当作宿主聊天/知识库全备份。无任何自动purge或VPS变更。

下游仅依赖：Chat源码review、TT桌面/手机人工验收及由其反馈驱动的修复。不创建下一张正式任务卡。
