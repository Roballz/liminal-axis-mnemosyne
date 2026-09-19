# 外部来源与核验记录

v0.1 · 核验日期：2026-09-17。这里只记录本次公开资料核验，不代表用户安装版本已验证。

## 1. 柏宝书：固定提交，不以 main 漂移代替版本

用户提供的仓库为 Roballz/ST-BaiBai-Book，本次固定提交为 `32dbb48a0a643804256d496bc35bf7699dea9ebe`（提交日期 2026-09-15）。README 指向的安装上游与用户给出的 fork 不应混同；用户安装包尚待 T-00 核对。

| ID | 核验文件 | 支持的结论与限制 |
| --- | --- | --- |
| B01 | [vector/index.ts](https://github.com/Roballz/ST-BaiBai-Book/blob/32dbb48a0a643804256d496bc35bf7699dea9ebe/src/memory/vector/index.ts) | `collectLeaves` 用叶子摘要作 document，原文另存 mesFull；原文只是 payload 不等于已建立原文 BM25 索引。 |
| B02 | [vector/recall.ts](https://github.com/Roballz/ST-BaiBai-Book/blob/32dbb48a0a643804256d496bc35bf7699dea9ebe/src/memory/vector/recall.ts) | 实际 rerank 优先使用清洗的 mesFull；全文升级与摘要档使用不同条件；未运行成功的 rerank 会复用 similarity，这不是新架构建议保留的行为。 |
| B03 | [vector/store.ts](https://github.com/Roballz/ST-BaiBai-Book/blob/32dbb48a0a643804256d496bc35bf7699dea9ebe/src/memory/vector/store.ts) | 后端转发与 IndexedDB 回退并存；本地 search 读取 scope 记录，取多 query 最大余弦后排序，不是本地 RRF。未审计独立柏宝库后端的全部实现。 |
| B04 | [PUBLIC_API.md](https://github.com/Roballz/ST-BaiBai-Book/blob/32dbb48a0a643804256d496bc35bf7699dea9ebe/PUBLIC_API.md) | 有只读快照、单楼、历史、订阅和 coverage；深拷贝 DTO 不提供写回能力。getFloor 的 body 是清洗后文本，不是保证字节完整的原始聊天文件。 |
| B05 | [FAQ.md：自定义变量](https://github.com/Roballz/ST-BaiBai-Book/blob/32dbb48a0a643804256d496bc35bf7699dea9ebe/FAQ.md) | 已有 JSON 变量树、含义与更新规则，不能说原项目完全不能自定义。本方案新增的是可配置模块、字段权限、存储模式与独立激活／注入。 |
| B06 | [FAQ.md：向量记忆](https://github.com/Roballz/ST-BaiBai-Book/blob/32dbb48a0a643804256d496bc35bf7699dea9ebe/FAQ.md) | 文档提到 RRF、后端依赖；与同提交本地路径有差异。实现判断以具体执行分支为准，不混用旧注释与新代码。 |

以上是人工阅读相关源码与文档的结果；没有运行柏宝书测试，也没有修改用户插件。公开 API 导入可作为第一步，但要获取完整原始聊天，优先从 TT 支持的原始导出／读取接口取得，不能把清洗后的公开 API 文本标为 pristine original。

## 2. TauriTavern：宿主能力需在安装版本复核

| ID | 来源 | 本次核验范围 |
| --- | --- | --- |
| T01 | [扩展 API 说明](https://github.com/Darkatse/TauriTavern/blob/main/docs/API/README.md) | chat、layout、extension.store 等宿主接口；api.mcp 仍写为规划中。 |
| T02 | [ChatPayload 当前契约](https://github.com/Darkatse/TauriTavern/blob/main/docs/CurrentState/ChatPayload.md) | 当前聊天完整加载／保存；历史分页独立，不把 UI 隐藏等同内存只保留窗口。 |

TT 来源为核验时 main 文档，后续可能变化。T-00 要记录用户实际 TT 版本；T-01 要测试插件网络访问、真实等待召回、注入顺序、取消和切聊天，不能用公开文档替代真机证据。

### T-01 现场补充（2026-09-18）

在用户实际 TT 2.2.0 dev/Canary Windows x64 环境中，隔离探针确认了 `api.chat.current`、稳定聊天 ID、`windowInfo()`、`history.tail()`、`setExtensionPrompt` 和 `api.dev.llmApiLogs` 的可用性。三类注入位置均在最终 raw payload 中出现；延迟 prepare、探针取消、TT 原生 Stop、失败／超时和 request gate supersede 均有脱敏运行证据。生成期间 TT 不允许切换聊天或并发开始第二次生成，因此 provider 层旧响应乱序不能在该 UI 中直接复现。HTTPS 测试记录了自定义请求头下的 `Failed to fetch`，按 CORS／宿主限制处理，不把它标为远程服务成功。Chat review 后发现并返修了异步 snapshot 乱序下的 request gate 竞态；`dd3fa38` 通过确定性 A/B 并发测试关闭该问题。T-01 已于 2026-09-18 二次 review 标记为 `verified`。完整运行证据见 `notes/t-01-runtime-trace.md`。


### T-02 宿主身份／编辑／Carryover 补充（2026-09-19）

- TT 当前 api.chat.open(...).stableId()：角色聊天直接读取 chat_metadata.integrity；官方 Chat API 将 stableId() 描述为可持久化稳定 ID。该值可作为宿主 provenance，但不是 Mnemosyne 永久主键。
- TT/ST 前端事件表公开 MESSAGE_EDITED、MESSAGE_UPDATED、MESSAGE_DELETED、MESSAGE_SWIPED。当前普通消息编辑完成路径会先 emit(MESSAGE_EDITED, messageIndex)，随后 emit(MESSAGE_UPDATED, messageIndex)；因此扩展具备按消息索引侦测手动编辑的代码级能力。仍需在用户固定 TT 2.2.0 dev/Canary 安装上做一次真机编辑事件验证。
- ST/TT 分支创建会截取分叉点以前的消息快照，并以当前 chat_metadata 为基底写入新分支，只额外加入 main_chat 等字段；保存新文件时现有 integrity 校验不会要求新目标换一个 integrity。因此父线和分支可能共享 chat_metadata.integrity，不能假定它是“每个聊天文件绝对唯一”的 ID；需真机确认目标版本实际结果。
- 柏宝书固定提交 32dbb48... 已实现显式 Carryover：由用户主动“带数据创建新对话”，携带合并摘要／派生状态／近期原文；向量层按角色选择 database，以 chat:<chatId> 作为当前聊天 scope，并可把旧聊天快照为 bundle:<hash>，在新聊天 metadata 中保存 bundle hash 继承召回范围。该实现证明“用户显式续接 + scope/bundle 复用旧记忆”是现成可行模式，但其 per-character database 与 seed/bundle 数据模型不直接作为 Mnemosyne canonical schema。
- 独立柏宝库本身是通用 KV/SQLite 服务：每个 database 一个 SQLite 文件，并不定义 Story/Branch 语义；跨聊天语义主要由柏宝书前端的 database/scope/carryover 逻辑决定。

### T-02A 探针实施与现场边界（2026-09-19）

现有 TT adapter probe 已增加 `MESSAGE_EDITED`、`MESSAGE_UPDATED`、`MESSAGE_DELETED`、`MESSAGE_SWIPED` 与生成生命周期事件的脱敏 trace；事件参数中的字符串只保留长度和短哈希，消息只保留计数、邻近指纹和 swipe 候选数，`windowInfo.chatRef` 不保留角色显示名或文件名。用户在固定 TT 2.2.0 dev/Canary 上提供的现场 trace 确认了 reopen／rename stableId 保持、Branch 身份变化、Edit 双事件、Delete 后索引平移、Swipe 候选变化及 generation lifecycle；integrity 不可读，Delete 参数精确语义和失败 regenerate 新候选仍属 degraded。正式 T-02 仍不能据此冻结身份／版本语义。

### T-02A review 返修（2026-09-19）

以仓库 `d235263` 的 Chat review 为本轮接口依据：integrity 由 `handle.metadata.get()` 读取、`context.chatMetadata` 交叉检查；文件概况由 `handle.summary({ includeMetadata: false })` 读取 message_count。此前 null 来自探针错误路径，不能作为宿主能力限制。review 指明 `MESSAGE_DELETED` 实参为删除后的 chat.length，不能独自定位被删来源。Swipe 事件／候选定位已有证据，失败生成另记。`0.1.4` 封装回归测试通过，修正路径、成功 Regenerate、明确 Delete 和面板拖动均已取得实机回传，待 Chat review 收口。

### T-02A 0.1.4 实机补证（2026-09-19）

用户回传已确认 handle metadata/context camelCase/stableId 三方一致、handle summary 在稳定 HOST 中计数正确。成功 regenerate 的 seq25～28 保持宿主 index4/count5，旧正文 hash bacb4d89 更新为75257157，候选数仍1；有删除／重建相关事件，不可推断宿主保存旧候选。明确 Delete 样本为 N5/k3/参数4、旧 index4 指纹移到3，支持参数是删除后总长度。事件期 summary/context 暂不一致，稍后 host 一致；面板拖动及最小化不溢出已确认。依据为本地用户附件，不是本轮新查上游源码；不冻结正式 T-02 身份／版本规则。

## 3. 检索引擎参考

**Q01 — [Qdrant Hybrid and Multi-Stage Queries](https://qdrant.tech/documentation/search/hybrid-queries/)**

支持多路查询与基于排名的 RRF 融合，可参考其多阶段接口。没有据此决定本项目最终存储选型、中文分词、RRF 参数或 rerank 阈值；更不能由该文档推导本项目亿字性能。

## 4. ChatGPT／Codex 协作：只采用已公开说明的能力

| ID | 官方来源 | 可采用的工作方式 |
| --- | --- | --- |
| O01 | [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) | 项目可保存文件与指令作为上下文；上传／保存是快照，不是 Git 版本控制或与外部仓库自动双向同步。 |
| O02 | [Connecting GitHub to ChatGPT](https://help.openai.com/en/articles/11145903-connecting-github-to-chatgpt) | 在账户支持且授权后可读取仓库内容；不同入口的写入能力需单独确认。 |
| O03 | [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex) | ChatGPT 与 Codex 的历史分开；通过同一个本地目录或仓库中的文件交接，不假设整个对话／项目附件自动迁过去。 |
| O04 | [AGENTS.md 配置](https://learn.chatgpt.com/docs/agent-configuration/agents-md) | Codex 可从项目的 AGENTS.md 读取工作约束；本包提供简短入口与任务约束，不把所有文档塞入其中。 |

产品界面、套餐能力、权限可能变化。以上不代表本会话已经创建仓库、推送文件、配置 Codex 环境，或把附件永久挂到用户项目。

## 5. 复核规则

每次引入重要上游更新，记录日期、提交、相关文件与实际行为；代码注释、FAQ 和执行路径冲突时记录差异。保持旧核验记录，不把 main 链接现在的内容当成过去版本的证据。运行测试要附真实命令与输出，不能仅因文档说支持就标 verified。


### T-02A Chat 二次 review（2026-09-19）

T-02A 已通过。返修后的 TT 0.1.4 探针在固定 TT 2.2.0 dev/Canary 上取得以下现场边界：

- stableId、handle metadata integrity 与 context chatMetadata integrity 在稳定 parent / child 样本中一致；parent / child stableId 可区分，rename / reopen 后稳定。
- handle.summary({ includeMetadata: false }) 可取得聊天 message_count；稳定快照与 contextCount 一致，但事件过程可能短暂滞后，不能当原子实时 head。
- Deep Edit 的 MESSAGE_EDITED / MESSAGE_UPDATED 可按 index 观测正文指纹变化。
- MESSAGE_DELETED 的参数语义为删除后的 chat.length；明确 Delete 样本 N5/k3/参数4 及邻接指纹平移验证了这一点。事件本身不能直接给出被删 SourceMessage identity。
- Swipe 可观测 MESSAGE_SWIPED、swipeId、candidate 数与 active 指纹变化。
- 成功 Regenerate 可观测同一宿主 assistant 槽位的 active 正文替换；本次 candidate 数 1→1、无 MESSAGE_SWIPED，因此不能据此假定宿主保留旧候选。
- “删除后一条 assistant 后才成功”仅为无错误响应证据的上游输入格式猜测，不作为宿主或 Mnemosyne 契约。

这些事实只冻结 TT Adapter 的宿主能力边界；正式 Story / Branch / SourceMessage / Revision / head / input hash 仍由 T-02 设计。
