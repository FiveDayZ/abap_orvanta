# r67 公开只读时限与 KNM 配置闭环准备

2026-10-06T22:12:43.760+08:00，Asia/Shanghai。依据任务文档 CFG04 和本次实际回执主动规划；开发、测试、SAP 业务写入及发布分别受原授权边界约束。

## 当前已完成与未完成

r66 六对象已激活、限定只读运行通过；433 BC 回归及 16 私有部署保护检查通过。前態引用 c73130af1434697327f6c601a7f1bf2870dde52bf1c6f686b43dd89bd1dccb95；effects 引用 456fa5b39b3e2fe04968e76d202a8429428d6e02c71ac5592e5eef69d91ef867。完整 SPRO 尚未完成；本阶段没有任何 APPLY/RECOVER 或配置 CTS 写入。本计划替代旧 r67 计划的“先激活两个 Include”待办，该项已结束，旧文档保留。

## 下一阶段目标与最小交付

先解决实际公开 STATE/EFFECTS 的执行时限：attempt30 全只读流程 585.355 秒、3948 次只读调用；调用分布 {"RFC_READ_TABLE":3840,"Z_ORVANTA_CFG_BC_READ":64,"Z_ORVANTA_CFG_BC_ROUTE":24,"Z_ORVANTA_CFG_BC_GUARD":8,"Z_ORVANTA_CFG_BC_PREVIEW":4,"Z_ORVANTA_CFG_BC_CTS":4,"Z_ORVANTA_CFG_BC_STATE":2,"Z_ORVANTA_CFG_BC_EFFECTS":1,"Z_ORVANTA_CFG_BC_RECONCILE":1}。交付一次针对该真实调用链的最小性能修改或有证据的不修改结论，以及范围内运行时度量、真实漂移和请求中断的拒绝回归。定位阶段先读各 preflight/source attestation 调用方；只能在同一个证明阶段合并相同确定性读取，仍需保留前后独立读取、SAP 锁内重读和所有版本绑定。不得用永久缓存、放宽指纹或假成功消除超时。此前 T006 元数据 miss 猜测经实际探针否定，未实施该猜测修改。

随后冻结标准写链与已部署客户源，形成 KNM 十行新增→逐字段读回→恢复为缺行→精确新增 CTS delta 对账方案。最小交付是完整实际值、九保护键、effects/完整 CTS、源与布局指纹、阶段化 commit/失败处理/接管清单和具体可审阅操作预算，不在本计划中执行业务写。

## 验收条件

公开接口必须在明确文档化且实际验证的请求时限内完成；若普通客户端时限内尚不能完成，保持 Partially Verified 并说明所需时限。性能修改的测试必须检出真正源/目标/元数据/任务漂移、缺权限、单侧失败、取消后仍派发与假复用快照，不仅检查调用次数。共享 4849 和其他开发改动保留，私有固定编译用于隔离验收；无需 GUI。

写闭环阶段需在用户批准完整实际值后才执行最多一次 APPLY 和一次仅针对已知完成 APPLY 回执的 RECOVER。验收十行完整 after，九保护键原值/原缺失状态，正式 protocol/headers/variables/links 的实际变化与允许保留的历史，以及两完整传输根其他条目原样。未知结果只读 RECONCILE，不重放原命令；不得把对账观察转换为新的恢复权限。429/430 保持开放，不释放。

## 实际候选值与保护范围

下列值来自 SAP 类型化预览；其版本绑定在最终 STATE 的两轮新鲜 preflight 中被实际再次校验。观察时间 2026-10-06T11:48:54.837Z，不是后续写入时的锁内快照。所有空字段均明确保留在完整值中，不能以“省略”解释为删除或默认。

