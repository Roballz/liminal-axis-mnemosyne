# T-03 P3 专项回审：宿主旧句柄与 c90d77d 版本核对

日期：2026-09-20。
Mnemosyne 审阅提交：`15b86056c229ec7742639c4cc9f31c0ea79d59fc`。
旧 TT 实测基线：`367b0c7e9410e8fcf394f668302d70073e5a3ce5`。
用户指定待比较 TT：`c90d77d5016672242c8f54f82a0eafe13db07388`。

## 1. 结论与范围

**Codex 停止自动外部维护隔离路径并回审是正确的。用户指定的 c90d77d 没有补上旧 native handle 的打开代次校验；升级到这一提交，不能据此关闭 P3 的自动维护阻塞。**

本轮为源码、提交差异与已提交原生证据的专项回审，不是 P3 全面验收。未在本轮重新执行 211 项 Node 测试，未运行新版 TT 二进制、Rust 测试或真实同步/归档。211/211、28 文件语法通过是 Codex 的已提交记录；新版结论属于固定源码检查，不冒充新版真机复现。

G1 仍保持通过：上轮修复的是 Mnemosyne 自己 owner 的生命周期，本次讨论的是绕过该 owner 的宿主原生 namespace 访问和维护。不得把它误记为 G1-R1/R2 回归失败。

T-03 继续 `in_progress`；P3 前置诊断增量保持 `implemented_unverified`，有界存储、完整恢复、维护共存及 P4/P5 没有因此通过。

## 2. 实际检查到的证据

读取了当前阶段导读、T-03 实施回报、`notes/t-03-p3-handoff.md`、intent prototype/adapter、最终原生记录及 Node TAP 结尾；比较 Mnemosyne 的 `bd1f0e4...15b8605`，确认本次是新增请求恢复/合作式维护诊断，而非完整 P3。

`evals/t03/p3-prerequisites/native-20260920p3b.json` 同时记录：

- Mnemosyne 封装的旧 handle 返回 `STALE_HANDLE`；
- 维护后检测到不同库身份返回 `LIBRARY_CHANGED`；
- `oldNativeHandleWroteAfterReopen=true`；
- `externalMaintenanceGate=HOST_MAINTENANCE_UNSUPPORTED`；
- `nativeArchiveOrSyncTriggered=false`、`processCrashTested=false`。

所以现场支持的是：旧 TT 的原生 handle 在同名 namespace 重开后仍可访问/写入。它不是“已经在真实同步中污染用户数据”的证据，也不证明新辅助请求格式已通过进程强杀恢复。

已提交 TAP 记录 211 测试、211 通过、0 失败/取消/跳过。本回审不重新标记为 Chat 独立运行结果。

## 3. 旧版到指定新版：变了什么、没有变什么

GitHub compare 显示 `367b0c7...c90d77d` 共 14 个提交。不能只读 c90d77d 最后一个提交：它本身是 Nix 依赖哈希/构建校验修订，数据库相关变化在之前的提交中。

| 路径 | 新版检查结果 | 对本问题的含义 |
| --- | --- | --- |
| `src/tauri/main/api/db.js` | 两端 blob 同为 `0c21ab0810270b57cb11ae10d7014712eef02a32`，逐字未改 | execute 仍仅发送 namespace + operation；close 仍仅发送 namespace，没有 handle ID / expected generation |
| `src/tauri/main/api/db-types.d.ts` | 新版 blob 为 `d4b41e37292f2f565949c221f8931cd1725e3044`，与旧取证一致 | 公开接口未增加打开代次、事务租约或可等待维护前排空 API |
| `src-tauri/crates/tt-contracts/src/database.rs` | 新版 Execute 为 namespace + operation，Open/Close 也无代次条件 | 原生接收协议没有区分旧 handle 与新 handle 的请求 |
| `src-tauri/crates/tt-application/src/services/database_service.rs` | 新增 DatabaseFileAccess/prepare_sync：try_write_owned，发送前 FlushAll、接收前 CloseAll，忙时失败 | 同步文件访问获得维护互斥；不是扩展多次 API 调用的一次事务租约 |
| `src-tauri/crates/tt-adapter-triviumdb/src/lib.rs` | 维护增加文件组修改时间读取/恢复；执行仍按 namespace 找 slot，再使用当前 OpenStore | 防止维护准备把旧副本变成看似更新的文件；没有拒绝旧打开代次 |
| `docs/CurrentState/Sync.md` / `docs/API/Database.md` | 说明同步/归档维护锁、namespace 整体替换及之后重新 open | 不能把这些说明解释成旧 JS 句柄自动永久失效 |

新版后端 `instances` 中的 Slot 按 namespace 保存并跨 close 存活，防止同名原生实例并发创建；这与禁止旧客户端继续访问新实例是两个独立问题。`Execute` 获取 Slot 锁后只检查当前 Store 是否存在，存在就执行 operation，并无旧请求的身份可比较。

因此源码可以确定：新版未实现旧 handle 的代次隔离。是否在用户下载的新二进制中表现完全一致，仍应标为未实测；不能把静态检查写成已部署验证。

## 4. 为什么维护锁不能替代旧句柄保护

更新中的维护锁解决“数据库文件正在 flush/关闭/替换时，不让单次数据库调用同时进入”这一层互斥。

Mnemosyne 需要的还有“维护结束、同名库重开后，不让维护前的请求继续写到新实例”。按现有路径：

1. 旧 handle 或待执行业务读取了旧库的身份/状态。
2. 宿主执行维护，关闭/替换该 namespace。
3. 某调用方重新 open 同名 namespace。
4. 旧 handle 调用 upsert，仅携带相同 namespace；后端无法从请求中判定它属于维护前，因而没有相应拒绝条件。

