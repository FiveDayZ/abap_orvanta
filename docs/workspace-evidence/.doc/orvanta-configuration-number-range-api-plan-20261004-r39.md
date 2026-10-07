# CFG-03 号码范围 API：r39 部署与验收方案

准备时间：2026-10-04，Asia/Shanghai（+08:00）。状态：**待对象及测试数据授权，未部署、未执行配置写入**。

## 目标及最小交付

通过标准 NUMBER_RANGE_* API 保存一个未使用、无缓冲、非年度、无子对象和分组的客户号码范围间隔。全量版本检查、标准锁、完整回读、更新任务提交及会话清理均进入外部契约。仅使用 API，不使用 GUI 自动化，不直接写 NRIV/TNRO。

本地适配器与受保护回执包装已实现并通过相关回归；使用现有回执存储，在派发前保存实际读取的完整版本证据，同一操作不能重复派发，同一对象的所有间隔共用保护目标。未知结果记入失败回执，禁止自动重试。尚未部署到 SAP 或注册为公开 MCP 命令，不能据此宣称 SAP 上可用。需要先完成本方案原生验收，再完成公开工具登记与实际回执闭环。

## 已读取的实际依据

- w200 / GR2 / client 200；现有计量单位函数组包为 ZABAP。
- GR2K923472 当前为 Workbench 请求（K）、可修改（D），所有者 WYS。
- 新函数组 ZORVANTA_CFG_NR 返回 REPOSITORY_OBJECT_NOT_FOUND；两个新 RFC 未找到；专用号码范围 ZORVCFGNR 的权威读取返回不存在。
- 已读取 NUMBER_RANGE_ENQUEUE、DEQUEUE、UPDATE_INIT、INTERVAL_UPDATE、UPDATE_CLOSE、INTERVAL_LIST 的实际接口与源代码，核对 LSNR1F01/F02/F99、FSNR1CDC。
- 已读取 CALCULATE_HASH_FOR_RAW、NUMBER_RANGE_API_THNOCALL、SWE_REQUESTER_TO_UPDATE、NRINTERVAL_WRITE_DOCUMENT、CHANGEDOCUMENT_CLOSE。标准保存登记更新任务；提交失败保留为结果未知，禁止自动重试，不承诺已回滚提交后的数据。
- NRIV 实际定义包含完整 9 字段；NRLEVEL 数据元素使用 NUMC20。比较时统一零值表示，不把非零状态折叠为零。
- SZN_COMMON_FORMS 的实际 S_NUMBER 校验使用 NROBJ 和 ACTVT；候选读取用 03，保存用 02。认证不代替授权。

## 需要具体批准的对象与副作用

| 对象 | 动作 | 包 / 请求 | 影响 |
| --- | --- | --- | --- |
| FUGR ZORVANTA_CFG_NR | 新建 | ZABAP / GR2K923472 | 独立函数组，避免修改计量单位接口或其他工作流 |
| FUNC Z_ORVANTA_CFG_NR_READ | 新建、诊断、激活 | 同上 | 完整 TNRO/本客户端 NRIV 只读版本 |
| FUNC Z_ORVANTA_CFG_NR_APPLY | 新建、诊断、激活 | 同上 | 标准 API 创建 / 修改间隔；独立 LUW |
| NROB ZORVCFGNR | 新建专用验收定义 | 同上 | NUMC20、无缓冲、非年度、无子对象/分组 |
| NRIV ZORVCFGNR / 200 / 空子对象 / 01 / 0000 | 创建、修改 | 本客户端保留，不录制间隔 CTS | 仅执行以下 2 次有改值保存；不分配号码 |

源码候选：[读取 RFC](z_orvanta_cfg_nr_read-20261004-r39.abap)、[保存 RFC](z_orvanta_cfg_nr_apply-20261004-r39.abap)。[部署清单](orvanta-configuration-number-range-deployment-20261004-r39.json)已按当前本地工具契约验证 4 组参数，未调用写工具。请求不释放、不导出、不导入；不修改 SAP 标准源码或现有标准业务配置。

## 验收范围及停止条件

1. 部署前复读对象不存在、请求可修改、DDIC、标准 API 指纹与实际锁；若对象已存在，不覆盖，由复核决定后续动作。
2. 每次创建后读取实际对象、接口和实现，检查诊断与激活；必要时按诊断最多进行有证据的针对性修正。源代码须符合 ECC 7.31。远程序列化和原生诊断未通过则不进入数据测试。
3. 只读两次，完整版本必须一致，NRIV 初始为空。验证哈希确定性、系统/客户端和完整定义。
4. 创建间隔 01：00000000000000000001—00000000000000000100，内部编号，NRLEVEL 保持 20 位零；完整回读和提交、清理状态必须一致。
5. 使用旧版本直接调用一次保存，预期 VERSION_CHANGED、无提交、完整现值不变。
6. 使用新版本将同一间隔上界改为 00000000000000000200；完整回读、零状态、标准会话清理和锁释放必须证明。
7. 同值保存一次，预期 NO_CHANGES、无提交。主机侧重叠间隔 02（150—300）、非法参数等必须在原生调用前拒绝。
8. 最大 4 次原生保存命令，其中最多 2 次有改值提交。出现未知结果、提交/清理失败、短 dump、非预期行或锁时停止继续写入，保留回执并只读对账，不自动重试。

测试后保留专用 NROB 与间隔 01（1—200）、零状态；不执行删除、状态重置或取号。号码范围定义与客户源码可录制到已授权 Workbench 请求；NRIV 间隔仍仅存在于 client 200，本阶段不实现跨系统迁移。

## 验收限制及自动规划的下一阶段

本阶段不能证明年度、子对象、分组、缓冲、已取号间隔、实际并发分配或 CTS 迁移可用；这些均拒绝或保持待开发，不放宽标准表写权限。

原生验收通过后，下一阶段将已实现的受保护回执与原生命令接入公开工具、结果对账、MCP schema、工具档案与生命周期登记，最小交付为上述受限保存能力经公开命令闭环；验收条件包含非法参数零 SAP 写调用、真实正常 / 版本变化 / 同值结果、锁与会话清理、未知结果禁止重试。仍需独立批准的业务或 SAP 写范围按实际具体方案确认。

之后按 backlog 继续 CFG-02 故障/并发矩阵、CFG-04 BC Set 激活事务与回读、CFG-03 复杂间隔及迁移、CFG-07 增强配置、CFG-08 业务域验收。完整 SPRO 尚未完成，不以本阶段替代领域业务触发验收。

## 授权边界来源

根目录 AGENTS.md 第 6 节要求："Modify only an explicitly approved `Z*` or `Y*` customer object in the current task." 第 10 节要求："Do not write business data merely to test unless the user explicitly authorizes it."

已有本地/只读测试授权和请求 GR2K923472 授权持续有效。本次新增客户对象及专用 NRIV 测试数据需要具体批准，不再重复请求一般开发或测试授权。
