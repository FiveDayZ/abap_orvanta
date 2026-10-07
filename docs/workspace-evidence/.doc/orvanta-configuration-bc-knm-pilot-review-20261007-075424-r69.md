# r69 KNM 十行新增、恢复与 CTS 精确对账审阅包

2026-10-07T07:54:24.455+08:00，Asia/Shanghai。**待具体业务授权，本文件不是执行批准。** 已批准的六个客户对象部署与只读验收已经完成，不需要再次批准同一代码部署。本次申请仅以下 KNM 业务闭环；未扩大到其他 SPRO 活动。

## 操作对象、值和预算

w200 / GR2 / client 200 / WYS，BC Set EHS_CUNI_KNM / N。配置请求 GR2K923429、任务 GR2K923430，最多 **一次 APPLY 与一次 RECOVER**；拒绝、未知结果或恢复失败不追加写预算。请求和任务不释放。原开发请求 GR2K923472 / 492 不用于配置录制。

十行拟新增的完整字段如下。空值属于完整实际值，不能省略或替换默认值。字段来自 r66 SAP 类型化预览，r67 在 2026-10-06T23:42:21.116Z 完成的全新 STATE 重校验候选与全前态引用一致；这不是执行时的锁内快照。[完整原始值、十九键、layouts、buffer 和 CTS/effects](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-knm-pilot-values-20261007-075424-r69.json)。

|表|键|拟操作|完整拟新增字段|
|---|---|---|---|
|T006|{"MANDT":"200","MSEHI":"KNM"}|create|{"MANDT":"200","MSEHI":"KNM","KZEX3":"X","KZEX6":"X","ANDEC":"0","KZKEH":"X","KZWOB":"","KZ1EH":"","KZ2EH":"","DIMID":"PRESS","ZAEHL":"1000","NENNR":"1","EXP10":"0","ADDKO":"0.000000","EXPON":"0","DECAN":"3","ISOCODE":"KPA","PRIMARY":"","TEMP_VALUE":"0","TEMP_UNIT":"","FAMUNIT":"","PRESS_VAL":"0","PRESS_UNIT":""}|
|T006A|{"MANDT":"200","SPRAS":"1","MSEHI":"KNM"}|create|{"MANDT":"200","SPRAS":"1","MSEHI":"KNM","MSEH3":"KNM","MSEH6":"kN/m2","MSEHT":"kN/m2","MSEHL":"每平方米千牛顿"}|
|T006A|{"MANDT":"200","SPRAS":"D","MSEHI":"KNM"}|create|{"MANDT":"200","SPRAS":"D","MSEHI":"KNM","MSEH3":"KNM","MSEH6":"kN/m2","MSEHT":"kN/m2","MSEHL":"Kilonewton pro Quadratmeter"}|
|T006A|{"MANDT":"200","SPRAS":"E","MSEHI":"KNM"}|create|{"MANDT":"200","SPRAS":"E","MSEHI":"KNM","MSEH3":"KNM","MSEH6":"kN/m2","MSEHT":"kN/m2","MSEHL":"Kilonewton per square meter"}|
|T006B|{"MANDT":"200","SPRAS":"1","MSEH3":"KNM"}|create|{"MANDT":"200","SPRAS":"1","MSEH3":"KNM","MSEHI":"KNM"}|
|T006B|{"MANDT":"200","SPRAS":"D","MSEH3":"KNM"}|create|{"MANDT":"200","SPRAS":"D","MSEH3":"KNM","MSEHI":"KNM"}|
|T006B|{"MANDT":"200","SPRAS":"E","MSEH3":"KNM"}|create|{"MANDT":"200","SPRAS":"E","MSEH3":"KNM","MSEHI":"KNM"}|
|T006C|{"MANDT":"200","SPRAS":"1","MSEH6":"kN/m2"}|create|{"MANDT":"200","SPRAS":"1","MSEH6":"kN/m2","MSEHI":"KNM"}|
|T006C|{"MANDT":"200","SPRAS":"D","MSEH6":"kN/m2"}|create|{"MANDT":"200","SPRAS":"D","MSEH6":"kN/m2","MSEHI":"KNM"}|
|T006C|{"MANDT":"200","SPRAS":"E","MSEH6":"kN/m2"}|create|{"MANDT":"200","SPRAS":"E","MSEH6":"kN/m2","MSEHI":"KNM"}|