即使写前在 JS 再查一次库身份，检查与真正写入之间仍有间隙。多加一次 get、监听完成事件、在结果回来后核对、或仅加 JS mutex，都不能证明在这个间隙中不会维护换代。

这属于 TT 现有接口相对于本项目需求的能力缺口，不据此断言 TT 违反了它已承诺的公开语义；Database API 原本就是共享 namespace 的方法封装。

## 5. 推荐的上游补充方向（提议，不授权修改 TT）

优先与宿主作者确认能否增加**原生打开代次校验**，而不是由本扩展不断补前端监听：

- open 返回绑定当前实例生命周期的不可混淆 token/epoch；重复打开同一活跃实例不应无故使所有现有调用方失效。
- execute 和 close 携带该 token；原生在取得相关维护/namespace 锁之后、任何副作用之前比较。只在 JS 比较、或排队前比较都不够。
- 真正关闭、导入/同步替换及重开后，旧 token 必须失效；恢复旧备份不能把旧 token 一并恢复成当前代次。失败/取消按实际实例是否变化处理，不能只看请求是否收到成功回复。
- 旧 read/write/close 都应拒绝；尤其旧 close 不应关闭替代实例。成功更新 token 后仍需重新读取库身份、Head/view 和操作结果，不能给旧业务请求静默换 token 重试。
- 若需要保证整个扩展多调用事务与维护互斥，另需覆盖该事务的原生租约，或真正可等待的维护前排空握手。generation 是防旧请求写新实例的能力，不自动等于多调用原子事务或完整备份一致性。

最小验收反例：旧 handle 在同名库重开后写入/关闭被拒绝且新库不变；排队旧请求跨越维护后仍拒绝；失败/取消维护与正常共享打开各自不误判。可以先把此需求交作者评估，不在未获授权时 fork/修改/构建用户 TT。

## 6. P3 接下来允许与禁止的范围

**不必停止全部 P3；继续许可仅针对原有隔离、合成数据的工程开发，不是将受限运行批准为生产正确性。**

可继续原任务的有界清单/请求/视图/账本/目录设计与实现、精确枚举、完整辅助格式导出/恢复，以及持久请求的新格式故障测试。前提是独立测试实例和 namespace，明确没有未经协调的宿主同步、归档导入或其他调用方替换库；合作式维护实验必须由 harness 先等待 suspend 排空，再执行操作。任何实际无法确保该前提的原生测试继续暂停，可先做纯模型/独立测试。

这些工作仍须保持原任务高难优先顺序：持久请求与恢复边界 → 有界结构及完整恢复 → 索引/资源验证 → 常规说明。不得因为保持 P2 硬上限就称 P3 有界生产路径已经完成。

继续禁止：自动宿主维护共存、生产手机/真实档案准入；把 HOST_MAINTENANCE_UNSUPPORTED 用用户开关改成“通过”；仅因更新到 c90d77d 就移除门禁；自动选择 B2/A、升级生产安装或新建后续任务卡。

完整 T-03 维护验收仍待补齐。若最终选择不依赖宿主补充而采用受限产品模式，必须再由用户明确接受新的可执行使用边界；本次对隔离工程开发的放行不是该产品决定。

## 7. 实测与版本交接要求

当前无需为了证明源代码未变而升级唯一安装或重做全部 211 项测试。后续获准在隔离副本切到指定新版时：记录实际 commit/二进制哈希，用新 namespace 重跑旧 raw handle 的 read/write/close 对照，并明确是否真的触发 sync/archive；新维护锁相关测试必须按新版重测，旧版记录不能代记。

本轮没有重新执行 Node/原生验证，没有修改实现、没有创建新任务卡。专项结论以本文件为准；G1 历史审核与 Codex 原始交接/日志保留，不改写成新的运行证据。

## 8. 固定源码与项目证据

- [TT 两版本比较](https://github.com/Darkatse/TauriTavern/compare/367b0c7e9410e8fcf394f668302d70073e5a3ce5...c90d77d5016672242c8f54f82a0eafe13db07388)
- [新版 db.js](https://github.com/Darkatse/TauriTavern/blob/c90d77d5016672242c8f54f82a0eafe13db07388/src/tauri/main/api/db.js)
- [新版 DatabaseRequest](https://github.com/Darkatse/TauriTavern/blob/c90d77d5016672242c8f54f82a0eafe13db07388/src-tauri/crates/tt-contracts/src/database.rs)
- [新版 DatabaseService](https://github.com/Darkatse/TauriTavern/blob/c90d77d5016672242c8f54f82a0eafe13db07388/src-tauri/crates/tt-application/src/services/database_service.rs)
- [新版 TriviumDatabaseBackend](https://github.com/Darkatse/TauriTavern/blob/c90d77d5016672242c8f54f82a0eafe13db07388/src-tauri/crates/tt-adapter-triviumdb/src/lib.rs)
- [新版 Sync 说明](https://github.com/Darkatse/TauriTavern/blob/c90d77d5016672242c8f54f82a0eafe13db07388/docs/CurrentState/Sync.md)
- [项目 P3 原始交接](https://github.com/Roballz/liminal-axis-mnemosyne/blob/15b86056c229ec7742639c4cc9f31c0ea79d59fc/notes/t-03-p3-handoff.md)
- [旧 TT 原生最终样本](https://github.com/Roballz/liminal-axis-mnemosyne/blob/15b86056c229ec7742639c4cc9f31c0ea79d59fc/evals/t03/p3-prerequisites/native-20260920p3b.json)
