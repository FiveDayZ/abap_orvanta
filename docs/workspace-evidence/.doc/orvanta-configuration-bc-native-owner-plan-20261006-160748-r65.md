# r65：完整标准配置命令与恢复 owner

2026-10-06T16:07:48.376+08:00，Asia/Shanghai。承接[r64内核审阅](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-record-kernel-review-20261006-160748-r64.md)及原始SPRO backlog。现有本地开发/测试与只读 SAP 授权持续；API-only。

## 目标与最小交付

完成 EHS_CUNI_KNM/N、w200/GR2/200 的正式 APPLY、RECOVER、只读 RECONCILE 候选，调用已完成的十行内核，并接入既有不可变前态/effects与 WriteOperationReceiptStore。输出完整客户源、MCP接入、故障矩阵与精确部署/配置/CTS审阅包；不再追加一个独立只读桥来替代执行闭环。

## 实施次序

1. 外层锁：按真实 E_TABLE/E_TABLEE 的 RSTABLE 参数保护四张可写表及其余五表、BC Set和429/430；覆盖 SCPRACTR 全表/当前client的编号分配和相关profile owner。说明标准内部 scope3 dequeue 的影响，只释放本命令的锁。锁内 fresh 全部源、布局、target/candidate/guard/state、CTS、完整 effects及开放任务所有者。
2. 必要效果：用本次真实 ACTLINKS_UPDATE、标准精确 header/variables write/delete、server时间及正式激活GUID建立完整生命周期。首个试点限定目标/profile前态满足既有保护和空effects条件；非空共享profile不得自动恢复。检查缓存以及其他标准调用方的锁/作用域，完整映射 after-import 与分发策略，不能悄悄省掉必要步骤。
3. 正式 CTS：沿已验证 CUNI 的非对话检查/追加路线建立十个精确业务键及标准关联/变量键的合法策略；保护已有 TDAT/CUNI/E071/E071K/E071K_STR，清理仅本次确定delta。独立 DB_COMMIT 的清理按分段状态和读回记录，不能包装成一个原子 rollback。
4. 命令：先准备全部十行及十九键证明，再初始化 link 全局数据，暂存标准维护、关联和 CTS，按验证过的顶层提交契约一次持久化配置。协议/after-import/分发的独立阶段显式记录；返回时区分未开始、已暂存、已提交、部分/未知。超时不新建 operationId 重放。
5. 恢复：同一不可变原生前态与本次 receipt 绑定，确认十行仍为已批准候选后倒序删除，精确还原正式效果/本次CTSdelta；九保护键及已有CTS始终保持。协议保留、不可补偿的分发给出接管清单，不宣称所有标准副作用已抹除。
6. 先完成本地真实故障/版本/并发/保护/未知结果回归与完整候选差异，再申请确切客户对象部署和新配置写入权限；原KG中文文本临时改值批准及r59预算不自动扩展到十行新配置。

## 验收条件

公开MCP入口能够以标准API执行十行保存，十九键完整读回，正式links/header/variables/CTS/协议逐项对账，正常及失败路径释放本命令锁，持久化回执可在中断后只读对账。恢复精确得到原有字段与缺行，保留九保护键、既有CTS和历史协议；未知结果不得变成假成功或假回滚。必须同时通过SAP编译/激活、实际作用域和提交验证，本地mock不能替代。

## 待具体审批的范围和依赖

开发请求GR2K923472/任务GR2K923492，配置请求GR2K923429/任务GR2K923430仍为候选范围，均不释放。待完整源审阅后再定义确切对象及预算；建议首轮最多一次APPLY和一次RECOVER、十行新增/十行删除、九键保护，CTS清理另列精确delta。这里是计划，不是新增业务授权。

P1：外层全部锁、links分配/共享owner与缓存、正式CTS精确delta、协议/分发/after-import提交阶段、完整命令及新的具体SAP写批准。P2：公开EFFECTS真实集成验收、非空共享profile恢复、CFG-07/08具体业务域及负责人触发验收。后者先明确对象/API/业务需求，禁止造一个可写所有标准表的通用SQL工具；所有未支持活动必须有明确的不可执行原因。
