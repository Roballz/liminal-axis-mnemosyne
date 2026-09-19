# T-00 环境基线

状态：in_progress（部分已复核）。记录日期：2026-09-18。

## Codex 实测复核（2026-09-18）

- 工作区来自 GitHub 源码压缩包，当前没有 `.git`，因此基线 commit：unknown。
- TT 安装路径：`E:\TauriTavern`。
- `E:\TauriTavern\tauritavern.exe` 的 FileVersion/ProductVersion 均为 `2.2.0`。
- TT 进程在复核时正在运行。
- 安装目录可见 `default/` 与 `frontend-templates/`；未在该安装目录发现柏宝书扩展源码或用户聊天数据目录。
- 未读取 API key、token、聊天正文或生产数据。

以上仅确认客户端安装位置与版本；扩展 API、网络、生成拦截、注入 payload、导出格式仍需 T-01 及后续现场验证。

## TT 测试环境

- 平台：Windows 10 x64
- 通道：dev / Canary
- 应用版本：2.2.0
- SillyTavern 兼容基线：1.18.0
- Git：dev (`5e33bf6fead6`)
- 构建日期：2026-09-17
- 测试原则：使用电脑端隔离测试环境；正在使用的手机 TT 不做首轮破坏性测试
- 电脑端已有测试聊天，可导出文本

状态：以上由用户提供；具体扩展 API、网络、生成拦截与注入 payload 仍需 T-01 实测。

## 柏宝书

- 来源：`Roballz/ST-BaiBai-Book`
- 安装版本：1.2.9
- 安装方式：通过酒馆扩展 Git URL 安装
- 存储：纯前端／本地模式
- 柏宝库后端：未安装
- 自动摘要：当前关闭
- 当前召回摘要注入：`system @d0`
- 调试时允许用户手动开启／调整相关设置

### 现场复核

- 扩展路径：`C:\Users\Administrator\AppData\Roaming\com.tauritavern.client\data\extensions\third-party\ST-BaiBai-Book`
- `manifest.json` 与 `package.json` 均为 `1.2.9`。
- 当前源码 commit：`32dbb48a0a643804256d496bc35bf7699dea9ebe`；分支 `main`，工作树干净。
- manifest 注册生成拦截器 `bbs_generateInterceptor`；源码通过 `window.SillyTavern.getContext()` 接触宿主。
- 已确认的代码级宿主边界：`eventSource`／`eventTypes`、`setExtensionPrompt`、`saveChat`、`saveMetadata`、`getCurrentChatId`、`generateRaw` 等均由扩展自己的 `src/st/context.ts` 单点封装。
- 已确认的代码级责任分工：
  - `src/index.ts`：生成前 `await` 拦截器；先处理待摘要楼层，再按生成类型运行向量召回。
  - `src/memory/inject.ts`：通过 `setExtensionPrompt` 写入历史摘要、结构化状态和时间标签；隐藏旧楼使用 `is_system=true`，派生数据放在消息 `extra.bbs_leaf`。
  - `src/memory/vector/recall.ts`：独立写入 `baibai_book_vector_recall` 召回槽；失败时清空槽并放行生成。
- 以上为源码观察；`before_history`、`user @d0`、`system @d0` 的实际 payload 与顺序尚未在运行中验证。

## 测试聊天现场复核

- 数据根目录：`C:\Users\Administrator\AppData\Roaming\com.tauritavern.client\data`
- 实际文件路径：`C:\Users\Administrator\AppData\Roaming\com.tauritavern.client\data\default-user\chats\default_Seraphina\Seraphina - 2026-09-15@09h43m03s004ms.jsonl`
- 用户提供的 `chats\default\_Seraphina\...` 路径在磁盘上不存在；实际 TT 目录名为 `default_Seraphina`。
- 文件大小：71,774 bytes；JSONL 记录：26 条。
- 记录分布：`is_user=true` 12 条、`is_user=false` 13 条、元数据记录 1 条；含 13 条记录的 `swipes` 数据、12 条生成时间字段。
- 已见字段包括 `is_user`、`is_system`、`mes`、`send_date`、`swipe_id`、`swipes`、`extra`、`chat_metadata`；未见 `mesid` 或 `role` 字段。
- `extra` 字段已包含柏宝书相关派生字段；未读取或写回任何正文。

## 当前副 API / 模型

只记录用途与模型，不保存 key、token 或生产凭证。

| 用途 | 路由／服务 | 模型 |
| --- | --- | --- |
| 摘要 | sub2api 中转 | deepseek-v4.1-flash |
| Query | sub2api 中转 | gemini-3-flash-preview |
| Embedding | 硅基流动 | Qwen3-embedding-8B |
| Rerank | 硅基流动 | Qwen3-reranker-8B |

当前自动摘要关闭，因此“配置存在”不等于当前摘要链路正在运行。

## 测试数据

- 电脑 TT 内已有测试用聊天记录
- 可导出文本
- 用户另有 ST／TT 原始聊天备份
- 首轮只使用测试聊天、虚构数据或明确授权的脱敏副本，不提交真实长期 RP 数据到代码仓库

## T-02 命名约束

用户明确不希望沿用柏宝书的 `Leaf` 作为 Mnemosyne 正式领域概念。原因：Mnemosyne 将重新设计“单段派生记忆 + 跨段事件层”的结构，最终对象边界未必与柏宝书 Leaf 等价。

T-02 应重新命名并定义领域对象；当前名称保持 TBD，不为兼容旧插件而继承术语。

## 当前待复核

- 测试聊天导出格式是否包含稳定身份、swipe／编辑历史和足够版本信息；归入 T-02 身份／版本契约验证。
- 柏宝书 1.2.9 安装包与已核验仓库提交之间的具体差异。
- TT 生成期间不能切换聊天，也不能并发触发第二次生成；provider 层重叠响应因此保持宿主受限事实，不再作为 T-01 阻塞。

## 当前阻塞

- 无。T-01 已通过二次 Chat review；下一步进入 T-02 方案与任务卡规划。

## T-02A 探针实施与现场检查点（2026-09-19）

- 现有探针已增加事件参数、身份摘要、消息计数／邻近指纹、history 摘要和 swipe 候选数的脱敏记录；不保存正文、prompt 或完整 ref。
- 已部署副本路径：`C:\Users\Administrator\AppData\Roaming\com.tauritavern.client\data\extensions\third-party\mnemosyne-tt-adapter-probe`。
- 用户已在隔离虚构聊天中完成 T-02A 手工现场验证并提供脱敏 trace：reopen／rename stableId 保持，Branch 身份变化，Edit 双事件和 Delete 后索引平移可观测，Swipe 候选变化及 generation lifecycle 可观测；Delete 参数语义和失败 regenerate 的新候选仍为 `degraded`，详见 `notes/t-02a-runtime-trace.md`。

2026-09-19 review 校正：Delete 参数是删除后的 chat.length（review 源码事实），不足以独自定位具体来源；Swipe 事件／候选定位已可接受。`0.1.4` 修正 metadata 和 summary 读取路径，增加面板拖动；parent/child 身份、成功 Regenerate 和任务卡追加的明确 Delete 样本待实测，不把旧 null 当作宿主不可用。

0.1.4 后续实机回传：身份与 summary 修复已核对成功，第三次 regenerate 在 index4 得到新非空正文（候选数仍1），明确删除 index3 时事件参数4且count5→4。事件中 summary 可滞后于 context，稳定 host 后一致；用户确认面板拖动和窗口最小化不溢出。等待 Chat review，不再要求重做以上宿主实验。
