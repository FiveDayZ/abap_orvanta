# r47 固定 CUNI/T 只读元数据桥接部署申请

编制：2026-10-05T08:18:55.934+08:00（Asia/Shanghai）。对象、源和接口均为待审批候选；本文件不是部署回执。

## 已完成准备与必要性

r46 修正版已在原冻结独立实例实际验收：两次公开预览均返回 11 行/10 个拟新增键，PRESS 原值不变；1-/2-/1.000/小数/零 FLTP 的转换及完整前后读回通过；4 项 schema 拒绝、过期目标拒绝和 2 项原生空输出拒绝通过。具名回执为 orvanta-configuration-bc-preview-acceptance-20261005-r46.json。

当前需取得 CUNI 真实后导入方法和完整成员。实读 MUNITF03（312/312 行）确认 objecttype=T、objectname=CUNI 及 TDAT CUNI；RDDSOBJI（136/136 行）确认 AFTER_IMP/BEFORE_EXP 和 import/transport 常量；OBJH/OBJS/OBJM 活动 DDIC 已读取。CTO_OBJECT_GET 等实际 non-RFC，CTO_ORDER_GET_METHOD_CALLS 还包含 ENH_UNSET_GENERATED 条件写分支，不作为只读探针。现有通用查询未开放这些元数据表，不扩大或绕过该入口。

## 具体申请

- 系统 w200 / GR2 / client 200，用户 WYS。
- 仅创建远程只读客户 RFC **Z_ORVANTA_CFG_BC_ROUTE**，父组 **ZORVANTA_BC_CFG**，包 **ZABAP**，已有 Workbench 请求 **GR2K923472** / 任务 **GR2K923492**。创建前重新核对任务/草稿，保存完整、不可变的组/既有函数备份；不创建或释放请求。
- 源候选 175 行，全部不超过 72 字符；来源 SHA-256 4f7da09edb86c3aa61fb06fc0f669f4afecca0777b409399aca8110f861af8c1。见 [候选 ABAP 源](./orvanta-configuration-bc-route-candidate-20261005-r47.abap) 与 [完整接口候选](./orvanta-configuration-bc-route-candidate-20261005-r47.json)。
- 四个 STRING 导入：IV_BC_SET/IV_VERSION/IV_SOURCE_VERSION/IV_TARGET_VERSION；七个 STRING 导出：状态、系统/client/user、两版本和 EV_METADATA_VERSION；三个 TABLES：ET_OBJH/OBJH、ET_OBJS/OBJS、ET_OBJM/OBJM。不是任意对象、任意表或方法调用接口。
- 精确限制 EHS_CUNI_KNM/N 与 CUNI/T；逐表显示授权；完整成员上限 20、方法上限 10，超过上限或读取/版本/元数据变化返回空表与空版本；不返回维护用户名和日期。复用获准 READ 三次核对完整五表原生源/目标，原生双读元数据后 SHA-256，输出只在全部校验通过时填充。
- 创建后仅执行当前明确范围的技术只读验收：scope/source/version/权限拒绝、公开 schema、两次完整 CUNI 元数据读与方法源回读、五表前后比对。授权不包含激活方法或业务配置写。

## 本地实现与验证

已实现 **inspect_configuration_bc_route** 的真实 MCP contract、注册、service 适配与源/目标双版本保护。核对三张 DDIC 定义、两份常量/传输源和客户桥接定义；元数据两次调用后，读取所返回方法源的指纹再复核，任何漂移不返回可用结果。展示完整成员、额外成员、导入/传输标识；activationAvailable/executable/methodExecutionAvailable 始终 false。标准激活依赖、后导入依赖、CTS 和恢复仍是待完成工作，源码身份不能代替这些证明。

类型检查与隔离编译、格式及 source-only headless 检查通过；相关回归 **597/597**。初次隔离登记检查 3 项因历史证据文件未复制失败，已保留日志并复制 157 个真实引用文件后通过，没有更改断言或登记结论。工具索引 **196 工具 / 127 只读** 一致，ops matrix 一致；新工具仍为 unverified。未改变共享服务/default dist 或原五个暂存文件。

## 授权边界

本申请仅为新增客户只读源对象及其验收。没有 BC Set activation/simulation、动态后导入方法执行、KNM/别名/PRESS 改值、配置 CTS 录制、号码范围命令、传输释放或发布。

项目 [AGENTS.md](../AGENTS.md) 第 6 节要求："Modify only an explicitly approved Z* or Y* customer object in the current task." 该对象当前确证不存在；r46 对 READ/PREVIEW 的批准不包含它，因此须对这个具体新对象取得批准。现有开发和 AI 技术测试授权持续，不重复确认。
