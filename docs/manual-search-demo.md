# 日常手动搜索 demo：持久语义与范围

状态：implemented_unverified（2026-09-22），用户授权临时日常使用封装。T04/T05 原验收状态不变，不创建或推进 T06。

- 正常扩展入口为 `apps/manual-search`，运行源码在 `packages/demo`；复用 T04 Importer、T05 Workbench 和现有分页存储。
- 固定独立 B namespace `mnemo-t03-paged-manual-demo-v1`，其中每个命名档案对应现有正式 source/story/branch 绑定。不是每个显示库名单独创建物理数据库。不得根据正文或文件名合并身份。
- 首次连接仅在注册唯一 owner 后通过原生 nodeCount 精确空库证明允许 create；非空库只能 recover。这里的 recover 读取原检查点，不执行 pending 请求；执行原 pending 必须用户显式点击恢复。
- 原始正文/摘要不放 localStorage；只存主题偏好。无自动同步事件处理器。宿主事件只使读取结果、预览、游标失效。
- 名称与最新摘要选择用 v1 `demoArchive` 桥接记录持久化，字段为 source/name/branch/head/session/assets/updated_at，沿用 bridge CAS 事务、完整导出与恢复重放。assets 最多512个确切 asset key。此新记录要求恢复工具包含本次校验器；不改变分页根/发布协议。
- 手动确认完整同步后才发布 demoArchive。搜索必须匹配完整 binding、最新 Head、session。两步间中断时拒绝混用旧清单，保留原已提交批次，用户在原聊天重新预览同步完成目录发布。未完整导入仍遵守既有固定输入恢复规则。
- 默认搜索最新正文和本次仍存在的已有摘要；未改文本的摘要保持原 scope/declaration，不把新正文 Head 冒充摘要生成来源。删除的摘要从最新选择清单中排除，旧对象仍进入备份。
- “当前正文 + Swipe”仅额外检查当前消息正式 map 中最近同步保存的候选数组；逐条校验精确 ref，受同一 checkpoint/generation/read/text 预算保护。每条消息至多一个结果，正文优先；否则候选详情显示全部匹配槽位。不是所有历史快照扫描，不包含已删除消息历史，不建立索引。
- 同步替换默认可见内容，沿用不可变旧正文/历史恢复材料；不物理覆写清理、不 GC、不新增历史/分支管理、不推断重命名/复制/分支归属。
- 浮窗 Shadow DOM 隔离主题与宿主；输出全用 textContent；两类下拉弹层随主题着色，键盘箭头选择/Enter确认/Escape关闭。标题拖动、角标缩放；收起取消读取，dispose 排空后关 owner，pagehide/unload 清理入口。TT 停用后刷新页面的最终行为仍待原生验证。
- 构建仅复制传递可达模块，整棵依赖路径 runtime-版本号同步更新，禁止只刷新根模块；备份沿用完整分页包与16 MiB下载门限。

安装、使用、限制、回退与手动 smoke 步骤见 `apps/manual-search/README.md`。这是临时 demo，不是生产容量承诺或手机验证。
