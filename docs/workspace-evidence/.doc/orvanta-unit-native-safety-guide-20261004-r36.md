# r36 计量单位 native 锁内旧版本拒绝验收驱动

## 状态、边界与入口

- 时间：2026-10-04T13:43:02+08:00，Asia/Shanghai。实现完成；真实 native 拒绝尚未执行，不能把本地测试解释为 SAP stale/并发/rollback 已通过。
- src/configuration-unit-native-safety.ts 是内部验收驱动，不注册公共 MCP 工具，不改变正常 apply/preview/reconcile 契约。scripts/probe-unit-native-stale.mjs 默认只读准备；CLI 不接受任何执行参数，也没有 native 执行路径。
- 使用既有 Node、Zod、MCP SDK、WriteOperationReceiptStore；没有新增依赖。CLI 在项目按现有流程构建后执行：node scripts/probe-unit-native-stale.mjs。可用 ABAP_MCP_ENDPOINT 指定无凭据的 http://127.0.0.1:<port>/mcp；拒绝其他主机、协议、用户信息、query/hash 或路径。不在此脚本收集口令。
- prepareNativeUnitStale(raw, readers) 和 runApprovedNativeUnitStale(plan, grant, readers, backend, receipts) 分开。后一函数只能由具备人类具体授权的独立验收调用方使用；grant 对象是调用约束，不代替聊天中的人类授权。

## 严格输入与准备

仅接收 connectionId=w200、unitKey=KG、language=ZH、requestNumber=GR2K923429、taskNumber=GR2K923430，以及前缀 unit-native-stale- 的唯一 operationId（后缀 1—40 字符）。额外字段、其他单位/语言/系统/容器、patch、execute 或任意表名均在读取前拒绝。

准备按序读取：writer active definition→native 全行 unit→CTS→可选三次获准定向锁→native 全行 unit→writer definition。writer 正文/接口必须与具名部署候选一致；unit 必须带 READ 的 SAP-origin 完整行版本、限定体指纹/布局、值复核和正确 client/SAP language/key；独立按固定宽度检查 full-row version。CTS 必须具有完整 12 项 true 检查、正确容器、client/语言、未截断的专用投影。两个版本/读指纹或 writer 源接口变化即拒绝。

锁只复用当前 WYS/client200 的 T006、429、430 参数过滤读；未提供、不可用、截断或观察到锁会阻断 native dispatch。即使读到零，也不证明系统整体无竞争。准备可报告锁不可用，不伪装为授权或空锁。

## 唯一未来 native 命令

从可信 current row 派生参数：IV_UNIT_KEY=KG、IV_LANGUAGE=1、IV_REQUEST=GR2K923429、IV_TASK=GR2K923430；IV_SET_MSEHT/IV_MSEHT 都为空；IV_SET_MSEHL=X、IV_MSEHL 等于原生新鲜读值。IV_EXPECTED_VERSION 只替换正确 64 字符版本的首个字符（0→1，其他→0），必定与原版本不同。保留描述原值；当前活动源码即使意外忽略 stale 校验，也应在 NO_CHANGES 分支先于 CTS 追加/UPDATE_T006A 退出。不能据此跳过执行授权或真实副作用读回。

grant 严格限定 scenario=native_locked_stale_version、planFingerprint、acknowledgeOneNativeCall=true。计划核心全文 SHA256、输入参数和 operationId 必须匹配；计划最多 5 分钟有效，禁止未来时间；调用前重新读取全部前置条件，禁止拿历史夹具或旧计划代替实时 SAP 读回。

正式调用前 reserve 独占本地回执/目标锁，记录 prechange 行版本/读指纹/容器，再持久化 sapInvocationStarted。持久化失败、重复 operationId、目标忙或计划/锁前置条件不符，native 调用为零。命令固定为 Z_ORVANTA_CFG_UNIT_APPLY，一次；没有 retry、restore、CTS 清理/释放、锁删除或 GUI 回调。

