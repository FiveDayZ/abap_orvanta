# r50：固定 BC Set 的 API 执行与恢复契约候选

实际时间：2026-10-05T14:41:12.406+08:00（Asia/Shanghai）。状态：Partially Verified。当前交付是只读统一预检；本文件是后续命令设计，不是已实现命令、配置执行授权或已证明的恢复方案。

## 固定范围及前后值

w200/GR2/client 200、当前 WYS；EHS_CUNI_KNM/N，CUNI/T。五张候选表 T006/T006A/T006B/T006C/T006D 共 11 键；T006I/T006J/T006T/T006_OIB 共 8 个保护键。语言 1/D/E，来源 client 001→200，假设 CREATE_INITIAL_OR_UPDATE_USE。完整 19 行 before/after 和逐字段状态见 [本地重放](<C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-preflight-local-replay-20261005-r50.json>)。该重放使用历史 r46/r49 真实子工具回执，并未进行当前统一预检；不能作为本次 SAP 激活前态或审批凭证。历史范围表现为 10 个候选新建、共享 PRESS 一行不变、7 个关联行存在、T006_OIB/KNM 缺失。实际执行前必须全部重取原生五种版本，并在 SAP 锁内核对。

| 表 | 固定键（client 均为 200） | 方案约束 |
| --- | --- | --- |
| T006 | MSEHI=KNM | 仅批准的完整源映射字段；保留省略字段 |
| T006A | SPRAS=1/D/E，MSEHI=KNM | 不替代 KG 已批准描述测试 |
| T006B | SPRAS=1/D/E，MSEH3=KNM | 任何指向其他 MSEHI 的别名碰撞拒绝 |
| T006C | SPRAS=1/D/E，MSEH6=kN/m2 | 同上；不接受任意键 |
| T006D | DIMID=PRESS | 共享维度；必须单独展示所有变化，不能默认批准覆盖 |
| T006I | CLIENT=200，ISOCODE=KPA | 完整保护，缺失不授予创建 |
| T006J | CLIENT=200，LANGU=1/D/E，ISOCODE=KPA | 完整保护，保持现值 |
| T006T | MANDT=200，SPRAS=1/D/E，DIMID=PRESS | 完整保护，保持现值 |
| T006_OIB | MANDT=200，MSEHI=KNM | 完整保护，保持存在/缺失状态 |

## 标准 API、参数及依赖

15 个函数共 6803 行完整源码本次实际重新读取；审查集中在具名授权、主导入、行加载、锁、日志、CTS 和清理分支，未声称全部代码及所有调用依赖审查完成。原始源/接口身份及 CTS 读取结果见 [实源证据](<C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-preflight-standard-sources-20261005-r50.json>)。

拟议调用 SCPR_ACTIV_MN_REMOTE_SUB（当前 remoteEnabled=true、非 update task）→SCPR_ACTIV_MN_ACTIVATE→SCPR_PRSET_CT_IMPORT_INDUSTRY。未来专用客户命令候选名 Z_ORVANTA_CFG_BC_APPLY，尚未生成占位 ABAP、未创建、未部署。必须先核对输入/输出 DDIC、固定键锁内版本保护、事务及恢复后形成完整源码。当前四个只读客户 API 不作修改。

| 参数/动作 | 已核实的语义或拟议约束 |
| --- | --- |
| ACTIVATION_TYPE=1 | LSCPRACF01 239–367 当前源：0 设置 dialog=Y，其他合法值 1 设置 N |
| COMPLETE_ONLY=1 | 标准模式；2 为 unchecked，不能在首次命令偷偷选择 |
| SIMULATION_ON=空 | 映射实际激活；本阶段从未执行，模拟也会涉及日志，不作只读探测 |
| CATEGORY=空 | classical，不能切换 Switch 分支 |
| SAFETY=Y | 仅作为拟议防护；不是全链路无部分结果的证据 |
| NO_COMMIT=X | 传入 actopts 及 TRANSACTION_MODE 内存；只抑制具名主连接提交，不能撤销独立日志连接 |
| PROTO_HANDLE | 在 SAP 创建并核对非零原生 UUID，不能采信外部审计用户或伪造结果 |
| CONTROL_SYSTEM/CONTROL_USER | 从 sy-sysid/sy-uname 派生，不接受调用者覆盖 |
| TASK_NUMBER_CUST | 必须绑定已批准开放请求和准确任务；禁止创建、换任务或录制到别处 |
| TRANSPORT_OFF/SYSEDIT_OFF | 不跳过配置录制或系统/client可改检查 |
| AFTER_IMP | 保持实际方法审查要求；不能通过关闭必要方法“通过”验收。当前预检只接受 OBJM=0，新增方法使结果撤回 |
| VARIABLES_NEW/VAR_WITH_LANGUAGE/VARIABLES_OFF/LANGU_ONLY | 多语言和来源 D 占位如何进入标准链尚待逐字段核对，不能把假设预览的 1/D/E 当作标准入口默认效果 |
| BCSET_IDS/RECATTR/VALUES/VALUESL | 不开放任意外部记录；具体 DDIC、唯一固定成员与源 N 的装载/映射必须完成后再生成命令 |

