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

在用户实际 TT 2.2.0 dev/Canary Windows x64 环境中，隔离探针确认了 `api.chat.current`、稳定聊天 ID、`windowInfo()`、`history.tail()`、`setExtensionPrompt` 和 `api.dev.llmApiLogs` 的可用性。三类注入位置均在最终 raw payload 中出现；延迟 prepare、探针取消、TT 原生 Stop、失败／超时和 request gate supersede 均有脱敏运行证据。生成期间 TT 不允许切换聊天或并发开始第二次生成，因此 provider 层旧响应乱序不能在该 UI 中直接复现。HTTPS 测试记录了自定义请求头下的 `Failed to fetch`，按 CORS／宿主限制处理，不把它标为远程服务成功。完整证据见 `notes/t-01-runtime-trace.md`。

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
