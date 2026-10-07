# r72 BTE 产品启用：标准 API 与只读预览审阅

时间 2026-10-07T13:15:18.577+08:00；w200 / 200；**Partially Verified**（本地实现已完成，真实产品公开预览待验收，写适配器待实现）。

## 目标动作与契约

公开工具 preview_configuration_bte_product 只计算一个现有 Z/Y 客户产品的 AKTIV 变化，不包含产品注册、Event/Process 关联创建、函数源码生成或 handler 执行。输入 connectionId=w200、productName、active；可选 maxAssignmentsPerKind（2–200，默认 100）、expectedFingerprint（64 位小写十六进制）。不存在产品、越域、未知字段、布局/域/API 指纹不一致、非法标志、截断、重复键、读取期间变化和过期指纹均拒绝。不会产生保存 token 或授予 SAP 写入许可。

正例返回完整 TBE24 行和 Event / Process 关联，唯一允许的拟议字段为 TBE24-AKTIV；保留 RFCDS 及全部其他字段。所有结果均 readOnly=true、executable=false、writeAvailable=false、BTE_PRODUCT_WRITE_ADAPTER_PENDING。coverage 单独显示 handlerInterfacesInspected / effectiveExecutionOrderInspected / authorizedForWrite / runtimeInspected / atomicSnapshot 为 false。

## 实际字典与主键

| 对象 | 实际字段（顺序） | 实际主键 | 活动指纹 |
| --- | --- | --- | --- |
| TBE24 | MANDT, PRDKT, RFCDS, AKTIV | MANDT, PRDKT | c5a94543cc76c4f89574167a704d4f591377d1ad66e77d268c0e865719c22ec5 |
| TBE34 | MANDT, EVENT, PRDKT, LAND, APPLK, FUNCT, MONIT | MANDT, EVENT, PRDKT, LAND, APPLK | d86a1962b0c0c98d48d90a4f3632f4d77f6229eecc719d8643ea27d6f250ef20 |
| TPS34 | MANDT, PROCS, LAND, APPLK, FUNCT, PRDKT, MONIT | MANDT, PROCS, LAND, APPLK | 85f840b31746ccf8d31aa1a56f5c67c6833801833701e9858b07c78d546de30f |

CUSTP_BF 实际 CHAR 8、无转换出口；XFELD 实际 CHAR 1、固定 X / 空。原始活动域/数据元素定义与读回摘要留存证据。过程行 PRDKT 不是主键；事件键定义不能直接套用。产品启用会影响此产品的两种关联，必须以整个产品范围审阅。

## 标准路线证据与实际源码覆盖

FIBF → TSTC → SAPMOPFIIMG，实际读完整 1–46 行；17–34 行列出 BF11/BF12/BF21…BF44/BERE/BERP、AUTHORITY_CHECK_TCODE 和 CALL TRANSACTION。BF24/BF34/BF44 是参数事务，TSTC 程序为空；read_transaction_code 不返回 TSTCP-PARAM，通用白名单未开放 TSTCP。本阶段没有绕过白名单读取 PARAM。BFUS 源证据对应 BFUSER_TYP，不是客户产品维护所有者；不因名称相近而复用。

下表为实际 read_function_module_interface 回执提供的完整源码数组，范围同时留存接口。仅审阅这些源块，不把未展开的 FORM/函数组全局依赖也列为已确认。

| 函数 | 函数组 | 实际读取行覆盖 | RFC | 源码指纹 |
| --- | --- | --- | --- | --- |
| CRS_TBE31_MAINTAIN | CRMR | 1–200 | 是 | a174808e439ab2b49f170f24788622de67da334ed743108022204bb4f654aebc |
| BF_CHECK_PRODUCT_ACTIVE | ITSR | 1–22 | 否 | e1ef6ab958c630f5f811c3ac032c3c155aa3bacc7b174b2958b546b6a91ce9ec |
| BF_FUNCTIONS_FIND | ITSR | 1–96 | 否 | e48319fddea8c8c632a91dc05c63337e8943090a281df53e2d5b1c5d7c449799 |
| BF_FUNCTIONS_READ | ITSR | 1–61 | 否 | e22331c6ca427c1ea106988907988d1511fe99f7d9c43c7f996e01e9f235b387 |
| OPEN_FI_PERFORM_00000900_E | BFFM5 | 1–84 | 否 | 47ed442a4243f458621699144a9aeff2f7c6159f57a183bb706728fe938cfbd9 |
| VIEW_MAINTENANCE_NO_DIALOG | SVIM | 1–288 | 否 | aef8ff0659768c8c723583f7d084449063afc5980060f4c45b3c5641a499b861 |
| VIEW_MAINTENANCE_LOW_LEVEL | SVIM | 1–251 | 否 | 1aeb5c3d4610373e63188749eb9b77604a8fd8028945e5d405327e6f311be0a0 |
| VIEW_MAINTENANCE_GIVEN_DATA | SVIM | 1–831 | 否 | cad559f4208adaffb64a4b6dc96eb3cef3b26456f495f33f317176938b30c070 |
| VIEW_GET_DDIC_INFO | SVIX | 1–886 | 否 | 664862e585d40b9c861723e638889c498140dff3e6cac1ee005e534513c9210f |
| VIEWPROC_V_TBE34 | CACS_97 | 1–61 | 否 | 7fb656ed82c9d5a957177a51eaaff240d66358dcaa3c6248d72cda14c73a94a9 |

