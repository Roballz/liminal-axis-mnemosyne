# T-01：最小 TT Adapter 探针

状态：implemented_unverified

## 用户目标

在隔离的 Windows x64 TT 测试环境证明 Mnemosyne 可以安全地挂入一次正文生成前链路：等待一个可控的“假记忆准备”、识别过期响应、处理取消／切聊天／连续生成，并取得三类注入位置的最终模型请求证据。

本任务验证宿主接入能力，不实现真实 Memory Engine、数据库、检索算法或正式 Workbench。

## 前置与必读

- T-00：verified。
- 目标宿主固定为 TT 2.2.0 dev/Canary，git `5e33bf6fead6`，Windows 10 x64。
- 柏宝书固定为 1.2.9 / commit `32dbb48a0a643804256d496bc35bf7699dea9ebe`；扩展目录和测试聊天已在 `notes/baseline.md` 定位，不再作为缺失项询问用户。
- 必读：`AGENTS.md`、`docs/01-architecture.md` 第 0～3、10～11、15 节、`docs/05-source-review.md`、`stages/S-A-foundation.md`、T-00。
- 已知宿主候选能力（仍需现场验证）：`window.__TAURITAVERN__.api.chat.current.ref()`、`handle.stableId()`、`history.*`、`api.dev.llmApiLogs`。
- 开工前必须在真正的 Git checkout/worktree 中报告当前 Mnemosyne commit 与工作分支；只有源码压缩包且无 `.git` 时，不开始写实现。

## 允许修改

- 新增最小 Mnemosyne TT 探针／适配器代码、最小诊断面板、无敏感信息的 fixture／trace。
- 可以使用可控的假 prepare provider（进程内延迟或最小测试端点）；不得因此提前搭建 T-03 正式后端。
- 不修改 TT 客户端源码、柏宝书源码、用户聊天、IndexedDB 或生产配置。
- 如为隔离 payload 需要，可在测试聊天中临时关闭柏宝书相同类别注入或调整测试设置；必须记录原值并在结束后恢复。
- 不提交真实聊天正文、API key、token、完整生产日志或含 prompt 的 debug bundle。

## 实现步骤

1. **宿主能力预检**
   - 在实际 TT 运行时确认扩展加载入口、生成拦截器参数、取消信号以及 `api.chat.current.ref()` / `stableId()` / `api.dev.llmApiLogs` 的真实可用性。
   - 记录 `getContext().chat`、`windowInfo()`、`history.tail()` 在当前版本的最小观察，遇到文档冲突以运行事实为准；不在本任务扩展成长历史性能测试。

2. **最小可控等待与网络能力**
   - 实现独立探针面板和一个确定性的假 prepare：可设置立即返回、延迟返回、超时、失败。
   - 证明正文模型请求发生在当前 prepare 完成之后；失败／超时状态可观察。
   - `await` 时序优先用进程内／本机假 prepare，避免把外部网络抖动混入时序判断。
   - 另做一次独立的获准 HTTPS 测试请求，确认 TT 扩展环境能访问未来 Memory API 所需的远程 HTTPS；记录 CORS／请求头／错误形态等宿主限制。不得使用真实记忆模型来证明网络能力。

3. **过期响应防线，不提前冻结 T-02 契约**
   - 每次探针调用生成本地唯一 request token。
   - 同时保存宿主聊天稳定身份（优先 `stableId()` / `current.ref()`）以及最小 head snapshot（例如消息数量与最新可见消息指纹；最终形式按实测记录）。
   - 响应应用前重新读取宿主状态；request token、聊天身份或 head snapshot 不一致则丢弃。
   - **不要假定 TT 原生提供 Mnemosyne 的 `generation_id` 或 `head_revision`。** 正式字段名、生命周期与 SourceMessage/Revision 关系由 T-02 冻结。

