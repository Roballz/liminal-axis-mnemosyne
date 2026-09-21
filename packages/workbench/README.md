# T-05 手动搜索工作台

实现状态：implemented_unverified；Chat 决定验收。入口为现有隔离 `apps/tt-import` 面板的“打开手动搜索工作台”。已有库取消“创建空库”，填写原 namespace 后打开工作台；查询路径不调用导入预览、prepare/execute/recoverPending/resume。

## 使用

1. “读取目录”每页最多4项；可选已绑定档案或全部分支。当前导入面板有已确认绑定时默认选中它；其他情况人工选，不猜故事归属。可读 locator 文件名优先显示，否则使用短 ID。
2. “选择档案/当前快照”；pending/partial/paused 必须明确勾选最后确认档案。历史按钮沿所选分支 previous_snapshot 前进，始终标历史；不会恢复 Head。
3. 输入查询点击“查找”或回车。默认只查正文；空查询不扫描。“分页浏览正文”提供独立浏览入口。一次一条消息内字面子串，所有角色可查。
4. partial 表示未穷尽，继续按钮使用原会话游标。本批结果替换上一批，DOM 不累积全库。超大单条/对象或原生读取预算不足会停在原位置并报告 unchecked；当前版本不承诺可完整检索超过单条预算的正文，不跳过后伪称完整。
5. 旧摘要辅助与正文分型；不同 scope/旧 asset 版本仅显式历史辅助查看。同分支其他快照不自动成为当前剧情，父分支资料不会继承混入。展示完整旧资料声明及原 floor/range；准确 anchor 需当前 binding、offset、map、正式 Revision 与所选 snapshot 成员共同证明。锚不等于完整生成来源。
6. 详情固定命中快照及前后各一条原文；位置是档案序号。当前未接入已核验的宿主定位公开接口，因此“来源跳转/档案回退”明确回退档案，不改聊天、不猜楼层。关闭/取消只撤销自身会话，导入 owner 保留。
7. 导出按钮是**完整库恢复包**，含所有分支/桥接/请求与候选空位，不是当前结果子集。固定 exportSnapshot checkpoint；默认16 MiB，超过拒绝下载，不输出不完整备份。临时 Blob 在本地生成，无查询或内容联网。

## 读取和资源边界

`PagedCoordinator.handle().readView(request)` 为队列内小型只读 facade；state、record、entry、prefix list 不改变格式或发布协议。stamp 固定 library/checkpoint/owner epoch。调用前检查 stamp，服务批次返回前再 fence，页面最后再检查 UI 代次；多次 await 不冒充统一事务。预算拒绝不把 owner 隔离为 recovery-required；缺失正式引用仍为数据错误。

默认扫描32项、20结果、2 MiB页读取、256 KiB正文/投影、1秒；单次 facade 最多256次原生读取，整批最多2048次。metadata/select/detail 用独立10秒预算；最终版本 fence 为单次有界额外读取。时间预算不取消已在途原生调用，只禁止下一读/页；单调用和排空可能越过墙钟预算。临时投影只存当前单条，无持久缓存或全文物化。详情合计256 KiB；大型正文不能完整展示时明确拒绝，不截断冒充全文。

规范化：ECMAScript runtime NFKC → Unicode **17.0.0** CaseFolding.txt 的 C+F（完整默认、非土耳其特例）→ 固定 Unicode White_Space 集合折叠/去首尾。映射来源与 Unicode 许可证存于 unicode/；`node packages/workbench/unicode/generate.mjs` 可再生，不需安装依赖。NFKC 使用实际 Node/WebView 内建 Unicode 数据，新增字符的兼容规范化可能随运行时变化；投影不跨进程/运行时持久复用，规则版本单独固定，原样模式不变。没有原文偏移映射，所以只标规范化命中、原文安全片段，不逐字高亮。

打开既有库可能执行 native open/flush；不是零物理IO承诺。工作台从导入页借用唯一注册 owner，不执行业务恢复。停止整个导入面板才会按原生命周期关闭 owner。维护门禁 `HOST_MAINTENANCE_UNSUPPORTED` 保留。

## 有限验证

S01～S07：`node --test --test-reporter=tap packages/workbench/tests/workbench.test.mjs`。测试使用真实 PagedCoordinator/Importer/FakeIO、完整分页包恢复及产品按钮处理函数；小 DOM 宿主不是浏览器/手机证据。

S08：`native-button.json` 是酒馆助手一次性合成验收入口，非普通产品入口；`node packages/workbench/native-collector.mjs` 启动仅回环模块服务。用户导入并启用脚本，在收集器就绪后只点击一次。固定 namespace `mnemo-t03-paged-t05-20260922a`；仅4条合成正文+1份摘要，空库断言，不清除/替换/重试。4分钟工作预算，下一动作/读取前检查，最后排空并单独报告 close，整轮预期不超5分钟。出现原生失败保留库并报告，不换 namespace。回执仅含范围、计数和断言，无原文/摘要。

当前 S08 尚待用户手动点击；不能把 Node 断言称为 TT/手机验证。关闭临时入口或工作台即可回退；不删除档案，不影响既有 T-04 同步。后续只交 T-05/S-B review，不开启 T-06。
