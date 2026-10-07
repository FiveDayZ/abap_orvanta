# r48：真实 CUNI 路由验收及标准激活闭环

编制：2026-10-05T10:00:33.077+08:00，Asia/Shanghai。用户本轮“批准继续”已批准 r47 具体部署申请；ROUTE 对象已创建，前一计划中的对象批准依赖已解除。以下工作尚未完成。

## 目标及最小交付

1. 使用当前冻结独立 r47 构建，等待用户仅在打开的窗口输入 w200/200 WYS 口令。先验收原生 source/target 拒绝清空和真实装载，再调用 inspect_configuration_bc_route 两次，验证完整成员/方法、同一元数据版本、四项 schema 拒绝、过期目标在 nativeRoute 前拒绝、完整五表 before/after 不变；不在登录后重编译。
2. 仅凭真实 OBJM 名称读取后导入方法及完整依赖。核对除五表之外的 OBJS 成员、LANG_OBJ/MULTI_OBJ/UPGRADE/SHADOW_SYS，以及实际字段/键、派生表与恢复范围；没有正例不能提升 route verified。
3. 补齐 SCPR_ACTIV_MN_ACTIVATE、SCPR_PRSET_CT_IMPORT_INDUSTRY、SCPR_PRSET_CT_ONE_TABLE_LOAD、SCPR_ACTIV_TRANSP_TABLE_FILL、TRINT_CALL_AFTER_IMP_METHOD 的相关完整依赖和 FG 全局初始化。核对真正协议 handle 创建入口；当前 where-used 返回的 SCPR_ACTIVATE_BCSETS_REMOTE 在 repository 搜索/URI 解析中未确认存在，该旧索引结果不是可用调用证据。
4. 将标准 API 的分阶段保存/日志/CTS/after-import、任务归属、锁内版本和全部 before/after 键形成具体执行/失联对账/恢复契约。完成源与接口候选、本地受影响回归及完整变值清单后，再申请新执行对象及一次真实配置写入；不以当前只读授权扩大范围。

## 必须验收

- 路由：真实装载与公开端点正例一致；两个 native 元数据输出稳定；不执行方法，五表及共享 PRESS 不变。
- 激活：只有明确配置写入批准后执行；完整值、所有方法影响表、键级 CTS、日志、锁及无关行逐项对账，部分/未知结果不冒充整体成功。
- 拒绝：源/目标/元数据漂移、权限、错误客户端、未知方法、extra 参数和不正确请求任务应在写入前拒绝。真正权限/并发故障仍需相应测试条件，WYS 正例不代替。

## 已确认依赖与限制

- 标准 BC Set 锁 SCPR_SV_ENQUEUE_BCSET 只锁 BC Set ID；导入函数另行按表/client 加 ENQUEUE_E_TABLEE。锁失败会删除相应待处理对象数据并继续记录状态，不能把 BC Set 锁等同全部配置数据原子锁。
- 标准配置导入保存、CTS 及独立连接日志可能存在分阶段结果；NO_COMMIT 不能证明日志回滚。后导入调度尚待实际 CUNI 方法和 TRINT 的 FORM 依赖，传递该标志不等于方法已遵守。
- 标准传输处理接受父请求/任务并作内部处理；自定义命令必须独立核对 W/Q 类型、所有者、开放状态和 client，不能仅靠标准处理中 USER_NOT_OWNER 的分支判断批准。
- ATC 预检实际 HTTP404，当前端点不可用；语法诊断清洁仍需真实装载验收。
- 现有开发与 AI 技术测试授权持续；本轮已批准创建的只读对象无需重新审批。BC Set 激活、simulation、方法执行、KNM/PRESS 改值、配置 CTS 和传输释放仍不在本轮范围。
- 全 SPRO backlog CFG-04 执行与恢复、CFG-06 跨系统边界、CFG-07 独立业务动作、CFG-08 明确业务域仍需完成。继续 API-only，不开启通用标准表写入口、不重启共享服务或覆盖他人修改。
