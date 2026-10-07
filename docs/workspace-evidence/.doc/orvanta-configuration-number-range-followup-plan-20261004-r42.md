# 下一阶段任务：r42 配置 API 故障与并发验证

依据：r41 实际源/接口/完整 SAP 读回、四次原生命令、两次间隔改值及本项目 SPRO backlog。路线仅 API；上一阶段调用额度已经耗尽。本计划不是新的 SAP 写入授权。

## 目标与最小交付

1. 在号码范围 command 及保护回执真实所有权处保留首个根因。针对 native transport fault、标准 API/update task 拒绝、读回失败、cleanup失败以及回执写入失败，给出稳定拒绝/unknown 分类和不泄密的证据；不能用当前值补造历史成功。
2. 完成本地故障及并发矩阵：持久化前失败零派发；已派发后异常只有一次派发；同对象、不同 interval 的互斥锁仍覆盖整个 client/object；并发失败不能借其他 operationId 绕开 unknown；跨 client/object/历史回执目标串用被拒绝。复用现有 receipt store，不另建工作流引擎。
3. 保留 r41 语言、精确 Include 来源及 SOAP TABLES 绑定回归，不扩大范围或公共输入契约。
4. 准备并在获得具体新增写验收授权后补证修正构建的 fresh create。候选已附 JSON；目标仍是专用 ZORVCFGNR，新增 interval02[201..300]，原01[1..200]必须不变。成功后只读完整读回、当前号、锁和回执，专用对象/interval 按批准保留，不取号、删改当前号、释放或迁移。

## 验收条件

| 工作包 | 必须证明 |
| --- | --- |
| 错误模型 | 第一根因有稳定 code/hash 或已有安全消息字段；失败不误报 completed/no_changes，未派发不误报未知写；不暴露密码、请求头、token、cookie 或锁句柄 |
| 故障模型 | 真实数据结果与历史回执分开；native及readback/cleanup组合覆盖；没有吞掉原始错误、自动重试、自动回滚或以 mock 代替 SAP 业务验收 |
| 并发 | 同对象不同interval一次派发，保护锁/版本/目标不串用；独立对象按既有契约处理；临时本地测试产物清理有证据 |
| 新增真实 create（需批准） | 专用02正确，原01及两行 current level 不变；公开 MCP status/保护 receipt 均 completed，COMMITTED/SESSION_RESET/UNLOCKED=X；完整 native/readback 两行相同且版本一致；仅1次原生命令/1次新增间隔提交 |
| 交付 | 源码/契约/索引检查及受影响回归通过；任务差异与其他暂存修改保留；新的唯一 code-update 及镜像/manifest |

## 新增 SAP 写验收具体候选（待批准）

- 系统/用户：w200、GR2、client200、WYS。
- 已存在专用 customer object：ZORVCFGNR；仅创建 interval02，空 subobject、year0000、内部、201—300。不创建或改SAP源对象、NROB定义，不改01，不记录/迁移 NRIV CTS。
- 额度：最多 **1 次 Z_ORVANTA_CFG_NR_APPLY、1 次新间隔改值提交**；与已耗尽的 r41 四次额度独立，批准前零派发。
- 预检：冻结新构建、核对 active customer/标准源/Include 与完整 TNRO/NRIV 布局；重新读取现值与完整版本；证明01仍1—200且current level0、02不存在、未分配/年度/缓冲/子对象/外部模式不支持范围均拒绝。候选的计划版本不替代执行前新鲜版本。
- 失败处理：停止写并保留原生结果/历史保护回执，仅读取完整数据、锁与可用传输信息；不新建操作号重做创建、不删除专用interval、不释放请求或任务。
- 当前定义包/请求保留：ZABAP / GR2K923472。interval本身 local client only，不以传输号宣称区间可迁移。
- 清理：关闭专用实例并清除仅存于进程的临时口令；仅保留专用验收数据和非秘密证据。

## 依赖及后续顺序

- 本地实现和AI测试授权已经具备，可继续独立工作；新增真实 create 尚需这份具体范围的批准，不能由“继续开发”推导出额外改值额度。
- ATC 当前 HTTP404，E071K 通用查询默认拒绝，不绕过。区间迁移另设工作包；实际分配并发/年度子对象/业务在用区间不能从本次专用unused正例外推。
- 此后按 backlog 进入 CFG-04 BC Set 受控激活、CFG-07 增强配置独立动作、CFG-08 一个明确业务语义域；先实读 API、接口和提交边界，再确定最小可验收写场景。完整 SPRO 未完成时必须继续主动规划，不用工具数量或登记 verified 代替全项目完成证据。
