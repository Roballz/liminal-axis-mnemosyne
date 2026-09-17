# 最小接口契约说明

v0.1 · 建议基线；examples 是人工说明样例，不是完整生产协议

## 1. 必须共同遵守的字段

请求带 API/schema 版本、story_id、branch_id、head_revision、generation_id；生成准备还带 query、输入 hash、近期可见来源、预算和宿主能力。身份由服务端认证授权复核，不能信任客户端随意指定的其他故事 ID。

响应回显请求范围与 head，另外带 memory_revision、policy_version、coverage、blocks、warnings 和 trace。Adapter 应用前检查这些字段；不匹配就丢弃或重试，不能复用。

## 2. SourceRef

引用至少有 message_id 和 revision_id；可选 code-point 字符跨度。若使用跨度，必须规定坐标基于哪个不可变文本投影，以及 Unicode 计数方式，禁止混用 JS UTF-16 index 与代码点位置。原文改版后不得沿用旧 offset 指向新文本。

## 3. ContextBlock

包含稳定 block_id、kind、content、content_revision、source_refs、activation_reasons、placement、priority、compressible。token_count_estimate 要标是否精确。稳定块不写每轮变化的调试信息。

placement 是语义期望，由 Host Adapter 编译；role 与 position 分开。source_refs 可以为空的情况只有明确用户手写设定等无聊天来源记录，必须标 origin=user_defined，不能伪称正文事实。

## 4. 检索分数

trace 分开记录 dense_score、lexical_rank／score、rrf_score、rerank_score、rerank_status；缺值为 null。RRF 常数／权重与模型版本需记录。阈值只能对应产生它的模型／方法。

## 5. 修改与幂等

同步批次带 idempotency_key；内容 hash 不是唯一权限凭证。修改带 expected_revision；冲突返回 409 并要求合并，不能静默覆盖。写入确认必须代表正式存储完成，不是任务仅进入内存。

## 6. 建议错误语义

401 未认证；403 无范围权限；409 版本或 head 冲突；413 数据超限；422 schema／位置不能表示／常驻预算不够；429 限流；503 必需服务不可用。零命中是成功且 matches 为空，不使用异常来伪装。具体 HTTP 码在契约实现时最终统一。

## 7. MCP 门面

未来可提供 memory.search、memory.read、memory.prepare_context、memory.propose_change 等入口。写操作沿用同一授权、版本和确认流程；MCP 不绕过正文角色知识边界，不把数据库直接开放给模型。

## 8. 字段适用范围

generation_id 与输入 hash 仅要求出现在生成准备／相关调用中；导出、普通管理查询不必伪造生成 ID。用户身份由认证上下文决定。示例省略部分网络与事务细节，不能直接当成已完成的 SDK。

## 9. 示例解释

examples 的输入 hash 只是示例查询文本 UTF-8 SHA-256。生产实现应在 T-02 冻结包含近期上下文、来源版本与策略的规范化键，不能直接复制简化算法。示例中的分数、token 和排名均是人工说明，未执行服务。

本地模块允许注入正文，也可能把相应字段发给远程正文模型；这与不进入远程记忆数据库不同。严格不离机应同时禁止所有远程发送。
