# T-03 P3 高难项交接：持久请求前置增量与维护阻塞

日期：2026-09-20。基线：`bd1f0e42bb74ee237ca2633e7be8f5da4d873021` / main。
依据：G1 最终回执第5节、S-A、原 T-03、06 v0.3 / schema_version=1 / 逻辑包 v2。

**T-03 仍 in_progress；P3 只完成前置诊断增量，implemented_unverified。P3 未完成，外部维护协调受阻，有界存储/完整恢复未实施，P4/P5 未开工。** 本文件是原任务交接，不是新任务卡。G1 已通过，不重新退回 G1-R1/R2。

## 1. 已实现的有限能力

新增 `packages/storage/intent-prototype.mjs` 和 `intent-tt-adapter.mjs`，复用已验收的领域函数和 P2 发布协议。新入口只用于新的 `mnemo-t03-p3-*` 隔离 namespace。旧 P2 入口拒绝该前缀，避免误绕过请求记录；旧库、旧协议、原150项测试及领域代码均未改。

- `prepare(input)`：接收历史、记忆 archive/select/correct 或绑定业务输入，在队列内执行纯领域编译，记录原输入、完整编译请求、生成的 ID 序列和校验值；flush 后才返回 prepared。没有编译回调、LLM 或任意外部副作用。
- `pending()/lookup(operation_id)`：重开后只凭持久记录找回未发布请求、原输入/请求指纹及生成 ID。`execute(operation_id)` 使用该精确请求；先返回已发布结果，再考虑 expected。准备不改变 Head/view/binding。
- 准备或发布 IO/确认不确定时拒绝继续使用入口，显式 recover 后枚举和判定。取消调用方等待不取消原生操作、不释放队列。尚未 flush 的准备没有持久承诺；若随后进程崩溃而记录不存在，不声称能恢复从未落盘的输入。
- 单一协调对象封装正常读写；内部 StoreOwner/IO 不对外暴露。多个 adapter opener 复用登记、队列；关闭失败保持登记，成功关闭永久失效，旧对象不能关闭替代实例。
- `suspend()` 即时换代、拦住排队旧调用、等待在途写入和恢复结束，然后产生库身份/root/intent末端检查票据并关闭。`resume(ticket)` 比较同名库身份与发布/准备边界，变化则拒绝采用。它只支持**调用方先等待 suspend 完成，再开始维护**的合作式路径。
- 恢复不仅校验 checksum，还以持久生成 ID 重新执行纯编译审计，核对原输入、编译请求和已发布状态。此为小样本完整审计，不是普通路径的有界生产实现。

临时辅助格式 `mnemosyne-storage-intents-v1` 与标准 v2 的 history operations 分离。历史 command 保持原格式；选择/纠错/绑定的存储去重信息没有塞入 history command 表。存储库 ID 使用 op 形式 UUID 作为本地格式字段，**不代表领域 operation，不进入 v2 operations**。

本增量仍有 P2 全部上限和全库 oracle：256记录、32条/快照、16选择/视图、状态/编译请求各256KiB、64次提交；最多64条准备记录，每条辅助封装512KiB。逻辑槽8193为身份，8194起为准备链，TT物理槽统一+1，与P2的0～8192保留区分开。真实创建通过 stats.nodeCount=0 证明目标为空；FakeIO按有限地址范围检查，仅适用于该测试模型。未解除S05限制。

## 2. 外部维护缺口：源码与原生事实

固定来源均为 `Darkatse/TauriTavern@367b0c7e9410`，不是“上游最新”。通过 GitHub connector 读取的 blob：

| 文件 | Git blob SHA | 事实 |
| --- | --- | --- |
| `src/tauri/main/api/db.js` | `0c21ab0810270b57cb11ae10d7014712eef02a32` | handle操作发送`execute + namespace + operation`，没有打开代次或库身份条件；close也只带namespace |
| `src/tauri/main/api/db-types.d.ts` | `d4b41e37292f2f565949c221f8931cd1725e3044` | 公开接口没有事务范围租约、expected generation或维护前ack门禁 |
| `src-tauri/crates/tt-application/src/services/database_service.rs` | `ceb8746bce8054e6ce73c7ec16d0eb90696f4de8` | execute只在单次后端调用期间持维护读锁；prepare_archive持写锁并closeAll/flushAll，不能覆盖扩展多调用事务 |
| `docs/API/Database.md` | `ca600f3f053b981a829c4efd97953d38a6c6f209` | 归档导入关闭实例、整体替换namespace，之后需重新open；不保证整个归档事务性 |
| `docs/CurrentState/Sync.md` | `352cd6cd3addae12f81a28ccd7239c8d05b1e584` | sync:job是进度/结果事件，不能将其推定为可await的维护前隔离协议 |

