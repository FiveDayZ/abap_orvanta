# r51：准确 CTS 前态与标准 API 命令闭环

实际时间：2026-10-05T15:47:52.950+08:00（Asia/Shanghai）。依据原 SPRO backlog CFG-04；本计划承接已通过的 r50 只读预检。原 14:41 待登录计划保留为历史记录，不作为当前状态。

## 目标、最小交付与验收条件

1. 优先取得固定 CUNI/批准请求任务的完整只读 CTS 来源：请求/client/类型/owner/status/父子关系、E071/E071K（必要时 E071K_STR）全部前态及准确空格键编码。默认 E070C/E071K 的 TABLE_NOT_ALLOWED 拒绝保持；不扩大任意表查询、不借其他操作绕过。最小交付是实际标准读取 API 的接口/源码证明与范围严格受限的客户桥接候选；需 SAP 新对象时先提交完整源码和精确部署对象。
2. 补全 LOCAL_START、ACTIVATION FORM、下层更新任务/提交、所有异常退出及会话清理；逐个绑定实际 ECC7.31 DDIC/接口/源码身份。当前 TRINT_APPEND_COMM 的 307 行实源已读取：它修改 TABLES 输入并分别插入 E071/E071K/E071K_STR，插入失败可能 short dump，无独立权限或锁检查、无 COMMIT。应由完整上层权限/任务锁及事务契约保护，禁止直接对外开放。
3. 关闭来源 D→语言1/D/E的实际标准入口映射、九表锁内版本重检与 native typed 前态保存/恢复。形成完整专用客户 APPLY、独立 RECONCILE/RECOVER 的平面 RFC 契约及 ECC7.31 源码候选；不以 SOAP 显示字符串重建 FLTP，不生成占位函数，不把 NO_COMMIT 当全局原子性证据。
4. 本地验收覆盖正常、无权限、过期/并发、部分结果、异常/超时、重复请求、会话/锁清理和恢复范围；新对象部署授权仅针对准确对象与源候选。真实配置执行另形成19键完整变化、准确请求/任务、日志/锁/CTS副作用、最多调用/改值预算、创建行清理、共享 PRESS 恢复和未知结果接管清单，最后再申请具体业务操作批准。

## 当前已确认事实与限制

r50 的实际公开工具 preflight_configuration_bc_activation 已通过12次只读验收调用：9表19固定键、10个假设新建、PRESS不变、7条存在保护行和1条缺失 OIB 行；4类schema及2类过期版本拒绝、完整前后复读一致，配置写入0。源/目标/候选/元数据/保护五版本和4 API身份绑定，snapshot/executable/activationAvailable/simulation均false。重复顺序观察不是锁内快照。

当前命令尚未实现；真实激活、模拟、配置保存、CTS追加/清理、恢复写入及释放预算全部0。KG 的既有保存恢复批准不覆盖整包 BC Set。共享服务仍189工具、默认dist及原暂存保留；r50独立只读实例保留登录供后续获准读取，无GUI。

r50 首轮默认fetch客户端超时原始回执完整保留；同一冻结实例重读前态后，以native HTTP验收客户端成功收到完整长请求结果。源码HTTP仅给新预检POST的SSE写保活注释，普通JSON和其他工具不受影响；本地310秒默认fetch公开MCP调用通过，原无保活fetch实证UND_ERR_BODY_TIMEOUT。修正后的产品HTTP和预检代码随后使用默认fetch客户端完成真实SAP数据全链复验：4个未变的只读子API及函数身份通过MCP委托已登录冻结实例，17个子调用均取实时SAP数据，结果与前次完整预检相等，独立前后读回不变。没有复制口令、mock子结果或重启共享服务；这不表示新独立进程已部署或重新验收SAP认证。当前长RPC仍须配置足够的协议期限（本次1200000ms），保活不会修改该期限。下阶段先优化同一请求重复元数据读取，保留前后独立身份/值核对，不用缓存隐藏漂移。

已有专用inspect_configuration_transport实际确认429/430的W/Q类型、D状态、父子/owner WYS、client200及目标GR3；所有检查true、writeAdmission仍blocked，没有unitText/E071K读取。通用read_abap_table的E070C拒绝仅代表其通用范围限制，不能误当专用CTS API不可读。下阶段优先复用现有专用实现与类型/源证明，完整E071/E071K/E071K_STR和精确空格键仍须补齐；不扩展通用白名单。

## 依赖、剩余风险及全项目收口

P1：准确CTS前态、标准无对话调用/提交/会话清理和typed恢复仍未关闭；协议日志使用独立 R/3* 连接，主连接回滚不能撤销日志。使用真实用户和具体配置任务，不能采信调用者审计字段或自动换任务。

P2：真实non-WYS权限拒绝、并发/ABA、populated FLTP/OIB及失败/部分激活/超时/重复激活验收尚未完成；r50公开正例耗时受重复元数据读取影响，应先量化并消除同一请求的重复工作，保持前后身份/数据复核，禁止跨请求复用过期前态。CFG-06 双侧变化/失败验收、CFG-07 业务启用及实际触发待补。

P3：CFG-08 具体业务域和组织键尚未选定，按标准业务语义 API 扩展；不能宣称任意 SPRO 节点都已自动配置。全部项目未结束，继续遵循自动规划规则。

## 证据

- [实际 r50 回执](<C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-preflight-acceptance-20261005-152756-r50.json>)
- [CTS 追加实源](<C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-cts-append-source-20261005-154752-r50.json>)
- [新 HTTP 入口真实只读集成](<C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-preflight-http-live-20261005-154752-r50.json>)
- [现有专用 CTS 头部回执](<C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-cts-purpose-headers-20261005-154752-r50.json>)
- [标准链与当前执行恢复候选](<C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-execution-recovery-contract-20261005-r50.md>)
