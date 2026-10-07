# MCP 完整实施 SPRO 能力复盘（r67）

2026-10-07T07:35:13.104+08:00，Asia/Shanghai。结论：**当前不具备完整实施 SPRO 的能力**。本次复盘依据当前源码、2026-10-07 实际 4849 tools/list、已有不可变 SAP 验收回执；未用构建或工具登记替代业务验收。

## 能力矩阵

|任务|已有实现和证据|仍缺失|
|---|---|---|
|CFG01 配置描述|限定对象的 DDIC/client/维护路线/传输语义与拒绝条件|不能覆盖任意组织配置对象或自动得到所有活动写 API|
|CFG02 计量单位文本|KG/中文 MSEHL 临时保存、逐字段读回、恢复及键级 CTS 历史验收|仅该字段/场景；原生并发、故障回滚、权限变体仍缺；不能推导 CUNI 整体可写|
|CFG03 号码范围|专用 ZORVCFGNR 定义和 01 区间标准 API 更新/无改值、旧版本拒绝、锁与当前号证据|专用对象限定；不能推广到在用业务号段、号分配/缩容/删除或所有号码对象|
|CFG04 BC Set|固定 EHS_CUNI_KNM 九表十九键；内容/路由/前态/effects 只读；六客户桥部署及无历史/缺回执拒绝有 r66 证据|十行 KNM 实际 APPLY→回读→RECOVER→精确 CTS delta 尚未执行；正式协议、links/header 效果及恢复待验收|
|CFG05 IMG 导航|活动/节点/标题/局部路径及维护对象来源读取；已有人工标题路径核对|节点识别与维护对象映射不是可执行配置路线，缺 API 的活动不得宣称支持|
|CFG06 跨系统比较|w200/200 与 w300/300 的限定配置只读漂移历史证据|不是同步/迁移；部分历史记录的最终构建未实测，依各原记录保留限制|
|CFG07 增强配置|现有只读审计与 prepare_enhancement_configuration_workflow|产品注册、关联、启停需逐动作标准 API、状态机、CTS、恢复和真实触发验收|
|CFG08 业务域|尚为按业务需求选择的领域扩展任务|定价/输出/批次序列等组织维度、键、有效期、依赖和实际业务效果未交付|

历史来源：[KG 保存/恢复](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261004-101525.md)；[号码范围限定验收](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261004-193336.md)；[IMG 直接读取](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261003-014859.md)；[跨系统比较及限制](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261003-094203.md)；[r66 六对象与只读验收](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261006-221243.md)。这些都是既有运行证据，本次未重复 SAP 写入。

## 当前服务与源码交付的区别

2026-10-07 通过实际 SDK 连接 4849 MCP 取得 189 个注册工具，服务报告 orvanta 0.50.23，连接配置列出 w200、w300。其中有计量单位文本 apply 和限定配置读取，但未注册 read_configuration_bc_before_state、apply_configuration_bc_set、recover_configuration_bc_set、reconcile_configuration_bc_execution，也未注册号码区间 apply 新工具。这些名称在当前 src/mcp.ts 存在、在私有实例有历史验收，不能作为当前共享服务已交付的证据。仅相同版本号不能判定代码相同。

当前 shared dist 保留原哈希 337048373194468491426bf1cffee332e970ca20eaf68d6000b1edcc0af51320；本次不重启共享服务、不重编译该 dist，不影响其他开发。后续服务切换需先准备可审阅交付包及 tools/list 前后证据；业务能力判定仍需实际配置闭环，不以工具数算完成率。

## 主要缺口与继续顺序

- P1：CFG04 实际写入/恢复/CTS 与正式 effects 未验收；须先完成精确实际值及未知结果接管方案，再按具体批准范围执行。
- P1：已部署新客户 API 尚未在常用共享服务注册；需要隔离验收后的服务交付步骤。
- P1：r66 整体只读耗时 585.355 秒、3840 次 RFC_READ_TABLE；普通客户端请求时限内可用性未证明。本次已继续开发请求内源投影复用，新 SAP 耗时仍待固定构建登录验收。
- P1：ATC endpoint 曾返回 HTTP404，未通过质量门；自动取消后所有后续读取派发停止的产品行为仍需单独验证，不能把私有 harness 停止保护当成产品能力。
- P2：CFG07/08 未完成；扩展必须逐域确认真实无对话 API 与语义。API-only，不能用 GUI 自动化或任意标准表 SQL 写充数。

任务文档本身以配置域逐步交付，没有定义任意 IMG 活动通用写接口。完成一个 KNM 样本也不能等同于所有 SPRO 活动已自动化。[下一阶段具体计划](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-followup-plan-20261007-073513-r68.md)。
