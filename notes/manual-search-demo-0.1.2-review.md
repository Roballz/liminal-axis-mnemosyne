# Demo 0.1.2 魔法棒入口

起点main 2d03b45。用户实机确认0.1.1摘要数量正确，但桌面原生左右侧栏仍被压窄；撤回上一轮“零宽固定根节点足以解决侧栏”的假设。用户要求移除气泡并使用魔法棒，先发布可上手版本，再继续导入性能。

依据安装版柏宝书32dbb48/src/menu.ts：#extensionsMenu内添加extension_container/interactable与list-group-item，点击后隐藏宿主菜单。无需ST内部模块。menu.mjs等待菜单出现，挂载后停止观察，卸载清理菜单项。

移除气泡样式和拖动逻辑；面板初始脱离文档，open时挂在documentElement下，close时移除，因此关闭状态无浮窗节点，打开时不新增body布局子项。保留浮窗拖拽/缩放与异步取消保护。移除过时气泡测试，替换为真实菜单/面板处理器生命周期反例；既有面板用例入口改为open()。

验证：node --test packages/demo/tests/menu.test.mjs，1/1，约80ms；panel语法检查；构建37个运行模块。不跑数据库集合或原生导入，桌面侧栏待用户更新0.1.2并完整刷新后确认。状态implemented_unverified，不称实机已通过。

性能只读核对：TT 367b0c7 Database.md有batchInsert但自动分配NodeId；现有分页按hash计算指定ID，需要upsert，不能直接等价替换。syncMode=full及发布/恢复保证保持；没有偷换为低持久性模式。