只有 TEXT_VERSION_CHANGED、GR2/200/WYS、EV_COMMITTED/版本/task/tabkey 均空、ES_TEXT 清空且无 fault 的回执，才可进入原生拒绝观察。APPLIED、NO_CHANGES、其他拒绝、范围/字段矛盾、传输错误或响应丢失均不作为该样本通过。尽可能再只读核对完整行、CTS 投影、源接口和锁；原始首错 hash 保留，后续读失败不覆盖它。

## 结果、回执与限制

- native_stale_rejection_verified：所需 native 拒绝回执及读后观察一致。本轮只在本地 callback/真实 loopback MCP 夹具中覆盖，未在 SAP 执行。
- unknown：响应异常、原生结果不同、行/CTS/source 变化或读后观察缺失。即使现值与旧行相同也不擦除原未知；本地回执保持 failed/outcomeMayBeUnknown=true（若 SAP 已可能调用）。
- 前置持久化失败且 native 未开始，sapInvocationStarted=false/outcomeMayBeUnknown=false；这不声称 SAP 原生 rollback 已验证。
- probe_configuration_unit_native_stale 是独立回执身份，不能冒充 apply_configuration_unit_text 回执调用 r35 对账。driver 直接复用只读行/CTS/锁观察；r35 继续用于原 apply 的原始输入/旧行绑定。
- CTS 仅有界裁剪投影，非 raw TABKEY、通配录制、导入或整体事务证明。真实并发、API/CTS 故障、权限变体、其他单位/语言及共享部署均另行验收。

## native 故障验收矩阵（均未执行）

| 条件 | 当前激活源码依据 | 最小运行证据与依赖 |
| --- | --- | --- |
| 锁内旧版本 | TEXT_VERSION_CHANGED 位于完整行重读后、NO_CHANGES/API/CTS 之前 | 新鲜 native 行、一次受限回执、前后行/CTS/源/获准锁；需要具体 native 调用授权 |
| 已释放/不适用容器 | CTS_CONTAINER_INVALID 在维护 API 之前；r32 Workbench 拒绝已有证据 | 只读选择已存在安全容器，禁止为测试释放429/430；没有具体候选则待准备 |
| 权限拒绝 | S_TABU_DIS 在锁/维护之前 | 获准受限测试账号与真实授权失败；不改现有账号权限制造故障 |
| 锁/并发冲突 | ENQUEUE_E_TABLE / E_TRKORR，锁内旧版本比较 | 单独批准的竞争者/测试范围；本轮读到零不是并发证据 |
| CTS对象/键/追加错误 | CTS_OBJECT_CHECK_FAILED / CTS_KEY_CHECK_FAILED / CTS_APPEND_FAILED / CTS_RECORDING_NOT_OBSERVED | 真实可控安全条件、首根因、值/CTS/锁残留；不破坏正常请求或扩展故障开关 |
| 同步更新/读回错误 | UPDATE_T006A 同步调用，TEXT_UPDATE_FAILED / TEXT_READBACK_FAILED；提交前 ROLLBACK WORK | 获准可控测试键/条件和实际 DB/CTS 读回；源码或 mock 不证明完整 rollback |
| 提交/通信不明 | COMMIT_UNCERTAIN 或响应丢失 | 保留未知回执，独立只读对账；无自动重试/恢复 |

## 本轮实际 SAP 只读观察

激活 writer 和六个依赖源/接口与 r31 基线相同。共享服务仍未提供 includeApiSnapshot schema，实际准备器返回 NATIVE_SAFETY_NATIVE_READER_SCHEMA_UNAVAILABLE，在执行任何 native 命令前阻断。另通过现有只读路线观察429/430 metadata_matches、三项 WYS/client200 锁均0/hasMore=false，KG/ZH 七字段投影与 r35 相同，MSEHL=千克；本轮没有新 native 全行版本，不能用投影自行生成版本绕过门槛。