## 九个保护键

以下八行存在、一键缺失；全部保持完整原值或原缺失状态。T006_OIB 的 KNM 行不创建。共享 PRESS 维度、KPA ISO 及其语言文本不修改。

|表|键|当前状态|完整保护字段|
|---|---|---|---|
|T006D|{"MANDT":"200","DIMID":"PRESS"}|present|{"MANDT":"200","DIMID":"PRESS","LENG":"-1","MASS":"1","TIMEX":"-2","ECURR":"0","TEMP":"0","MOLQU":"0","LIGHT":"0","MSSIE":"PA","TEMP_DEP":"","PRESS_DEP":""}|
|T006I|{"CLIENT":"200","ISOCODE":"KPA"}|present|undefined|
|T006J|{"CLIENT":"200","LANGU":"1","ISOCODE":"KPA"}|present|undefined|
|T006J|{"CLIENT":"200","LANGU":"D","ISOCODE":"KPA"}|present|undefined|
|T006J|{"CLIENT":"200","LANGU":"E","ISOCODE":"KPA"}|present|undefined|
|T006T|{"MANDT":"200","SPRAS":"1","DIMID":"PRESS"}|present|undefined|
|T006T|{"MANDT":"200","SPRAS":"D","DIMID":"PRESS"}|present|undefined|
|T006T|{"MANDT":"200","SPRAS":"E","DIMID":"PRESS"}|present|undefined|
|T006_OIB|{"MANDT":"200","MSEHI":"KNM"}|present|undefined|

当前十九键中八行存在、十一键缺失。前态引用 c73130af1434697327f6c601a7f1bf2870dde52bf1c6f686b43dd89bd1dccb95；effects 引用 456fa5b39b3e2fe04968e76d202a8429428d6e02c71ac5592e5eef69d91ef867；CTS 版本 7592fcc1736c5b6856f7c702fbf1bcca3c3ff372f71761fdc6fd4ff7ebe63b50。原始九表完整行、两 CTS 根与 opaque buffers 均在上面的 JSON 中，不把只读引用当作写入或恢复许可。

## 标准 API 和持久副作用

客户所有者使用已部署的 Z_ORVANTA_CFG_BC_APPLY / RECOVER，逐表通过 SCPR_PRSET_CT_ONE_TABLE_LOAD 准备完整十行，标准 BC 记录内核保存。标准 TR_REQ_CHECK_OBJECT/KEY 与 TRINT_APPEND_TO_COMM_ARRAYS 复用任务 430 现有 R3TR/TDAT/CUNI（OBJFUNC K），追加十个精确 R3TR/TABU E071K 键。RECOVER 仅对已知完成 APPLY 生成的十键 delta 调用 TRINT_DELETE_COMM_KEYS；不删除或改写其他 CTS 对象/键。

正式 effects 由 SCPR_HI_ACTLINKS_UPDATE 产生，预期 SCPRACTR matched/records 各十条、SCPRACTP header 一条；SCPRACTX variables 和 SCPRACTXL links 均为零。这是部署代码的待验收预期，尚无真实 APPLY 结果。恢复通过 SCPR_HI_ACTLINKS_DELETE_UPD 清除本次正式 effects，五种计数返回当前零值；第三方记录受完整前态保护。**header 表是 SCPRACTP，独立协议历史表是 SCPRACPP，两者不同。**

SCPR_ACTIV_PROTOCOL_WRITE 在 R/3* 连接写入 SCPRACPP 开始/完成/异常阶段历史；GUID_CREATE 生成 ACT_ID，系统、客户端、操作者和时间由 SAP 派生。APPLY/RECOVER 历史允许保留，异常前置阶段可能也留下未完成历史，不能以配置回滚推断历史未写。operation/frame 的 CHAR80 标记使用各 32 个十六进制字符，完整本地哈希另存回执。

