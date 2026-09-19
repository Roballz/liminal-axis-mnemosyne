# T-03 P0～P2：存储发布与恢复候选协议

版本：v0.1，2026-09-20。状态：implemented_unverified（仅本增量）；**G1 待 Chat review，B1 尚未选定为生产 provider，P3 未执行。**
实施基线 `852260acd8d3e65d9d756af81cdf72e52c50046b`；继承 06 v0.3 / 对象 schema_version=1 / 逻辑包 format_version=2。本文没有更改领域语义。

## 1. 已观察的宿主原语

Windows TT Canary `dev (367b0c7e9410)` / TriviumDB API。独立便携副本、独立 data root/WebView profile；详见任务卡与 `evals/t03/native/`。

| 能力 | 结论与证据级别 |
| --- | --- |
| `api.db.open/upsert/get/flush/close` | observed；复杂 JSON、中文、emoji、换行正常回读及重开 |
| 无付费 embedding 保存正文 | observed；专用 dim=2 namespace，固定 `[1,0]` 只作物理承载，不执行向量召回或混入语义索引 |
| 物理 NodeId 0 | **observed unsupported**：报“节点 ID 0 为内部保留值”；公共类型中的非负整数不代表 0 可写 |
| 领域 ID → 物理 ID | observed；领域 UUID 不变；协议逻辑槽 n 映射 TT NodeId n+1，发布槽为物理 ID 1 |
| 完整读取本原型库 | observed；从发布槽读取 commit 链并精确 get；连续物理槽扫描用于恢复分配位置和孤儿去重，无 search topK |
| 通用跨调用事务/CAS | public API 未提供；本协议不假定存在 |
| `syncMode=full`、显式 flush | observed 配置及两处进程强杀恢复通过；WAL 语义为 source-only，未验证硬件断电 |
| `listNamespaces` | source-only：仅打开库，不当成全库目录 |
| 外部维护/同步后的旧 native handle | source-only：宿主 bridge 以 namespace 调用，不能据句柄对象推断代次；本原型只保证自身 owner 管理的 close/recover 代次 |

