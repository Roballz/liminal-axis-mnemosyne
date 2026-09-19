# T-03 P0～P2 evidence

基线main@852260a，2026-09-19～20实际执行；不含真实RP、token、生产日志或数据库备份。总任务in_progress，停G1。

- `node-tests.tap`：最终131项结果，含48个确定性断点的seed/operation/前后状态诊断。`provider=deterministic-fake`不是TT持久性结果。
- `native/20260919a-p0.json`：TT367b0c7实际API、复杂JSON、精确ID、正常重开与WebCrypto对照。
- `native/20260919a-before.json`、`20260919b-before.json`：初次失败；b包含NodeId0保留值的实际错误。未删除失败证据。
- `native/20260919c-{before,after}.json`：已确认基线和真实kill-ready断点。对应`*-process.json`记录精确隔离PID/路径和强杀时间。
- `native/20260919c-recover-{before,after}.json`：真实进程重开回读及原operation重试；两侧表现不同而正确。
- `native/20260919c-roundtrip.json`：第一轮原生小包/竞争/中断导入结果。
- `native/20260919d-roundtrip.json`：最终轮额外验证导出快照不随后续写入变化；d使用全新namespace。
- `native/20260919d-reopen-check.json`：额度中断后再次重开d-restored库，5条账本和原状态保留；非额外受控强杀证据。
- `verification.json`：最终代码哈希、语法检查、部署fixture与当前fixture生成请求的一致性。JSON源文件按文件哈希识别；不以后补说明冒充现场输出。

解释与未验证范围见正式任务及docs/09。物理数据库留在被忽略的`.t03-local`，没有上传/提交数据库或现用TT日志。测试库未经许可不自动清理。
