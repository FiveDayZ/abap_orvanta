# r45：BC Set 原生前态 API 对象级实施提案

2026-10-04T21:17:39+08:00；依据r43/r44实际五表来源和目标key定义。全SPRO尚未完成，继续API-only路线。

## 具体实施范围

- 目标 w200/GR2/client200，包ZABAP，现有已授权请求GR2K923472；仅开发对象写入，不释放请求。
- 新客户函数组 **ZORVANTA_BC_CFG**；新只读remote RFC **Z_ORVANTA_CFG_BC_READ**。实施前精确检查名称是否存在、当前源/接口/归属及请求任务，已有对象或不符时不覆盖。
- 唯一BC Set来源 EHS_CUNI_KNM/N；限定5表CUNI记录，当前源全表/清单指纹必须仍一致。其他集合/版本/维护对象不接入本阶段。
- 读取目标200：T006/KNM；T006A的KNM及语言1/D/E；T006B的MSEH3=KNM及语言1/D/E；T006C的MSEH6=kN/m2及语言1/D/E；T006D的DIMID=PRESS。
- 必须按别名自身key读取B/C，即使MSEHI目前指向其他单位也返回冲突，不能按MSEHI筛选而漏掉冲突；PRESS仅读取，不修改维度。
- 输出完整原生typed rows及精确missing/present状态、来源指纹、当前client/system/user与SAP产生的目标版本。T006的FLTP和所有保留空格都需纳入原生版本；不能由当前trimmed字段重建。

## 最小交付与接口准备

1. 读取现有单位read helper完整active源/接口，复用已实际证明的权限/错误/版本规范；核实完整行序列化和SHA-256接口在ECC7.31存在。仅在技术证明后固定实际DDIC/RFC参数，不猜对象或接口类型。
2. 完成新只读RFC和MCP attestation/reader：边界校验、S_TABU_DIS/S_TABU_NAM权限、目标/源/布局前后核对、完整行版本和失败清空。禁止COMMIT、ROLLBACK、enqueue变更、update task、配置写、CTS数据录制及激活/模拟调用。
3. 同一请求记录客户开发对象，逐对象源回读、诊断、激活检查；实际调用核对别名已有映射、PRESS现值、原生版本变化与重复读取，拒绝其他client/key/来源和未获权限。
4. 将源码/API及五表前态链接到后续标准激活候选；只读helper通过仍不授权BCSet activation。

## 验收条件

- 本地相关协议、版本、错误及边界测试通过；公开工具source/interface attestation与实际SAP固定构建一致。
- 新客户对象保存/激活/回读/诊断通过；仅真实只读调用，五表native rows、existing alias conflict和source version能逐项对账。
- no configuration mutation；请求保持未释放；他人对象、工作区修改、共享服务保持；不可把未执行的ATC/Unit/业务验收标为通过。

## 依赖及授权边界

- 根AGENTS.md第6节要求“Modify only an explicitly approved Z* or Y* customer object in the current task”。GR2K923472请求授权不能替代上述新函数组/RFC的对象级批准。
- 此提案只申请新客户开发对象，**不申请EHS_CUNI_KNM激活、KNM新增、别名修改、PRESS维度修改、模拟激活、任何业务触发或请求释放**。下一步配置写将另给完整before/after、确切keys/语言、覆盖/保护、日志/CTS及恢复清单后再申请具体批准。
- 后续标准激活需证明CUNI的实际后导入方法及提交/日志边界；然后CFG-07逐动作、CFG-08按明确业务需求和真实触发完成，不能把任意表写称为全部SPRO。