## 锁、并发与提交边界

使用固定 BC Set 锁、两 CTS 容器锁以及 ENQUEUE_E_TABLE 的 **25 张整表锁（空 VARKEY）**：T006、T006A、T006B、T006C、T006D、T006I、T006J、T006T、T006_OIB、SCPRACTR、SCPRACTP、SCPRACTX、SCPRACTXL、SCPRATTR、SCPRRECA、SCPRVALS、SCPRVALL、SCPRPPRL、OBJH、OBJS、OBJM、T000、TBD05、TBD72、SCDTSYNC。已有相关锁时立即拒绝；不等待、不抢锁、不解除其他人的锁，仅释放本次持有锁。整表锁会短暂影响这些表的并行维护，执行前必须核对活跃维护与当前锁，避免和其他开发冲突。共享 4849 不重启、不覆盖 shared dist。

APPLY 在锁内重新核对版本、权限、十九键、正式 effects、完整 CTS、维护/分发条件；全部通过后才一次 COMMIT WORK AND WAIT。提交前错误按原生契约回滚配置 LUW，独立协议历史可以保留。

RECOVER 必须持有已知完成 APPLY 的本地回执与原生 frame，核对完整 after/effects/CTS 后恢复十行至缺失并提交；随后标准 CTS 清理 API 存在内部 DB_COMMIT，**整个恢复不能宣称单次原子回滚**。CTS 清理失败需保留真实阶段和 delta，不允许扩大清理或无证据重试。现有 ALE/分发条件（TBD05、TBD72、SCDTSYNC）不满足固定路线时拒绝，不绕过。

## 执行与验收顺序

1. 冻结构建、再次核对已部署客户源码/接口/布局、开放请求任务、WYS 权限和相关锁。全新十九键、effects 与完整 CTS 必须仍与该审批值一致；漂移即停止写入。
2. 在明确文档化的请求时限内先执行只读预检。r67 STATE 实测 75.574 秒，尚未达到 SDK 默认 60 秒，本闭环必须使用明确延长且经验证的隔离客户端时限；不削弱前后证据。r68 取消逻辑仍需固定版本的真实只读检查。
3. 最多一次 APPLY；逐字段核对十行 after、九保护键、十个新增 CTS 键及正式 effects，记录真实 commit/locks/protocol/frame。
4. 仅当 APPLY 已知完成且完整证据一致时最多一次 RECOVER；核对十行恢复缺失、九保护键不变、完整 CTS 除允许更新时间外回到原基线、正式 effects 回零，协议历史保留及本次锁释放。
5. 任一命令结果未知只执行只读 RECONCILE 并保留回执/历史；不重放、不更换 operationId 绕过、不把观察自动转成恢复许可。运行失败记录原始 SAP 错误/转储，按实际阶段接管。两次写预算不因失败增加。

验收不是仅看 EV_CODE：完整持久行、保护键、正式 effects、历史、两 CTS 根和锁均须证明。失败后十行可能残留，恢复可能仅完成配置而 CTS 清理未完成；上述风险必须保留在回执并人工审阅。

## 授权依据与仍不包含的工作

[项目 AGENTS.md](C:/My/Workplace/Coding/vscode-abap/AGENTS.md) 第 10 节要求 “Do not write business data merely to test unless the user explicitly authorizes it”；第 1.1 节明确测试授权不替代数据写入、清理和传输授权。因此已有测试与客户代码部署许可不包含该十行新增/恢复、配置 CTS delta 清理及正式 effects/独立历史写入，需要对此完整审阅包一次具体批准。

本次不修改 SAP 标准对象或新客户源，不操作号码范围、不发布外部版本、不释放请求。实现仍为 API-only；完成该样本也不能代表任意 IMG 活动通用写入。[后续实施计划](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-followup-plan-20261007-075424-r69.md)。