VIEW_MAINTENANCE_NO_DIALOG 的接口指纹 096a143263b04e39e651e1f42a8038df2193fca019eaf41b7e34d1829d72816b。113–199 行处理 IX_TO_MODIFY 和 TOTAL/EXTRACT 标志，157 行调用 VIEW_MAINTENANCE_LOW_LEVEL / EXED，201–211 行 SAVE 分支走生成维护路径。EXPORTS 包括 UPDATE_REQUIRED、RESULTS、LAST_LOGGED_MESSAGE；表含 CORR_KEYTAB(E071K)、DBA/DPL_SELLIST(VIMSELLIST)、TOTAL/EXTRACT、X_HEADER(VIMDESC)、X_NAMTAB(VIMNAMTAB)、IX_TO_MODIFY(VIMMODIX)。它不是 RFC，没有证实产品维护的 typed control blocks 和所有依赖，不能直接放进通用远程调用。

VIEW_MAINTENANCE_LOW_LEVEL 动态分派 VIEWPROC/TABLEPROC；VIEW_MAINTENANCE_GIVEN_DATA 包含 EDIT 对话路径；VIEW_GET_DDIC_INFO 构建状态/事件/维护元数据；VIEWPROC_V_TBE34 的 EDIT 调用 dynpro，SAVE 进入 PREPARE_SAVING / DB_UPD_V_TBE34 / AFTER_SAVING。这个已找到的事件关联维护函数不能证明产品 TBE24 的维护路线。生成函数名定向搜索结果不构成 API 不存在的证明。

CRS_TBE31_MAINTAIN 虽为 RFC，实际操作 SAP TBE31/CRM 并在内部 COMMIT，因此排除作为 TBE24/TBE34/TPS34 客户配置写 API。BF_CHECK_PRODUCT_ACTIVE 实际读伙伴 TBE23，不是产品启用写命令。BF_FUNCTIONS_READ 依赖函数组缓存；OPEN_FI_PERFORM_00000900_E 的 dispatcher 接口和实际 handler 调用字段也不能未经核对就当成目标 handler 接口契约。

事件 00000900 和过程 00001020 / 00001030 的实读均无客户 handler；这是限定查找结果，不是全系统客户产品目录。尚无实际客户产品正例；本地 ZDEMO 为测试占位标识，不建议直接注册到 SAP。

## 实现及拒绝验证

实现 src/configuration-bte-product.ts 对固定三表/双域/API 指纹两轮核对，两次读取行集一致后生成 before-state 指纹。行顺序不影响指纹；任一实际字段变化影响指纹。仅使用已有 reviewed-table-reader，HTML 空响应只允许已有钉住版本的 RFC_READ_TABLE 后备，不调用标准维护 API，不开放通用表白名单。固定上限时截断拒绝，而不是返回 complete 成功。

专用 9 项模型测试及 1 项 SDK/HTTP 契约测试，连同 tools/protocol/profile/registry 共 218 项，BC 460 项回归全部通过。实际 SAP 正例预览未执行，registry 保持 unverified；能力报告 UNKNOWN。详见开发记录与原始 checks。

## 写命令进入下一阶段的必要条件

1. 从真实产品维护元数据确认 table/view 和生成池，展开 product 路线、检查 TOTAL/EXTRACT/全局状态初始化及标准事件。不能用关联视图所有者冒充产品所有者。
2. 在 SAP 所有权点核对 AUTHORITY-CHECK、enqueue、锁内产品及完整关联重读、stale 指纹拒绝，禁止只靠 TypeScript before-state。
3. 明确标准维护与 CTS 的提交/更新任务所有权、实际键级 E071K 编码和失败回滚/对账/恢复。未证明前不可伪造原子性。
4. 客户桥接对象应提供独立命令边界和受控只读身份/状态接口；完整候选源、ABI、依赖、差异、请求任务及测试预算准备好后再请求具体部署审批。r72 没有新 SAP 对象部署授权。
5. 选定具体产品及全部共享关联，先只读有数据预览，之后按精确批准 before/after 做至多预算内写/读回/恢复；业务触发测试由业务方安排。

## 证据与范围

原始实时 schema、请求、完整返回及指纹：[orvanta-configuration-bte-product-20261007-131518-r72-evidence.json](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-product-20261007-131518-r72-evidence.json)。没有标准函数运行回执、产品写入回执或业务触发验收；不能将源码阅读或本地测试视为配置可执行。