## 当前配置任务观察与未获得授权

本次 manage_transport_requests 实读 GR2K923429/GR2K923430：owner WYS，状态 D，430 包含 ZTPMC_TPCFG/TABU 和 CUNI/TDAT 两个对象。E070 精确读取成功；E070C 与 E071K 被 TABLE_NOT_ALLOWED 拒绝。这些拒绝保留在证据中；没有重试、放开白名单或用其他调用绕过。现有 KG 临时改值/恢复及 429/430 行录制授权不覆盖 BC Set 整包激活，472 为客户程序 Workbench 范围，也不替代配置任务。

因此当前没有可批准执行的真实配置预算：activation=0、simulation=0、configuration save=0、CTS append/cleanup=0、recovery write=0、release=0。未来须先取得固定只读 CTS 路线，确认 E070C client/请求归属、E071K 完整且未截断的前态和精确固定业务键；形成准确请求/任务、值差异及副作用申请，再就一次具体业务操作确认。此处未申请使用任意请求或预先批准删除。

## 已确认提交和清理边界

| 实源位置 | 事实及命令约束 |
| --- | --- |
| REMOTE_SUB 128–172；AUTHORITY_CHECK 21–55 | SCPR20 及条件 BC Set ACTVT 07/63；登录成功不等于配置写授权，未来还需对应表/维护对象权限 |
| IMPORT_INDUSTRY 127–222、1150–1151 | ENQUEUE_E_TABLEE 以表名及 client 前缀锁定，部分锁失败会删除该对象待激活数据；不能把总返回当作全内容保存成功 |
| ONE_TABLE_LOAD 241–293、323–448、476–588 | 标准实际读行、更新/初始新行构造、MODIFY及错误分支；调用标准函数也不能省略范围、授权或失败对账 |
| IMPORT_INDUSTRY 1072–1143 | CTS 写入后按 part 写日志；no_commit 为空时逐 part COMMIT WORK |
| MN_ACTIVATE 2030–2041、2193–2196、2578–2581 | no_commit 注册 rollback/commit protocol handler，并控制两处主连接提交；未证明所有下层提交/更新任务 |
| PR_DB_DATA_WRITE 18–28 → PROTOCOL_WRITE 17–132 | 日志 INSERT/MODIFY 使用 connection R/3*，commit connection R/3* 独立持久化；主连接回滚也可能留下失败日志 |
| TRANSP_HANDLE 277–368；TRANSPORT_LOAD 118–169、311–435 | 请求非 owner 分支可继续，任务可能重新选择；外层必须精确约束实际任务/对象/键，不采信请求号非空 |
| RUN_AFTER_IMP 31–78；TR_CALL_AFTER_IMP_METHOD 24–33；TRINT_CALL_AFTER_IMP_METHOD 93–104 | no_commit 继续向下一层传递；实际动态方法及 FORM 的提交行为仍需审查，不能仅凭参数名保证无提交 |
| MN_ACTIVATE 2017–2023、2270–2277、2613、2620–2674；SCTM_FRAME 9–15 | 内存/rollback handler/分发框架状态；正常末尾清理存在，早期抛错是否跳过和异常会话隔离须关闭依赖后证明 |

## 未知、部分结果和恢复契约

未来 apply/reconcile/recover 分开。调用前保存原生完整 typed before（包括 FLTP 和缺失标记）、五个版本、源码/接口、固定19键、准确 CTS 前态、原生 UUID 与本地 operationId。SOAP 文本或本地 JSON 不可作为精确 typed 恢复数据。

返回失败、SOAP fault、超时、失联或核对不符时，保留第一根因并标 outcomeMayBeUnknown；禁止重发激活、盲写恢复或声称全回滚。只读逐项读回19键、五种版本、原生激活日志、CTS键/实际任务及锁，分别判定 before/candidate/其他/不可读取；仅持久化值与要求的日志/CTS均吻合才返回成功。部分/未知不能提升到完整成功。

对于首次候选，10 个原本缺失的行若被创建，恢复将涉及删除；共享 PRESS 要恢复完整 typed 原值，关联8键应无写入。当前没有验证过的标准恢复入口/精确 CTS 前态，所以不生成“自动恢复成功”或直接 SQL 表写方案。恢复必须绑定原 operationId、批准的键和 typed before、当前行仍属于本次候选；并发被他人改动即拒绝并交人工接管。CTS 历史条目不能靠恢复值自动移除，清理/释放独立授权。

## 下一步必须关闭的条件

P1：完成固定 CTS 只读桥接及 E070C/E071K 证据；关闭标准分发 LOCAL_START、TRINT_APPEND_COMM、实际 method FORM、下层更新任务与早期退出清理；证明全9表锁内版本保护；确定标准1/D/E映射及可精确 typed 恢复入口。P2：实际统一预检、真实权限不足、并发/ABA和已有非零 OIB/FLTP 行均待补。本文件不构成 SAP 新对象或业务写授权。