4. **取消／切聊天／连续生成**
   - 覆盖：正常完成、用户取消、prepare 延迟期间切聊天、连续快速触发两次生成、旧请求晚于新请求返回。
   - 验证旧响应不能进入新聊天或新 generation，动态探针槽在取消／失败／下一轮前清理。

5. **三类位置真实 payload**
   - 使用唯一的探针内容与独立 extension prompt key，分别测试 `before_history`、`user @d0`、`system @d0`。
   - 优先使用 TT `api.dev.llmApiLogs.getRaw()` 或等价宿主调试能力检查最终发给 provider 的请求；仅看设置 UI、DOM 或 `setExtensionPrompt` 调用参数不算通过。
   - 记录 role、相对顺序、是否合并、是否重复、下一轮是否残留。无法准确表示的位置标为 unsupported / degraded，不静默改义。

## 验收

- 探针面板可在隔离桌面 TT 打开，且不依赖完整 Workbench。
- 至少一次获准的远程 HTTPS 请求成功或得到可解释的宿主／CORS 限制结论。
- 可控延迟的 prepare 确实阻塞正文请求；有时间戳／LLM request trace 证明先后关系。
- 正常响应只应用到发起它的当前请求；取消、切聊天、连续生成和乱序返回均不会注入旧结果。
- 至少记录宿主实际可用的稳定聊天身份能力和取消能力；正式 Mnemosyne generation/head 契约保持未冻结。
- `before_history`、`user @d0`、`system @d0` 都有最终模型请求证据，或明确记录 unsupported/degraded。
- 动态探针块在失败、取消、切聊天和下一轮前无残留。
- 柏宝书源码、聊天数据和生产设置没有被改写；临时测试设置已恢复。
- 移动端、生产聊天、真实 Memory Engine、真实召回质量保持 pending。

## 本任务明确不决定

- Story / Branch / SourceMessage / Revision 的正式字段；
- `generation_id`、`head_revision`、input hash 的生产契约；
- PostgreSQL / Qdrant / 正式后端框架；
- 正式同步、检索、摘要、实体状态或自定义模块；
- 是否长期依赖 TT 专属 API：本任务只记录能力，平台抽象在后续契约中处理。

## 实测记录

- 环境：Windows 10 x64，`E:\TauriTavern\tauritavern.exe`，2.2.0 dev/Canary，git `5e33bf6fead6`。
- 柏宝书：1.2.9，纯前端本地模式。
- 扩展目录／测试聊天：见 `notes/baseline.md`。
- 本地逻辑测试：`node --test apps/tt-adapter-probe/tests/probe.test.js`，5/5 通过。
- 语法检查：`node --check apps/tt-adapter-probe/index.js`，通过。
- 运行时第一批：宿主能力、假 prepare 时序和三类最终 payload 已验证；脱敏证据见 `notes/t-01-runtime-trace.md`。
- 运行时后续批次：探针取消、TT 原生 Stop、失败／超时、下一轮无残留、解释性 HTTPS/CORS 限制和运行时 request gate supersede 已验证。
- TT 生成期间不能切换聊天，也不能并发触发第二次生成；生成中切聊天和 provider 层重叠响应乱序无法在当前宿主 UI 直接复现，已按宿主限制记录，未伪造为通过。
- Tailscale VPS 测试发生在服务关闭前后，结果包含 timeout 与 `Failed to fetch`，网络／TLS／CORS 无法唯一归因，未标记为 HTTPS 成功。

## 回退

禁用／移除 Mnemosyne 探针扩展并恢复记录过的临时测试设置；探针不写正式档案，无数据迁移。

## 文档更新

完成后更新本任务、`notes/baseline.md`、`docs/05-source-review.md`、受影响的契约／架构事实和 `CHANGELOG.md`。若宿主运行事实与建议基线冲突，先记录证据，不由 Codex 静默改变产品语义。

## 开工检查