|表|键|拟新增完整字段|
|---|---|---|
|T006|{"MANDT":"200","MSEHI":"KNM"}|{"MANDT":"200","MSEHI":"KNM","KZEX3":"X","KZEX6":"X","ANDEC":"0","KZKEH":"X","KZWOB":"","KZ1EH":"","KZ2EH":"","DIMID":"PRESS","ZAEHL":"1000","NENNR":"1","EXP10":"0","ADDKO":"0.000000","EXPON":"0","DECAN":"3","ISOCODE":"KPA","PRIMARY":"","TEMP_VALUE":"0","TEMP_UNIT":"","FAMUNIT":"","PRESS_VAL":"0","PRESS_UNIT":""}|
|T006A|{"MANDT":"200","SPRAS":"1","MSEHI":"KNM"}|{"MANDT":"200","SPRAS":"1","MSEHI":"KNM","MSEH3":"KNM","MSEH6":"kN/m2","MSEHT":"kN/m2","MSEHL":"每平方米千牛顿"}|
|T006A|{"MANDT":"200","SPRAS":"D","MSEHI":"KNM"}|{"MANDT":"200","SPRAS":"D","MSEHI":"KNM","MSEH3":"KNM","MSEH6":"kN/m2","MSEHT":"kN/m2","MSEHL":"Kilonewton pro Quadratmeter"}|
|T006A|{"MANDT":"200","SPRAS":"E","MSEHI":"KNM"}|{"MANDT":"200","SPRAS":"E","MSEHI":"KNM","MSEH3":"KNM","MSEH6":"kN/m2","MSEHT":"kN/m2","MSEHL":"Kilonewton per square meter"}|
|T006B|{"MANDT":"200","SPRAS":"1","MSEH3":"KNM"}|{"MANDT":"200","SPRAS":"1","MSEH3":"KNM","MSEHI":"KNM"}|
|T006B|{"MANDT":"200","SPRAS":"D","MSEH3":"KNM"}|{"MANDT":"200","SPRAS":"D","MSEH3":"KNM","MSEHI":"KNM"}|
|T006B|{"MANDT":"200","SPRAS":"E","MSEH3":"KNM"}|{"MANDT":"200","SPRAS":"E","MSEH3":"KNM","MSEHI":"KNM"}|
|T006C|{"MANDT":"200","SPRAS":"1","MSEH6":"kN/m2"}|{"MANDT":"200","SPRAS":"1","MSEH6":"kN/m2","MSEHI":"KNM"}|
|T006C|{"MANDT":"200","SPRAS":"D","MSEH6":"kN/m2"}|{"MANDT":"200","SPRAS":"D","MSEH6":"kN/m2","MSEHI":"KNM"}|
|T006C|{"MANDT":"200","SPRAS":"E","MSEH6":"kN/m2"}|{"MANDT":"200","SPRAS":"E","MSEH6":"kN/m2","MSEHI":"KNM"}|

|保护表|键|状态|完整实际字段|
|---|---|---|---|
|T006D|{"MANDT":"200","DIMID":"PRESS"}|present|{"MANDT":"200","DIMID":"PRESS","LENG":"-1","MASS":"1","TIMEX":"-2","ECURR":"0","TEMP":"0","MOLQU":"0","LIGHT":"0","MSSIE":"PA","TEMP_DEP":"","PRESS_DEP":""}|
|T006I|{"CLIENT":"200","ISOCODE":"KPA"}|present|{"CLIENT":"200","ISOCODE":"KPA"}|
|T006J|{"CLIENT":"200","LANGU":"1","ISOCODE":"KPA"}|present|{"CLIENT":"200","LANGU":"1","ISOCODE":"KPA","ISOTXT":"千帕"}|
|T006J|{"CLIENT":"200","LANGU":"D","ISOCODE":"KPA"}|present|{"CLIENT":"200","LANGU":"D","ISOCODE":"KPA","ISOTXT":"Kilopascal"}|
|T006J|{"CLIENT":"200","LANGU":"E","ISOCODE":"KPA"}|present|{"CLIENT":"200","LANGU":"E","ISOCODE":"KPA","ISOTXT":"Kilopascal"}|
|T006T|{"MANDT":"200","SPRAS":"1","DIMID":"PRESS"}|present|{"MANDT":"200","SPRAS":"1","DIMID":"PRESS","TXDIM":"压力"}|
|T006T|{"MANDT":"200","SPRAS":"D","DIMID":"PRESS"}|present|{"MANDT":"200","SPRAS":"D","DIMID":"PRESS","TXDIM":"Druck"}|
|T006T|{"MANDT":"200","SPRAS":"E","DIMID":"PRESS"}|present|{"MANDT":"200","SPRAS":"E","DIMID":"PRESS","TXDIM":"Pressure"}|
|T006_OIB|{"MANDT":"200","MSEHI":"KNM"}|missing|null|

[完整值、buffer、layouts、CTS 和 effects](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-native-pilot-values-20261006-221243-r67.json)。十九键中八行存在、十一键缺失；九保护键含八行存在和一个缺失键，不修改共享 PRESS 维度、KPA ISO 行及语言文本，不创造 T006_OIB 行。

## 依赖、具体授权与后续

性能改动限本地 MCP 且已获本任务测试授权的范围；若需改变客户 SAP 源，先形成精确对象/全源差异再确认。真正 KNM 业务命令必须另获十行配置新增、恢复缺行、配置任务录制与精确 delta 清理、正式激活 effects 及历史协议保留的具体批准；本次六客户对象部署许可不覆盖这些业务作用。之后重读开放任务、实际业务值、对象源/布局和锁，无漂移才派发。当前独立临时登录已退出，真实运行需要新的阶段登录；不为纯本地准备索取口令。

完成 CFG04 该闭环后再推进 CFG07：从实际增强配置动作逐一确认无对话 API、状态机及传输/恢复契约；CFG08 按任务文档选一有可靠 API 和明确组织/键/有效期规则的业务域形成完整方案，真实业务触发由业务方确认。CFG01/05、KG 文本、客户号码范围及只读跨系统比较的历史结果按各自范围保留，不将其视为全部 SPRO 或迁移能力验收。
