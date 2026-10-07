# r52：Z_ORVANTA_CFG_BC_STATE 完整部署审阅

2026-10-05T20:04:46+08:00（Asia/Shanghai）。当前 **Partially Verified**：完整本地源码/接口与MCP接入已完成，SAP对象尚不存在，未部署、未进行其SAP运行验收。

## 具体动作与范围

拟只在 w200/GR2/client200 创建并激活远程客户函数 **Z_ORVANTA_CFG_BC_STATE**，父组 **ZORVANTA_BC_CFG**、包 **ZABAP**，开发请求 **GR2K923472 / 任务 GR2K923492**。生成的函数Include与UXX目录由标准客户对象创建工具处理，不手改标准对象、TOP或已有五个函数正文。部署前重新核对准确URI、完整源备份、组/任务版本与锁；读回、诊断与激活后逐项比较旧接口/源。当前任务owner WYS/status D；TADIR唯一行确认包ZABAP；当前WYS/client200锁查询0条，不能替代部署前全目标锁检查。原对象不存在回执已保存。

该函数仅固定 EHS_CUNI_KNM/N、CUNI、九表十九键、配置请求429/任务430；不允许任意表、client、BCSet、传输根、恢复字节或方法。部署会录入开发CTS472/492；429/430只有读取，配置CTS不追加/删除/恢复/释放。对象编译激活与BCSet激活是不同操作；本方案不激活或模拟BCSet。

## 完整可审阅候选

[全源](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-state-candidate-20261005-200446-r52.abap)（414正文行，逐行≤72字符）；[完整接口与依赖](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-state-candidate-20261005-200446-r52.json)；[全部实际读取/检查](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-state-evidence-20261005-200446-r52.json)。正文SHA256：5da4894421b56d22d38eccaccd01a22883d76a89645c72cdfa3ea7ce9382d554；九表布局绑定：da348eaef777b1a459779cb49688d39169ebfc8516af05a3baaf8a492b3f77c5。候选文件不是SAP已保存源，ECC7.31兼容性当前仅静态约束，实际语法/IMPORT仍需部署后证明。

Import 10项均STRING、VALUE、必填：IV_BC_SET、IV_VERSION、IV_REQUEST、IV_TASK、IV_SOURCE_VERSION、IV_TARGET_VERSION、IV_CANDIDATE_VERSION、IV_METADATA_VERSION、IV_GUARD_VERSION、IV_CTS_VERSION。六个版本来自服务端当前READ/PREVIEW/ROUTE/GUARD/CTS结果；调用者不得提供外部恢复包。

Export 17项均STRING、VALUE：EV_CODE、EV_SYSTEM、EV_CLIENT、EV_USER、EV_REQUEST、EV_TASK、EV_SOURCE_VERSION、EV_TARGET_VERSION、EV_CANDIDATE_VERSION、EV_METADATA_VERSION、EV_GUARD_VERSION、EV_CTS_VERSION、EV_STATE_VERSION、EV_DATA_BASE64、EV_DATA_BYTES、EV_ROW_COUNTS、EV_ROUNDTRIP。无TABLES/CHANGING/例外/update-task。成功STATE_READ_OK才填完整身份、版本、九表有序计数、Base64/字节/SHA256与ROUNDTRIP=X。失败只保留稳定错误码；依赖返回的已知原始码保留，其他结果不发布。

## 行为与提交边界

每轮以客户CTS前后夹住READ五表、PREVIEW五表候选版本及GUARD四表保护；总共两轮配置原生EXPORT一致。每轮将全部九个准确DDIC表（包括空表）、系统/client/user、源/候选/目标/元数据/保护/CTS、两根请求及九表布局指纹一起EXPORT；内部IMPORT到同类型新表与STRING变量，重新EXPORT后逐字节相等。表计数合计≤19；单表1或3行；原生缓冲上限524288字节。所有读取权限与范围由五个已存在的客户API分别检查，当前源/接口已重新读取核对；其下游标准依赖由现有公开预检/CTS读取器做完整封闭证明。

公开MCP工具read_configuration_bc_before_state以完整预检和CTS公开读取器分别前后夹住两次新原生调用，再做身份/版本/计数/规范Base64/长度/摘要核验。成功后服务端保存带源/布局/身份绑定的不可变本地包，文件先fsync再以不覆盖的原子硬链接发布；返回beforeStateReference，不能导入用户包。已有回执保护仍由WriteOperationReceiptStore负责，不建立另一套执行锁。前态证据不是加锁事务快照，也不授予执行或恢复许可；没有配置、CTS业务写、锁修改、提交、模拟、GUI或日志保存调用。

## 拟议真实验收预算

创建/激活仅本客户对象；新固定独立构建执行2次公开正例（每次2个STATE原生调用），4个STATE输入拒绝（错BCSet、版本、任务或非法版本摘要，其他输出应为空），4个公开schema拒绝（后台调用应为0）。必要的现有预检/CTS/源与字典读取仍只读；核对十九键presence、当前版本与CTS稳定、缺失行/原生F和日期序列化往返、完整本地证据重读以及全部false执行标志。首次异常停止并保留回执，不盲重试；没有配置改值/BCSet模拟/激活、配置CTS追加/清理/恢复、请求释放预算。

已有AI测试授权沿用；本审阅仅申请本客户对象部署及上述只读验收。通用RFC STRING执行契约缺口不绕过：使用本次固定且完整审阅的专用只读适配器；不开放通用RFC、修改共享服务或更换现有只读实例。新构建的手动登录仅在需要时单独安排，口令不得跨进程复制。

## 后续依赖

标准激活主线仍未完成。SCDC_GET_WORKPLACE的49行以后可进行远端RFC，73/138/171行还可UPDATE SCDTSYNC；SCTM_FRAME结束→LOCAL_START条件性DB_COMMIT/WAIT/分发；协议写SCPR_ACTIV_PROTOCOL_WRITE在独立R/3*连接提交。当前APPLY/RECOVER只完成本地请求和保守对账契约，尚没有真实执行桥。须分别证明或明确接管这些副作用，不能按NO_COMMIT宣称整体回滚，也不把同值回读当历史未写证明。真实非空字符串CTS键、权限/并发/ABA、独立提交、断电/超时和恢复仍待逐项验证。