- Mnemosyne 基线 commit：开工时从真实 Git checkout 填写。
- 工作分支：开工时填写。
- 已确认输入：TT／柏宝书版本、扩展路径、安全测试聊天、当前模型配置均已存在仓库。
- 真正缺失项：无用户资料阻塞；仅需执行现场确认宿主 API/取消信号/最终 payload。
- 预计修改文件：最小探针实现、脱敏 trace／fixture、本任务及相关事实文档。
- 预计验收方式：TT 隔离环境真实生成 + TT LLM request raw/等价最终 payload 证据。

## 实施回报／交接

### 实际改动

- 新增隔离探针：`apps/tt-adapter-probe/manifest.json`、`index.js`、`README.md` 和 `tests/probe.test.js`。
- 新增脱敏运行记录：`notes/t-01-runtime-trace.md`。
- 未修改 TT 客户端、柏宝书源码、聊天文件、IndexedDB、生产配置或远程服务；未保存 prompt、响应正文、密钥或完整生产日志。

### 环境、命令与测试

- 当前 Mnemosyne checkout：`ec77812`，分支 `main`。
- 现场环境：Windows x64、TT 2.2.0 dev/Canary、柏宝书 1.2.9；实际路径与版本见 `notes/baseline.md`。
- `node --test apps/tt-adapter-probe/tests/probe.test.js`：5/5 通过。
- `node --check apps/tt-adapter-probe/index.js`：通过。
- 部署文件与 checkout 中探针文件哈希一致。

### 已确认的宿主事实

- `window.__TAURITAVERN__.api.chat.current.ref()`、`handle.stableId()`、`windowInfo()`、`history.tail()`、`setExtensionPrompt` 和 `api.dev.llmApiLogs.index/getRaw` 在目标 TT 运行时可用。
- 假 prepare 完成后才会发送正文请求；`before_history`、`user @d0`、`system @d0` 均在最终 payload 中得到 role、索引和 marker 证据。
- 探针取消只取消 Mnemosyne prepare 并 fail-open 放行宿主；TT 原生 Stop 会在 prepare 完成前取消并阻止正文请求。
- `fail`／`timeout` 路径均不注入探针；失败后宿主继续生成，最终 raw 无 marker。
- 新 manual prepare 会以 `superseded` 取消旧 prepare；TT 不允许生成中并发生成。
- 生成中不能切换聊天；生成结束后的切换不作为旧响应丢弃证据。

### 偏差、未验证与宿主限制

- provider 层重叠生成和旧响应晚于新响应的真实 TT raw trace 未取得，因为宿主 UI 在一次生成期间禁止第二次生成；当前以 request gate 单元测试和 TT 运行时 manual prepare supersede 作为边界证据。
- 生成期间切聊天未取得真实样本，记录为宿主限制，不静默宣称支持。
- `https://example.com/` 得到带自定义请求头时的 `Failed to fetch`，解释为可预期的 CORS/请求头限制；Tailscale VPS 测试受服务开关时序影响，未标记成功。正式 Memory API 仍需 CORS 或宿主侧代理实验。
- 移动端、生产聊天、真实 Memory Engine、真实召回质量保持 pending。

### 数据、契约与回退

- 无 schema、API 或用户数据迁移；没有冻结 `generation_id`、`head_revision` 或 T-02 领域身份字段。
- 探针只使用独立 extension prompt keys，并在取消、失败、Stop、下一轮和生成结束时清理。
- 回退方式：禁用或移除 `mnemosyne-tt-adapter-probe` 扩展；探针不写正式档案，无数据迁移。

### 下一步依赖与需要决定的问题

- Chat review 需要决定：在 TT 不允许并发生成和生成中切聊天的前提下，是否接受“request gate 已验证、provider 层乱序保持宿主受限”作为 T-01 的 `implemented_unverified` 收尾状态。
- T-02 仍需冻结 Mnemosyne 自己的 Story、Branch、SourceMessage、Revision、ContextBlock 和正式身份语义；本任务不提前定案。
