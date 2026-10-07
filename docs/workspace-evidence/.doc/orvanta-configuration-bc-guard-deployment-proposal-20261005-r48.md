# r48：CUNI 四表保护读取的具体部署申请

编制：2026-10-05T11:41:10.723+08:00（Asia/Shanghai）。状态：Partially Verified。本地实现与接口测试通过；以下 SAP 对象仍是未部署候选。

## 申请对象和范围

仅申请在 w200 / GR2 / client 200 创建远程、非 update-task 客户函数 **Z_ORVANTA_CFG_BC_GUARD**，加入现有函数组 ZORVANTA_BC_CFG、包 ZABAP，开发请求 GR2K923472 / 任务 GR2K923492。创建工具必要的自动生成 Include/函数组目录追加属于该函数创建；不手改生成 Include，不改现有 READ/PREVIEW/ROUTE 正文。新对象如果已存在或出现他人草稿，停止创建而不覆盖。

完整候选：[ABAP](orvanta-configuration-bc-guard-candidate-20261005-r48.abap)、[接口与键清单](orvanta-configuration-bc-guard-candidate-20261005-r48.json)。本地候选全文 SHA-256：dba13bdd232ea0aa8469e3312cf24b03423cebd52526c3790380646562c8fd52；规范化正文：3980ab1d4c5448d2dac9dd1072f64bf58e87c6520af8af1db1912abb58f46ca0。这些不是 SAP 实际源码/接口指纹。

5 个必填按值 STRING 输入：IV_BC_SET、IV_VERSION、IV_SOURCE_VERSION、IV_TARGET_VERSION、IV_METADATA_VERSION。8 个按值 STRING 输出：EV_CODE、EV_SYSTEM、EV_CLIENT、EV_USER、EV_SOURCE_VERSION、EV_TARGET_VERSION、EV_METADATA_VERSION、EV_GUARD_VERSION。4 个 DDIC 平面 TABLES：ET_T006I/T006I、ET_T006J/T006J、ET_T006T/T006T、ET_T006_OIB/T006_OIB；无 changing 或 declared exceptions。

固定 EHS_CUNI_KNM/N、w200/GR2/200：T006I 的 200/KPA 1 键；T006J 的 200/1,D,E/KPA 3 键；T006T 的 200/1,D,E/PRESS 3 键；T006_OIB 的 200/KNM 1 键。最多 8 键，读取完整字段。CLIENT/LANGU 与 MANDT/SPRAS 沿用实际 DDIC。不是 CUNI 全量读取。

## 真实准备证据与冲突保护

2026-10-05T03:35:06.417Z 已刷新现有三个客户函数的完整接口及 exact URI 全文，源码和接口指纹与 r47 一致。完整函数组主程序 14 行、TOP 3 行、UXX 10 行已读取；TADIR 实读包 ZABAP。E070 实读开发请求 K、任务 S，均状态 D、所有者 WYS，任务父请求 472。inactiveCheck 五个目标均 not_in_returned_list；只说明该次返回列表，不能称全系统无草稿。prepare_delivery 整体 partial/differences，因为请求包含其他开发对象；不清理这些对象，也不认为可释放。

四表真实定义及 CX_SY_OPEN_SQL_DB 完整 62 行已读取；普通 read_abap_table 白名单不扩大。新函数的 URI 查找 not-found/Authoritative=false 不是名称可用证明；实际创建须使用服务的存在性保护。对象级批准后，立即重读并保存完整 exact-URI 不可变备份与当前任务/非活动对象状态，再调用客户函数创建接口。

## 实现与本地验收

新增公开只读工具 read_configuration_bc_guard，严格 6 项输入，绑定 BC Set 来源、五表目标和 CUNI 元数据版本。拒绝参数扩展、其他系统/client/源、布局或正文漂移、重复或额外键、权限失败和采样漂移。原生双读后仅在全部检查成功时返回完整表；原生 SHA2 保护版本保留，不用 JS 重建数值/摘要。host 前后再核对路线、四表定义及函数接口/正文。缺行输出每个固定键 missing/null，不把无权限伪装成空结果。

39 项新增相关逻辑和真正 loopback MCP 测试通过；相关配置、服务、协议、能力及证据回归共 684 项通过。协议测试补齐四个实际已注册 BC 工具的显式清单，不删除断言。独立测试目录补入 5 个现有真实历史证据与 ops 矩阵。TypeScript、目标文件 Prettier、197 工具/128 只读工具索引、15 类 ops 矩阵和无 VS Code 依赖检查通过。新工具登记仍 unverified，未伪造 SAP 运行证据。

## 本次批准后的验收边界

部署并诊断该客户只读函数；冻结独立 host 构建；人工输入临时口令后，由 AI 执行固定 8 键只读验收。核对两次保护结果、缺失与完整字段、原生空版本拒绝、源码/布局/路线/五表前后同值。既有 AI 技术测试授权沿用，不再次要求测试授权。

不调用 BC Set 激活、模拟、后导入方法、配置保存、CTS 配置键录制、日志写入或恢复；不释放请求，不重启共享 4849，不使用 GUI。顺序双读不是锁定快照，真实拒绝权限/并发扰动不通过主动改用户权限或业务数据来制造。

## 下一阶段

见 [r49 验收计划](orvanta-configuration-bc-guard-acceptance-plan-20261005-r49.md)。八键真实只读验收后，将九表保护版本接入固定 BC Set 激活准备；激活/配置 CTS/恢复必须另外提出具体值、范围及预算。全部 SPRO 仍有 CFG-04 执行恢复、CFG-06 双方变化/失败、CFG-07 业务启用、CFG-08 明确业务域的验收缺口。
