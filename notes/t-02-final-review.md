# T-02 最终 Chat review：R5 关闭，最小契约验收通过

日期：2026-09-19。
审核实现提交：`1891043f6fc907236e12bb85d63ea823f43abca8`。
R5 返修前基线：`28b94d4e6f37d728b5132b3d8f834d6873f09e07`（契约实现与 `d99e1d5` 相同）。
前轮记录：`notes/t-02-chat-review.md`、`notes/t-02-chat-review-round2.md`；它们保留为历史审核记录，当前结论以本文为准。

## 1. 结论

**通过。R5 关闭，T-02 升为 verified，限本任务的最小可执行契约与 Node 内存参考模型范围。**

当前复核范围内未发现新的 T-02 收尾阻塞。接受 `docs/06-contracts.md` v0.3 / 对象 schema_version=1 / 逻辑包 format_version=2 作为 T-03 的契约及参考测试基线；不表示生产数据库、持久化恢复、真实摘要或手机使用已实现。

**T-03 仍为 proposal。** 本轮不修改该预备卡、不启用、不执行；需按最终契约、真实 TT 数据库能力、安全测试环境与恢复验收门禁重新核对后，由 Chat/用户明确启用。

## 2. 本轮真实执行证据

环境：隔离 Linux / Node `v22.16.0` / Git `2.47.3`。不同于 Codex 的 Windows 环境，不是 TT/Android 联调。

获取方式：通过 GitHub 连接读取指定提交；运行容器无法直接联网下载，故将已读取的原文件文本原样复制到隔离目录。下列全部 13 个文件在执行前逐一校验 Git blob SHA，一致后才运行；没有修改被测实现、断言或 fixture。

| 文件 | Git blob SHA |
| --- | --- |
| packages/contracts/primitives.mjs | 04ce5962ed179343af35b94ebc2e48b8c06b0e8d |
| packages/contracts/schema.mjs | 864f21302c45cd2324c1cfbccf09829e5f6a4075 |
| packages/contracts/history.mjs | 39370d7f621f708c1fdc81de93e4c79106a5fdca |
| packages/contracts/index.mjs | b86662882940d45572e09a991424014ce4b4c2f9 |
| packages/contracts/memory.mjs | ed37308f418031ccc559b8b318e79c8d1c2ad553 |
| packages/contracts/context.mjs | 30a7410263fa8070dc90233e142b146112be102f |
| packages/contracts/transfer.mjs | 9c5f59dcc9b33de50d07ea4540425a892dcfa8fb |
| packages/contracts/tests/fixture.mjs | 4be1e82e92434c73793c4c7553556e653ac4da51 |
| packages/contracts/tests/contracts.test.mjs | 76f264e258ab315ee833c9d14a80a245a3b9ce71 |
| packages/contracts/tests/review.test.mjs | a30537bab3398012f174742a8380e4d8ee5035d3 |
| packages/contracts/tests/review-round2.test.mjs | 5b7aadcad6cacf111e874a20963fb16298c27ec5 |
| examples/context-prepare.request.json | 3cbd0797eec9c3b4d0422ca8082012a06efed713 |
| examples/context-prepare.response.json | 8554cacc452e4fa350839522c836d651a0079b0a |

### 实际命令与结果

| 执行项 | 结果 |
| --- | --- |
| `node --test packages/contracts/tests/review-round2.test.mjs packages/contracts/tests/review.test.mjs` | 16/16 通过，0 失败/跳过 |
| `node --test packages/contracts/tests/*.test.mjs` | **48/48 通过**：原 32 + R1～R4 的 10 + R5 的 6；0 失败/跳过 |
| 对 packages/contracts 及 tests 中全部 `.mjs` 逐一执行 `node --check` | **11/11 通过** |
| 独立副本恢复修复前 memory.mjs，再执行原样 R5 新测试 | **0/6 通过、6/6 失败**；进程退出码 1，属于预期红灯对照 |

红灯副本的 memory.mjs 校验为 `0b594acbf878d2afcfc7dbf06e150186c5051eaf`，即 `d99e1d5` / `28b94d4` 的实际旧 blob，不是另写一个假旧实现；其他六个实现模块未被 `1891043` 改动。六项新测试也未修改。

本轮完整哈希、TAP 与语法输出交付为 `t02-1891043-review-evidence.txt`。本文已保存可复现命令和结论，Codex 不需要依赖会话文件路径才能继续。

探针 **18/18**、完整仓库 `git diff --check`、Windows 下合计 **66/66** 为 Codex 回报，本轮未独立复跑，不混称 Chat 独立 66 项通过。GitHub 提交比较确认此次实现只改 memory.mjs +14/-2、新增 113 行测试，探针及 T-03 预备卡未变。

## 3. R5 修复审查

### 矛盾状态在导入边界拒绝

`isUncorrected` 复用同一 `dependencyTarget` 解析该分支纠错链；`checkExecutionGraph` 要求每个被选中根版本解析后仍为自身。validateState、exportLogical、importLogical 复用此检查。

已实测一跳、多跳、纠错链中间版本仍被选中的反例。即使导入包 checksum 正确，也拒绝矛盾关系并保持输入不变；不自动选择替代版、不删除纠错记录。

### 最终注入同样拦截旧根

`memoryStatus` 对已被纠正的根版本返回 needs-rebuild；原 prepareAvailability / canApply 的 selection 与有效性检查继续生效。既检查本轮 required 范围，也检查没有列入 required、仅放进响应块的旧摘要；两条路径均拒绝。

### 没有把合法历史版本一起禁掉

正常纠错链可逻辑往返并在父线注入新版本；分叉时固定的子线仍可使用其旧版本。合法 advance 的未纠正旧检查点仍有效；历史检查点纠错的新终点无需成为当前累计选择，其依赖后缀按原规则重建。R1～R4 测试保留并通过。

由此关闭前轮唯一阻塞 R5；没有引入新的字段、逻辑包版本、依赖框架或数据库实现。

## 4. T-02 交付边界与未决项

已验收：独立身份与不可变正文版本、固定 fork/Head、有序清单参考校验、来源/coverage、分支相对有效性、检查点/纠错传播、幂等重试、运行过期门禁、逻辑包及矛盾关系拒绝的最小实现与测试。

仍未验证/未实现：生产存储与崩溃恢复、真实 TT/手机联调、复杂导入对齐器、自动 LLM 派生与实际重建执行、完整 Context 编译/预算和大规模性能。非标准回合、品牌名、模糊匹配阈值、自动保留/清理等原未决项继续存在，不能把 T-02 verified 解释成全部产品功能已完成。

历史附件中的 24 项清单用于保存讨论脉络，不覆盖之后的 Head 确认、正文权威规则或本次最终验收。

## 5. 给 T-03 的交接

下一步先核对已有 T-03 proposal，不立即实施。必须以最终 `packages/contracts/`、06 v0.3、逻辑包 v2 为基线，保留：

- Head/清单/正文/operation 结果完整发布与可恢复性；
- 分支 memory view、selections/corrections 的一致发布及 R5 交叉不变量；
- 固定历史检查点与当前纠错关系不能混淆，子线保持隔离；
- 可重建索引、无 embedding 也能保存正文、精确 ID 查询及完整逻辑导出；
- 手机/桌面各自的安全测试与未验证边界，不以 Node 内存测试代替真实存储验收。

本轮只写验收与状态文档，未直接修实现、未改现用聊天、未执行 T-03。