原生反例：在新合成namespace中，旧handle读取标记A→close→新handle open并写标记B→旧handle写另一节点→新handle能读到旧写。两次真实执行均观察到 `oldNativeHandleWroteAfterReopen=true`。这验证**旧handle可以访问重开的同名库**，不是实际触发一次归档/同步替换的证明。

由此推论：在JS里先get库ID、再upsert，中间仍可发生维护换代；事后检测无法阻止旧写污染新实例。namespace字符串、JS对象身份及单次原生维护锁均不足以证明跨调用边界。合作式suspend不能自动拦住宿主自行发起的维护；本增量没有虚构事件或自动接线。`requireExternalMaintenanceFence()` 明确返回 `HOST_MAINTENANCE_UNSUPPORTED`，只用于诊断当前缺口，不是已实现的宿主能力接口。

## 3. 为什么停在这里、需review的最小方向

仓库约束要求：“若实际原语不足以完成维护隔离/恢复或有界性，先给证据回审，不擅自切B2/A或降低标准。”G1第5节同样要求能力不足时停止受影响路径。当前P3无法在固定公开API上证明自动外部维护隔离，因此**未启用生产入口，未把合作式单队列测试当作宿主维护验收**。

交Chat/用户确认的最小方向（均为建议，未实施或accepted）：

1. 宿主提供在原生执行同一临界区内校验的库打开代次/租约，旧代次的排队请求在替换后拒绝；或提供覆盖发布协议全过程、由原生维护共同遵守的租约。
2. 宿主维护开始前提供可等待的扩展排空/冻结协议，结束后失效通知与重新验证；需涵盖失败/取消/关闭后重开，而非仅完成事件。
3. 如果只允许“先显式停用Mnemosyne，再手动维护”的受限诊断运行，必须将该运行约束交review确认；不能自行把它降格为生产正确性标准。

未修改TT源码、未升级用户安装、未选择B2/A。完整P3有界结构与恢复仍依原卡安排；继续这些工作的前提/隔离范围由本次review确认。本轮预计实现1200～1800/测试900～1400行是完整P3估计，发现前提缺口后实际只交前置增量，不能解释为缩小后已完成P3。

## 4. 真实验证与未验证边界

- 全量Node **211/211**（原150+新增61）、语法 **28/28** 及哈希证据见 `evals/t03/p3-prerequisites/`；保留原150项，新增请求/维护/适配测试。旧断言未删除或放宽。
- 确定性FakeIO覆盖准备写入/flush/确认前后，发布材料/发布/确认前后，调用者停止等待、竞争请求、同键异输入、重开后的精确ID/结果、checksum正确但材料矛盾、维护票据、失效handle和关闭失败。
- 原生harness `p3-intent` 覆盖准备后close/reopen、历史和记忆结果去重、合作式维护、身份替换拒绝及上述旧handle反例；所有数据均为fixture(2)合成。新生成UUID记录在原生证据中。
- 原生未触发真实sync/archive；未验证新辅助格式的进程强杀、硬件断电、磁盘满或手机。旧P2强杀证据不能转记到新辅助格式。正常关闭后进程残留的退出清理不算故障注入成功证据。

## 5. 完整恢复、迁移与回退仍待实施

此原型**没有**完整辅助封装导出/导入入口；不允许把旧P2 bundle称为新库完整备份，否则会漏准备请求/生成ID。不能直接把新namespace交给旧adapter使用。旧P2库保留原样，新格式无就地迁移。

P3剩余：持久请求材料有界化；manifest路径复制/共享；command.entries、views/corrections、expected、重建标记、journal/ledger、目录/ID索引；重开检查点与完整枚举；稳定流式导出、空目标全引用/R1～R5审计、资源限制与安全激活；文本重复key/Unicode/深度/字节限制。全部仍pending，当前完整重放不能成为生产路径。任何损坏的唯一准备尾部被人为删除不承诺凭空找回；物理材料与故障边界需在完整格式中继续审查。

回退：停用本轮隔离harness/新入口，撤回本轮源码；保留新旧测试库和证据。新库不能由旧代码继续写，之后若有新数据需先设计完整导出再回退，不能丢准备记录。本次没有真实数据，不执行删除/GC。未创建新任务卡，P4/P5、手机和A服务器仍未开工。
