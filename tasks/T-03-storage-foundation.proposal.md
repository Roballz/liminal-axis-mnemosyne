# T-03 预备任务：历史入口

状态：superseded（2026-09-19，经 T-02 最终 review 后由 Chat 修订发布正式卡）

**当前唯一施工入口：[`T-03-storage-foundation.md`](T-03-storage-foundation.md)，状态 planned。**

原预案完整内容保留在 [规划基线 4dcdaf5](https://github.com/Roballz/liminal-axis-mnemosyne/blob/4dcdaf568ddb596c9060c27ef4c57fb858095509/tasks/T-03-storage-foundation.proposal.md)。本文件改为转向入口，避免两张不同要求的 T-03 卡同时可执行；不是删除历史讨论或授权 Codex 自行重规划。

## 本次正式化的主要修订

- 固定 T-02 已验收实现 `1891043`、06 v0.3、对象 schema_version=1、逻辑包 v2；纳入 checkpoint/current、分支 corrections、R5 交叉校验和真实持久提交需求。
- 高难前置：P0 最小前提核对 → P1 发布/幂等/恢复协议 → P2 真实 TT 故障小闭环 → G1 review → P3 有界清单/完整恢复 → P4 索引及资源验证 → P5 诊断与文档收尾。
- 首次只执行 P0～P2，G1 未放行不得扩大到 P3；B1 不满足时 B2/A 仍交 Chat/用户决定，不预先绑定数据库。
- 备份只承诺当前已建模对象及必要的版本化存储恢复材料，不提前声称完整模块、用户锁、通用任务和全产品备份已实现。
- 默认纯合成数据和隔离桌面测试；手机单独准入，性能数字先作探索测量，生产手机/真实档案不在本轮写入授权内。

所有实际实施回报、关卡结果和状态更新写入正式卡。此历史入口不再追加施工指令。
