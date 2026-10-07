# r71 KNM 协议修正后的受控闭环及本地保护接管审阅

2026-10-07T09:03:20.243+08:00，Asia/Shanghai。**待具体授权，尚未执行**。本阶段准备新增一次 APPLY、一次 RECOVER，不能沿用 r69 已消耗的一次 APPLY 预算。

## 现有实证和源码修正

原 operationId spro-r69-apply-knm-0001，ACT_ID 6AC4AA6FD7C80CD0E1008000C0A8581A 的两次实际协议头读取一致：ACTOPTIONS=A:B:8f71425554cc21f44142e010dbf7c28d:、TRNO_CUST 为空、ACT_START=20261007001605、ACT_END=0。标准 SCPR_ACTIV_PROTOCOL_WRITE 首次插入分支未复制任务号，与旧 helper 随即校验任务号的规则冲突；该失败检查位于记录 staging 调用之前。完整十九键/CTS/effects 读回均与原前态完全一致。

F65 已按既有客户对象开发授权保存并激活，仅 H 载荷新增同 ACT_ID 的第二条无消息行；1269 行全源读回一致，诊断无错误，完整客户/标准源、ABI/layout attestation 前后相同 ce437b1010c069f9e9f4680bfef16a78ac7d4058dbb0886095dd691dcaae0b14。保存回执 completed，latest receiptHash=de1c53e88127f0857e82a515111c6b6eda697f1eb23a9ca2d10d6a0650c7332d。未新增或修改其他客户对象，未改标准对象。

## 申请的精确范围

系统仅 w200/GR2/client200/WYS，BC Set EHS_CUNI_KNM/N，配置请求 GR2K923429、任务 GR2K923430。复用原批准的完整值，不接收任意表、单位、语言或 SQL。

1. 固定新构建先做十九键、完整 CTS、正式 effects、标准/客户源和 task/scope/locks 的新鲜预检；再次两读原 ACT_ID 协议，要求与上面未结束 B 头精确匹配。
2. 只对原私有 stateRoot C:/My/Workplace/Coding/vscode-abap/abap-mcp-standalone/.cache/spro-r69/state 的 CONFIG:BC:CUNI:200 本地保护人工接管一次。操作为 release_write_operation_lock，原 operationId=spro-r69-apply-knm-0001，当前 receiptHash=3e6a687683d1ee9d7670d841ab23c6f20b5a5ff4c2df1ab1a319511f28ef15a4，confirmation=SAP_STATE_VERIFIED。只释放本地目标锁，不解 SAP 锁；既有 failed/unknown 结论及不可变 intent/result/原始回执快照保留，本地回执仅追加人工解除的时间和理由摘要。
3. 新 operationId spro-r71-apply-knm-0001，**最多一次原生 APPLY**：保存下列十行，逐字段读回，核对九保护键、十个新增 CTS 键和正式 effects；仅已知 completed/applied 且不确定标志为 false 才允许下一步。
4. 新 operationId spro-r71-recover-knm-0001，**最多一次原生 RECOVER**：绑定这次成功 APPLY 回执和恢复 frame，把这十行恢复为缺失，仅删除已证明属于此次的十个新 CTS 键及恢复此次正式 effects；九保护键全值不变，最后重新生成完整十九键前态，要求原 reference、完整 CTS/effects 一致。独立历史头允许保留，不删除旧未结束历史。

使用原 stateRoot，不通过新目录规避原保护。没有原生写重试、额外保存/恢复/清理命令、源码再部署、跨系统写、请求释放或共享服务重启。

## 完整值与键

[十行每字段 after、九保护键每字段 before、原版本与锁范围](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-knm-takeover-values-20261007-090320-r71.json)，来源字节与 r69 值文档完全相同，SHA-256 6d0f7546c34d1699c5014773d909a0e47ca6774a0d609fcabbe4f2d8c4abccec；该来源曾获 r69 范围批准，但这里的额外命令次数及本地保护接管仍待新确认。

新增键：

|表|完整键|当前前态|
|---|---|---|
|T006|`{"MANDT":"200","MSEHI":"KNM"}`|缺失|
|T006A|`{"MANDT":"200","SPRAS":"1","MSEHI":"KNM"}`|缺失|
|T006A|`{"MANDT":"200","SPRAS":"D","MSEHI":"KNM"}`|缺失|
|T006A|`{"MANDT":"200","SPRAS":"E","MSEHI":"KNM"}`|缺失|
|T006B|`{"MANDT":"200","SPRAS":"1","MSEH3":"KNM"}`|缺失|
|T006B|`{"MANDT":"200","SPRAS":"D","MSEH3":"KNM"}`|缺失|
|T006B|`{"MANDT":"200","SPRAS":"E","MSEH3":"KNM"}`|缺失|
|T006C|`{"MANDT":"200","SPRAS":"1","MSEH6":"kN/m2"}`|缺失|
|T006C|`{"MANDT":"200","SPRAS":"D","MSEH6":"kN/m2"}`|缺失|
|T006C|`{"MANDT":"200","SPRAS":"E","MSEH6":"kN/m2"}`|缺失|

保护键：

|表|完整键|当前前态|
|---|---|---|
|T006D|`{"MANDT":"200","DIMID":"PRESS"}`|现值保留|
|T006I|`{"CLIENT":"200","ISOCODE":"KPA"}`|现值保留|
|T006J|`{"CLIENT":"200","LANGU":"1","ISOCODE":"KPA"}`|现值保留|
|T006J|`{"CLIENT":"200","LANGU":"D","ISOCODE":"KPA"}`|现值保留|
|T006J|`{"CLIENT":"200","LANGU":"E","ISOCODE":"KPA"}`|现值保留|
|T006T|`{"MANDT":"200","SPRAS":"1","DIMID":"PRESS"}`|现值保留|
|T006T|`{"MANDT":"200","SPRAS":"D","DIMID":"PRESS"}`|现值保留|
|T006T|`{"MANDT":"200","SPRAS":"E","DIMID":"PRESS"}`|现值保留|
|T006_OIB|`{"MANDT":"200","MSEHI":"KNM"}`|现值保留|

## 真实验收、拒绝和失效条件

APPLY 必须证明 H 头任务号确实为 430、E 标记/ACT_END 完成、十行完整候选、九保护键、正式 effects、完整 CTS 两根及本次 delta、自有锁释放；RECOVER 必须证明十行缺失、九保护键全值、正式 effects 还原、CTS 完整前态和恢复历史。任何 unknown、部分提交、源码/布局/权限/task/前态/CTS/history 漂移都保留回执并停止相关写，不通过新 ID 追加预算。未得到已知 APPLY 不调用 RECOVER。清理 CTS 有独立提交，按其阶段回读，不声称统一 rollback。

此时 F65 H/E/R 实际修正后的正例尚未运行。通用 tester 因 4096/STRING 前置限制拒绝，原生未派发；专用目的接口才是下一次正确验收入口。SDK 私有 timeout=1200000ms，STATE 仍超过普通默认 60 秒，不宣称默认调用延迟问题已解决。

固定 .cache/spro-r71 构建 138 文件，SHA-256 d78c9b7d82ed3092d75f6eb0b9de4e3129d4fafc23f8aa27c61a9e2523603a13，仅已准备，authorization.json 不存在，尚无 acceptance.json 或登录进程；授权绑定本 review-scope 和冻结指纹。[本阶段实证记录](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261007-090320.md)；[下一阶段计划](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-followup-plan-20261007-090320-r71.md)。