固定版本来源：[Database API](https://github.com/Darkatse/TauriTavern/blob/367b0c7e9410/docs/API/Database.md)、[db.js](https://github.com/Darkatse/TauriTavern/blob/367b0c7e9410/src/tauri/main/api/db.js)、[路径选择](https://github.com/Darkatse/TauriTavern/blob/367b0c7e9410/src-tauri/crates/tauritavern/src/infrastructure/paths.rs)、[单实例插件](https://github.com/Darkatse/TauriTavern/blob/367b0c7e9410/src-tauri/crates/tauritavern/src/app/host/plugins.rs)。这些已在本轮读取，不把其他提交的能力自动套到安装版。

## 2. 分层与小样本边界

- `packages/contracts/` 仍是领域校验/参考模型。只把同步 UUID/SHA-256 运行时从 Node 专属 import 改为可在 TT WebView 运行的实现；JCS、指纹用途/版本、所有已有测试不变。自编 SHA-256 已与 Node crypto、WebCrypto 的 UTF-8/填充边界对照；不是新增第三方依赖。
- `packages/storage/protocol.mjs` 接收由已验收领域函数编译的 transaction，生成每次变化对象、独立提交账本与重建材料；不导入 TT 内部模块。
- `tt-adapter.mjs` 仅调用公开 `api.db`，只允许 `mnemo-t03-*` 测试 namespace；每个 api 对象/namespace 共用 owner。没有正式 UI、聊天同步或索引检索入口。
- `native/` 是隔离测试 harness；`tests/` 是确定性故障注入器。fake 的 `flush/crash` 只表达假设，不能代替真实 TT 证据。

明确硬上限：状态 256 条记录、每快照 32 条消息、每视图 16 个选择、状态和单编译请求分别最多 262144 UTF-8 bytes、64 次提交、最多 8191 个非根物理逻辑槽。超限拒绝，不截断正文。范围不是手机性能预算或生产参数。

## 3. 数据与状态机

本增量私有恢复格式为 `mnemosyne-storage-p2-v1`，独立于逻辑包 v2：

| 项 | 内容 |
| --- | --- |
| 编译请求 | operation_id、预期所有当前 Head/view/binding_generation、变化记录、原结果；生成过的领域 ID 已包含其中 |
| 不可变 object 节点 | format/kind/checksum/value；变化记录按内容去重；请求的 changes 保存节点引用，避免再次内嵌同一批记录 |
| 不可变 commit 节点 | previous、请求指纹和引用、变化引用、result、重建标记引用 |
| 单一 root | format/kind/tip/staging；只保存固定大小发布指针，不包含无限增长目录 |
| 内存索引 | 领域状态、内容哈希→物理槽、operation→请求指纹/结果；均可由 root/commit/object 重建 |

普通提交依次为：

1. 在同 namespace 的串行队列内，先查 operation 账本。相同请求返回原结果；同键异请求拒绝；**之后**检查 expected Head/view/binding。
2. 应用变化到小样本参考状态，执行 validateState（含引用/归属/无环、R5）及不可变对象、绑定/分叉检查。编译请求是受信任内部接口，不能把任意 JSON patch 当成完整业务命令 API。
3. 保存变化对象、请求描述、当前分支重建计划及 `index=behind`，保存 commit；flush 材料。
4. 一次 upsert 更新 root.tip，随后 flush。Head、view/selections/corrections、binding、结果账本和失效材料由同一 commit 可达，不分别发布。
5. 发布 flush 成功后才切换 owner 的可读状态并返回确认。所有正常读者走同一个 owner 队列；原生低级 handle 不作为产品读入口。

逻辑发布点是 root 更新；对调用者的持久确认点是发布 flush 成功；读者可见点是 owner 完成发布。root 写入已发生但未确认时，结果只能是待恢复，不能断言失败/回滚。跨多个 API 调用的原子性来自协议，不宣称 TT 提供通用事务。

## 4. 不确定结果、协调与恢复

任何存储调用或故障钩子失败后，owner 进入 `recovery-required`，拒绝继续读写。保留底层错误作为 cause。超时/调用者取消等待不取消原生 promise，也不释放队列所有权；原生调用未 settle 时，后续提交与 close 仍等待。

恢复在队列清空后执行 flush/get，读取 root，精确回读对象和提交链，验证对象 checksum、请求指纹、operation/result 对应、逐次 expected 条件、完整领域状态及重建标记。只有全部一致才恢复 ready。无法读取/验证、断链或不明 IO 结果不当成空库，不删除纠错、不自动选新版。恢复/close 推进 owner 代次，旧包装 handle 拒绝。

发布前材料是孤儿，不作为当前剧情；已存对象可按 checksum 复用，分配位置从实际连续槽恢复。此次测试重试保留同一编译请求与已生成 ID；**尚无正式业务命令入口的 durable intent/ID 预留机制**。若调用者丢失编译请求，不能重新随机生成一组 ID 并宣称是同一请求重试。这是 G1 必须审查的生产化前置条件。

多 handle 指本原型同一 JS 宿主/同一 api 对象里的协调入口；未实现跨 WebView、多个独立 api wrapper、外部扩展或设备并发写锁。外部宿主同步/归档替换前必须停止本 owner 并重新打开；自动维护事件接线未实现，不能在此前部署真实档案。

## 5. 小型备份与暂存导入

小型包包含：标准 logical v2、独立 ledger、rebuild/index 标记、编译请求 journal，以及外层 checksum。导入先检查两个 checksum、领域不变量，并从空状态重放 journal 对照 logical/ledger/markers；合法 checksum 不能替代 R5 或账本一致性。

导出在 owner 队列中取得固定副本；后续提交不修改旧包。导入只接受没有任何物理材料的新 namespace，先持久发布 `staging=true`，重放完成并逐项核对后才单点置为 false 并 flush。半成品重开保持 staging，不可作为活跃库读取；原库未覆盖。激活后丢确认时恢复可以发现完整新库，而不是清空它。

这不是全产品备份：只覆盖 T-02 已建模对象及本增量恢复材料；未提交孤儿不进入已提交逻辑包，仍保留在原物理库。没有模块/用户锁/通用任务模型、流式大备份、文本输入解析硬化或真实 B→A 迁移。

## 6. 故障保证与空间风险

| 故障模型 | 本轮范围 |
| --- | --- |
| 确定性 fake 断点 | object、commit、两次 flush、publish、ack 的 before/after，IO/ENOSPC、取消等待、竞争、导入中断；见 TAP |
| TT 进程异常终止 | 真实命中材料已 flush/发布前，以及发布已 flush/确认前；精确 PID 强杀后重开成功 |
| 真实磁盘满/底层设备 IO 失败 | 未执行；ENOSPC 是注入，不填满磁盘 |
| 硬件断电、OS 崩溃、介质损坏 | 未验证；不承诺物理断电零损失 |
| 手机后台/强杀 | pending，未操作手机 |

每次只写变化记录及本次账本，不重写整份 state 或全部 command 历史；root 固定大小。但本原型仍会在内存物化全库，单次 history command.entries、view、全体 expected、重建计划可能随样本增长，journal 导出也全内存。硬上限防止它被冒充生产实现，**S05 尚未通过**。

G1 若放行，P3 必须将 command.entries 用不可变清单引用无损恢复原请求、messages/revisions 用对象引用，views/expected/recovery 目录使用有界共享结构和可重建索引。不能只优化正文块而忽略账本放大；此处只提出协议兼容方向，未实施 P3 算法或冻结块参数。

## 7. G1 请求及回退

请 Chat 审查：B1 的已观察原语是否值得继续、发布/确认边界是否成立、编译请求保留/ID 预留与外部维护协调如何纳入 P3、上述临时包到 v2 的无损边界是否可接受。B1 生产选型及 P3 放行仍未决定；不自动切 B2/A。

回退只撤本轮源文件/运行时适配并停用隔离 harness；保留 `.t03-local` 的测试库和 `evals/t03` 证据。无需生产迁移，未改现用安装/档案/付费 API；不删除任何测试 namespace，不按前缀批量清理。若未来导入真实数据，必须另行完成迁移、导出和回退方案。
