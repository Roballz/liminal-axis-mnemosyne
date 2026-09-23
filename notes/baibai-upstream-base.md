# W-01 柏宝书基线

- 目标：Roballz/liminal-axis-mnemosyne，分支 `work/daily-memory-mvp-baibai`。
- 开工 HEAD：`cd728fde7b133b41db512efbc5c1358f439c03d4`，工作树干净。
- 上游：Roballz/ST-BaiBai-Book，源分支 `codex/item-keywords-presence`。
- 固定 SHA：`393873acd27906a09308ae65fe7e636a3d3941ab`；实际 detached checkout 核对一致。
- 导入日期：2026-09-23（UTC）。
- 引入根部 src、scripts、package.json、pnpm-lock.yaml、tsconfig、Vite 配置、manifest 和 dist；保留原 Mnemosyne docs/tasks/stages/packages/apps 等。
- 原 README 保存于 `notes/baibai-upstream-readme.md`。未复制 yuzuki 实现。

未改逻辑的固定上游已运行：`npm run build` 成功；`npm test` 14文件/244测试成功；timeRel 810、vector-depth 12、memory-regressions 53 断言成功。只用合成测试，未调用用户模型。

主要偏差：独立扩展品牌/DB/设置/注入槽和公共接口；新增 daily canonical、桥接、事件、自定义表、迁移包、页面和测试；向量/词法投影改用 canonical ID/正文；高层摘要保留并按依赖人工逐层重建；rerank fallback 不再伪造分数但保留余弦选档；无 canonical 证明的旧 bundle 不放行；新增显式只读旧知识库复制入口。旧聊天 delta 路线保留。

依赖保持源 lockfile，不新增框架。环境 pnpm 11 的默认依赖状态检查会因 esbuild 的安装脚本未获构建许可返回非零；包已下载，现有平台二进制可正常使用，实际通过 npm scripts 构建和测试。未执行依赖审批绕过、未改供应链策略。浏览器另见 final review 的环境失败记录。
