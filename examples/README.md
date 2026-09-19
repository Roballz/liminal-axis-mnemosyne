
# 人工示例，不是服务运行结果

全部内容为虚构数据，不是宿主或模型运行结果。

`context-prepare.request.json` 与响应使用 T-02 schema_version=1；响应 echo 完整回显 Mnemosyne run、分支快照、绑定/观察代次、记忆视图、策略及输入指纹。固定 UUID 仅为可复现 fixture，生产身份使用安全随机 UUIDv4。测试从相同 fixture 重建状态，核对指纹、引用及应用门禁；role/位置不代表设备验证。

`memory-echoes.module.json` 仍是后续模块的 0.1-draft UX 样例，不属于 T-02 校验器。它展示字段级发送权限、作者字段排除；允许普通字段注入远程正文，因此不属于严格不离机模式。V1 的普通剧情采用上帝视角，不按角色知情过滤。

`change-proposal.json` 仍是后续模块提案样例，须确认后才能变更；不是 T-02 command，也未调用模型或应用修改。其中短 ID 不可作为 schema_version=1 领域身份导入。

T-02 形状/跨引用/状态转换校验入口见 `packages/contracts/index.mjs`。HTTP、正式导入器、持久化恢复、模块 schema 和最终宿主注入仍未实现。旧 head_revision/generation_id/input_hash 查询示意已从当前 prepare 样例移除；历史证据不重写。

v0.3返修：现有prepare JSON仍有效，未写dependency_mode的记忆引用继续使用current检查。固定累计检查点的可运行构造样例见 `packages/contracts/tests/review.test.mjs` 的cumulative：同memory_id、严格前缀coverage，引用加 `dependency_mode:"checkpoint"`，选择显式用advance；提取纠错用correctMemory，不把所有旧版本当有效。逻辑包升级为format_version=2以保留分支corrections。
