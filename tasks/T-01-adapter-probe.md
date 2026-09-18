# T-01：最小 TT Adapter 探针

状态：planned

## 用户目标

在隔离的 Windows x64 TT 测试环境验证 Mnemosyne 能等待一次外部记忆准备、处理取消／切聊天，并把三类注入位置的实际 payload 记录下来。

## 前置与必读

- T-00 已记录 TT 2.2.0、电脑端隔离测试原则和未知项。
- 必读：`AGENTS.md`、`docs/01-architecture.md` 第 0～3、11、15 节、`docs/05-source-review.md`、`stages/S-A-foundation.md`。
- 当前仓库来自源码压缩包，基线 commit：unknown。

## 允许修改

- 只新增 Mnemosyne 的探针／适配器代码与脱敏验证记录。
- 不修改 TT 客户端、柏宝书源码、用户聊天、IndexedDB 或生产配置。
- 不提交真实聊天、密钥、令牌或生产日志。

## 实现步骤

1. 固定实际扩展入口与 API 来源；无法从安装目录确认时，记录用户提供的扩展目录或通过 TT 只读查看。
2. 实现最小探针：工作台打开、访问测试服务、延迟时正文请求等待、超时／取消可观察。
3. 使用 generation ID、chat ID 和 head revision 丢弃过期响应；验证切聊天和连续生成不注入旧结果。
4. 分别记录 `before_history`、`user @d0`、`system @d0` 的实际 payload、顺序和清理行为。

## 验收

- 正例：测试服务响应后只注入当前聊天、当前 generation 的探针块。
- 反例：服务超时、取消、切聊天或响应过期时不注入旧块，并有可观察状态。
- 三类位置均有真实 payload 证据；未支持的位置标为 unsupported，不用文档推断替代。
- 未执行的移动端、生产聊天和 Android 联调保持 pending。

## 实测记录

- 环境：Windows x64，`E:\TauriTavern\tauritavern.exe`，2.2.0。
- 命令／时间／结果：pending，待取得扩展入口与安全测试样本。

## 回退

关闭探针扩展或禁用探针开关；不改写现有注入者和聊天数据，无数据迁移。

## 文档更新

完成后更新本任务、`notes/baseline.md`、受影响的契约文档和 `CHANGELOG.md`；若发现宿主能力与建议基线冲突，先记录事实，再提出决策。

## 开工检查

- 基线 commit：unknown（源码压缩包）
- 工作分支：unknown
- 已读文档：`AGENTS.md`、`README.md`、架构基线、决策记录、来源核验、阶段 A、T-00
- 已确认输入：TT 2.2.0，路径 `E:\TauriTavern`，隔离桌面测试原则
- 真正缺失项：扩展目录／入口、可脱敏测试聊天或可在 TT 内创建的虚构测试聊天
- 预计修改文件：探针实现、脱敏记录、本任务及受影响契约
- 预计验收方式：TT 隔离环境中的真实 payload 与取消／切聊天证据

## 实施回报／交接

待实施。
