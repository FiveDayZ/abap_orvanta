# r70 协议头任务号修正审阅包

2026-10-07T08:40:27.707+08:00，Asia/Shanghai。状态：**本地候选检查通过，未部署 SAP，原 KNM 闭环失败且回执保护保留**。不以源码修正或模型测试冒充 SAP 已修复。

## 已确认缺陷及实际结果

SCPR_ACTIV_PROTOCOL_WRITE 的本次实际 134 行源码：首次 INSERT SCPRACPP/R/3* 分支复制 ACTOPTIONS 等字段，却不复制 TRNO_CUST；只有已有头的 ELSE 分支 56—59 行回填配置任务号。客户 orv_bc_owner_protocol 却在首次 H 调用后立即要求 TRNO_CUST=GR2K923430。新 ACT_ID 下，该要求与标准函数行为冲突。

本次实际 APPLY 返回 PROTOCOL_UNCERTAIN / rolled_back / locks released，ACT_ID=6AC4AA6FD7C80CD0E1008000C0A8581A；只读 RECONCILE 返回 HISTORY_UNPROVEN，历史判断保持 unknown。十行仍缺失，完整 CTS 与正式 effects 指纹和 before 完全一致；独立历史头的字段当前尚待新窗口只读核实。没有 RECOVER 或重试。

## 完整源码与精确差异

仅修改既有客户 Include LZORVANTA_BC_CFGF65（FUGR/I），父组 ZORVANTA_BC_CFG，包 ZABAP，开发请求 GR2K923472 / 任务 GR2K923492。已通过服务器 URI /sap/bc/adt/functions/groups/zorvanta_bc_cfg/includes/lzorvanta_bc_cfgf65 完整读回当前 1267 行；其归一化指纹 f2910454687ece39df94a75d1decabd83ff473fa87b8e7f6cc3a815720aae7a9 与冻结原源匹配，原 CRLF 全源 SHA-256 5dacc59b8b7b0ad579623c9cc0eec24bfd7740eaa3ebfb055cae3883574b20b7。

新增一条解释注释和一条 ECC7.31 IF/APPEND：H 阶段把同 ACT_ID 的无消息行在同一 TABLES 输入中追加第二次。标准函数同次 LOOP 的首行插入协议头，第二行走已有头分支回填任务号；仍只调用一次标准函数、一次该函数内 R/3* commit。E/R 不追加第二行。MSGID/MSGNO 为空，因此该载荷不增加消息行或键行；不是直接 SQL 更新标准表。

候选 1269 行、最长 253 字符，CRLF 全源 SHA-256 b6fd553e1403a64747832b39c2922f5525d6e9d8af7b2282fc8a6ab77f59fe4e。[完整候选 ABAP](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-protocol-fix-20261007-084027-r70-F65.abap)；[原源、候选、精确 oldString/newString 和标准依赖源](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-protocol-fix-20261007-084027-r70-candidate.json)。两个新行之外全源保持原样，接口、保存/恢复、CTS、锁及未知结果契约不变。不改 SAP 标准对象，不新增客户对象，不更新 TOP/Kernel 或三个 RFC 壳。

## 验证与部署条件

456 BC 回归、类型、格式、headless 检查通过。三项新增检查使用实际标准源固定其插入/更新差异，并解释生成的 TABLES 载荷，复现单行 H 缺任务号、验证双行 H 和单行 E/R。它们是有限模型，不执行 ABAP SQL、锁、提交或持久化；SAP 运行仍需验收。

部署前必须先核实原独立历史和完整当前十九键/CTS/effects，保留失败回执；再次读 active/inactive 源、父组登记、对象锁和 472/492 状态，要求原源完整匹配，无其他人草稿或锁。仅按上面的唯一匹配差异写入并激活 F65，重读全源、运行诊断/依赖编译和只读接口验收；旧源码与原生回执保留。任一源码或任务漂移不写。

## 原失败保护和下一轮业务测试

原 operationId spro-r69-apply-knm-0001、receiptHash 3e6a687683d1ee9d7670d841ab23c6f20b5a5ff4c2df1ab1a319511f28ef15a4，原进程已结束；localLockReleased=false、outcomeMayBeUnknown=true。当前未解除保护，也不改写失败回执为成功。

本次已用完批准的一次原生 APPLY；剩余 RECOVER 没有已知完成 APPLY，不能调用。后续额外 APPLY 或人工解除这一个本地保护须另经具体确认：先以真实原 ACT_ID 的 B 标记/未完成历史、完整十九键/effects/CTS 及原源调用顺序证明当前状态，再按最新 receiptHash 人工接管，仅释放原私有 .cache/spro-r69/state 的该目标保护；历史和 failed/unknown 判断保留。未获新的写预算前不通过新 operationId、新 stateRoot 或其他工具重试。新的业务试验仍仅 [原批准十行值和九保护键](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-knm-pilot-values-20261007-075424-r69.json)，最多一次新的 APPLY 和一次 RECOVER，不扩大配置或 CTS 范围。

## 限制与风险

- 协议头真实字段当前待只读核实；源码缺陷已确认，但不把推断冒充该行的实际内容。
- SAP 修正尚未部署；首次 H 的实际标准委托、API 保存/恢复、正式 effects 和 CTS 清理仍需真实验收。
- CTS 恢复清理有内部提交，仍分阶段证明；独立历史允许保留，不删除旧未完成历史。
- STATE 本次实测 95.972 秒，仍超默认 SDK 60 秒，私有验收用 1200000ms。
- 共享 4849 保留；完整 SPRO CFG07/08 等需求仍未完成。

[开发记录](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261007-084027.md)；[下一阶段具体计划](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-followup-plan-20261007-084027-r70.md)。
