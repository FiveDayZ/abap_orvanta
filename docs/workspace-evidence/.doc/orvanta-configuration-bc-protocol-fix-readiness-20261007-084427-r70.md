# r70 F65 修正只读部署预检补充

2026-10-07T08:44:27.230+08:00，Asia/Shanghai。**Review Only**：本补充只记录真实只读预检，不表示已部署、批准业务重试或解除保护。

## 完整审阅与已完成证据

完整候选、差异、标准依赖及验收边界见 [r70 审阅包](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-protocol-fix-review-20261007-084027-r70.md)，原生失败和本地修正见 [开发记录](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261007-084027.md)。本地 456 项回归、类型、格式和 headless 均已通过，本补充未重复测试。

本次通过共享 4849 的真实只读工具完成：父组 ZORVANTA_BC_CFG 登记 ZABAP、GR2K923472/GR2K923492、status D；472/492、429/430 四个请求或任务 Owner WYS、Status D；F65 1267 行完整再次读回，与原候选基线逐行相同；WYS 当前客户端的有界 SM12 返回零行且 hasMore=false。该锁结果只证明 WYS 本次范围，不证明其他用户无锁。

prepare_delivery 仅查询 F65 的本次 session-visible inactive 清单，目标未出现；不证明其他用户的草稿或完整释放就绪。随后实际 preview_source_changes 检查当前完整 active/inactive 文本和唯一替换，返回 ready_for_review、blockers=[]、inactiveFingerprint=null，activeFingerprint=5dacc59b8b7b0ad579623c9cc0eec24bfd7740eaa3ebfb055cae3883574b20b7。诊断实际返回：No diagnostics found for adt://w200/sap/bc/adt/functions/groups/zorvanta_bc_cfg/includes/lzorvanta_bc_cfgf65. The active SAP source has no syntax errors or warnings.。

该预检不锁定源码，也不是原子授权或未来的无漂移保证。部署前仍须重读对象版本、草稿、对象锁及开发任务状态，保留完整原源备份；已有版本不匹配则拒绝写入。

## 保留的失败证据与依赖

原一次 APPLY 已消耗预算，PROTOCOL_UNCERTAIN、outcomeMayBeUnknown=true、failed 回执和本地目标保护均原样保留。原进程已结束；没有 RECOVER、业务重试、配置 CTS 清理、源码写入、保护解除或请求释放。

独立原 ACT_ID/十九键/effects 对账实例仍在等待手工登录，尚无完成证据。先完成该对账，再按 [r70 计划](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-followup-plan-20261007-084027-r70.md) 判断安全的源码修正部署及后续额外业务试验；不得以此预检换新 operationId/stateRoot 绕过原保护。

## 原始错误保留与范围

预检脚本首次遗漏 search_sap_locks 必填 username，SDK 在 SAP 调用前拒绝；补上 WYS 后完成源和任务读回。诊断调用误加 connectionId 也在 SDK 边界被拒绝；仅用 fileUri 修正并补做诊断及预检，未重复业务命令。这两个原始参数错误及最终响应完整保存在 [只读证据](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-protocol-fix-readiness-20261007-084427-r70.json)。

共享服务未重启、共享 dist 未覆盖、其他修改和暂存未变。完整 SPRO 功能仍未达到真实配置闭环验收。
