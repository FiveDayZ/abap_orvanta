# r51 专用 CTS 只读桥接部署审阅

实际时间：2026-10-05T17:25:45+08:00（Asia/Shanghai）。状态：Partially Verified。完整实现候选、本地适配器和测试已完成；本阶段尚未创建、激活或调用此 SAP 客户对象。

## 准确对象与范围

候选对象仅 Z_ORVANTA_CFG_BC_CTS（FUNC / FUGR/FF），父组 ZORVANTA_BC_CFG；沿用既有包 ZABAP、Workbench GR2K923472 / 任务 GR2K923492。这些包/任务来自本工作区 r49 实际记录，部署前仍须重新确认 owner、开放状态、锁和组源版本。标准接口创建服务管理生成 Include 与 UXX 追加；不手工改 main/TOP/生成 Include，不变更既有 READ/PREVIEW/ROUTE/GUARD。对象特定部署授权尚未获得；用户对 KG 配置保存或整项目开发的授权不替代新对象授权。

具体配置容器读取仅 GR2K923429 / GR2K923430，BC Set EHS_CUNI_KNM/N，系统 GR2/client200；当前 SAP 用户必须拥有请求和任务。与开发对象录制请求472/492分开。配置请求不释放。

## 完整源码与接口

[完整 .abap 候选](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-cts-read-candidate-20261005-r51.abap)，共 175 行；文件 SHA-256 7e5ffe0eb7fb6db43d577e0846a63b1389c887337fd96fe65940c534d8c62192；正文规范化指纹 04a65da1a91fde644d5ae697641d71fb3e0b99f90811da108f074f7db3f6c5d4。API 声明及源码位于 src/configuration-bc-cts-api.ts；适配器 src/configuration-bc-cts.ts。没有占位分支。

远程启用、非 update task，无 CHANGING/TABLES/声明异常，所有参数按值 STRING。4 个必填输入：IV_BC_SET、IV_VERSION、IV_REQUEST、IV_TASK。请求/任务/BC Set/版本全部固定，不接受其他容器或任意表选择。12 个输出：EV_CODE、EV_SYSTEM、EV_CLIENT、EV_USER、EV_REQUEST、EV_TASK、EV_CTS_VERSION、EV_DATA_BASE64、EV_DATA_BYTES、EV_OBJECT_COUNT、EV_KEY_COUNT、EV_STRING_KEY_COUNT。EV_CODE=CTS_READ_OK 后才发布完整数据；其他路径只有错误代码，不发布部分缓冲或成功字段。

## 原生 CTS 前态与边界

TR_READ_REQUEST 内部调用已读取的 TRINT_READ_REQUEST，获取完整 E071/E071K/E071K_STR；标准 TR_AUTHORITY_CHECK_DISPLAY 执行显示权限检查。桥接还对五表检查 S_TABU_NAM/03。完整 E070/E070C 精确键读取补充标准 request header 未携带的 E070C extended_state/overtaker/tarclient 等属性。

两次顺序观察每次分别读取固定根请求和任务，检查 W/Q、D、CUST、当前用户、client200、父子、目标GR3及标准/直接头部一致。每容器每种对象/键表最多128行，字符串键与键长度串各最多4096字符；原生缓冲最多524288字节。计数前置检查加读取后检查不能构成锁内快照；并发增长/ABA及大值内存行为需实际验收。

EXPORT TO DATA BUFFER 序列化完整五表原生行，以及 system/client/user/BC Set/版本/请求/任务绑定，包含现有其他对象条目用于保留。字节保留固定键尾空格及字符串键，不把 SOAP 显示文本重新补空格当证据。CALCULATE_HASH_FOR_RAW 的 SHA2 摘要绑定实际缓冲，SCMS_BASE64_ENCODE_STR 只编码原始字节。适配器检查规范 Base64、精确长度、SHA256、用户/系统/范围、两次全部输出及前后独立源/接口/五表布局。该不透明缓冲不在客户端 IMPORT、不作为配置恢复命令或执行许可。

## 授权后的部署与验收

先从 SAP 重读准确对象、父组完整 Include 图、接口、源码、锁及472/492；候选名冲突时不覆盖。备份当前组/旧模块版本，采用专用创建 API，保存后重读、诊断及激活各依赖，检查生成源码只新增目标引用与 CTS 实际条目。随后仅运行同一候选只读查询：两次完整容器结果、原生缓冲哈希/字节、准确空格键/字符串键解码原生侧验证、owner/client/status/父子失配及权限拒绝；对照既有429/430头部和其他对象。新 API 尚不公开注册，真实接口验收后才开放受限 MCP 工具。

部署和只读验收不批准 BC Set 激活、模拟、配置保存、CTS追加/清理、恢复或传输释放。这些需要具体19键差异、锁/日志/分发副作用、执行预算和补偿清单。

## 实際来源与未关闭事项

[实际标准源及DDIC回执](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-cts-standard-source-20261005-r51.json)。5个CTS表已读取完整DDIC布局；TR_READ_REQUEST等源/接口身份与候选针脚逐项比较。本地新增断言防止误把聚合 definition fingerprint 当 interfaceFingerprint。CALCULATE_HASH_FOR_RAW沿用r50已通过的原生读前置身份，本次不冒称重新获取其完整源码。

TRWBO_REQUEST 是标准函数所用类型池类型，DDIC结构读取回答not-found；TYPE枚举/URI方式未获得类型池源码，仍需 SAP 编译与类型池依赖核验。桥接尚无 SAP 诊断/激活/实际 CTS 读回证据；本地合成字节测试不证明 ABAP EXPORT 序列化和真实填充键。

SCTM 的 LOCAL_START 全111行已读：条件分支含 DB_COMMIT、WAIT和SCDC_DISTRIBUTE_TABLE_KEYS，主激活结束调用不检查no_commit。因此继续审计分发登记/条件和SCDC调用，不承诺NO_COMMIT足以保证全局原子性；不调用该链。

新r51预检固定构建两次首次元数据请求均被SAP HTTP401拒绝，原生READ/PREVIEW/ROUTE/GUARD、数据查询及写入计数均0。已停止重试并关闭两实例；真实性能验收等待WYS登录问题确认，不归因于对象权限或源码错误。
