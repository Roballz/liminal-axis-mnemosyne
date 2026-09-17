
# 人工示例，不是服务运行结果

全部内容为虚构数据，只用于明确 v0.1 契约。

`context-prepare.request.json` 与响应共享输入、分支、head 和 generation ID；请求指定期望位置，但设备能力尚未验证，响应明确提醒 Adapter 必须验证。

`memory-echoes.module.json` 展示本地持久化、自定义字段、默认不向副 API 发送、作者字段排除，以及可独立配置的注入位置。它默认允许可见字段注入正文，因此不属于严格不离机模式。

`change-proposal.json` 展示未提交提案，须确认与版本检查后才能变更；不是已经调用模型或应用修改。

正式 schema、HTTP 客户端、数据迁移及完整验证器均待开发。
