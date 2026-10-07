# r55：只读恢复转换检查器部署审阅

时间：2026-10-05T23:19:44.770+08:00（Asia/Shanghai）。状态 **Partially Verified**。本地候选及内部适配器已完成检查；新 SAP 对象未创建，不能称为可执行恢复或完整 SPRO。

## 拟议准确动作

仅在 w200 / GR2 / client 200 创建并激活客户 RFC **Z_ORVANTA_CFG_BC_RCHECK**，父组 **ZORVANTA_BC_CFG**、包 ZABAP，开发请求 **GR2K923472 / 任务 GR2K923492**。部署录入开发 CTS；只读检查配置请求429/任务430，不追加、删除或恢复配置 CTS，不激活/模拟 BC Set，不保存配置，不释放任何请求。

标准创建工具分配新函数 Include（现目录 U01–U06，预计 U07，以实际结果为准）并追加 UXX 目录项。TOP、主程序和六个已有函数正文/接口保持原源；不手改生成目录。创建前再次读取准确 URI、源/锁/归属和任务状态，完整备份六个旧函数、主程序、TOP、UXX；若存在未知草稿、并发漂移或新名字被占用，先停止该部署并核对，不覆盖他人改动。

23:01 附近的实际 MCP 读取确认：父组包 ZABAP、472/492 均开放 D、owner WYS；配置429/430均开放 D，430有2个对象。WYS/client200锁查询0条、hasMore=false，只代表当时该用户范围的观察，不能替代部署前全部目标冲突核对。六个当前函数与本地契约逐一核对通过；准确原文和接口摘要在 [证据](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-recovery-check-evidence-20261005-231944-r55.json)。

## 完整候选及接口

[完整 ABAP 候选](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-recovery-check-candidate-20261005-231944-r55.abap)（894 正文行、每行≤72字符）；[接口与十项标准依赖指纹](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-recovery-check-candidate-20261005-231944-r55.json)；候选文件 SHA256 **c30d69697469893a3362e154e3d8799ebb258426d18d03b4430c32c75dda2c61**；正文归一化摘要 **af0d8bdddf6317300b2d3e43869ba274e2ab40e46d75a9f4b12b1dbd817dfde5**。这些是本地文件，不是 SAP 已激活源。实际 ECC7.31 语法与运行尚未验证。

Import 12项均 STRING / VALUE：IV_BC_SET、IV_VERSION、IV_REQUEST、IV_TASK、IV_SOURCE_VERSION、IV_TARGET_VERSION、IV_CANDIDATE_VERSION、IV_METADATA_VERSION、IV_GUARD_VERSION、IV_CTS_VERSION、IV_STATE_VERSION、IV_DATA_BASE64。固定 EHS_CUNI_KNM/N、GR2/200、429/430，七项摘要小写64位；六个上游版本、STATE摘要和原生数据仅从服务端不可变前态引用加载。公开调用者只允许既有七字段命令请求，不能上传 DATA_BASE64 或覆盖用户/client/布局；本轮未注册新公开工具。Native RFC 自身接收 STRING 缓冲供内部适配器调用，不构成面向任意外部包的恢复服务。

Export 11项均 STRING / VALUE：EV_CODE、EV_SYSTEM、EV_CLIENT、EV_USER、EV_STATE_VERSION、EV_LAYOUT_VERSION、EV_ROW_COUNTS、EV_ROW_PROOFS、EV_PROOF_BASE64、EV_PROOF_VERSION、EV_ROUNDTRIP。无 TABLES、CHANGING、声明例外或 update-task。成功 RECOVERY_CHECK_OK 才发布完整身份、STATE/布局、九表计数、十九行摘要和 proof；失败仅 EV_CODE 非空。行证明格式 index|table|present(X或单空格)|beforeSHA256|afterSHA256；两个摘要必须相等。证明缓冲及摘要不包含恢复许可。

## 真实标准链及边界

SCPR_DB_TABLE_TABFLDDEF_GET 获取真实字段描述；SCPR_CT_VALUE_CONVERT_INT_EXT 生成标准 BC 值，SCPR_CPROF_CT_PROFDATA_CONVERT 还原同一 DDIC 行。当前可达转换依赖连同编码/哈希共十个标准函数源码/接口已从 w200 读取并固定；九表全字段及布局指纹也已新读核对。类型池 SCPR 的局部类型来自实际标准接口/TOP声明，不能将 READ_STRUCTURE 的 not-found 解释为标准类型不存在。候选接口不用类型池参数；[SAP 官方接口说明](https://help.sap.com/saphelp_autoid2007/helpdata/EN/d1/801ece454211d189710000e8322d00/content.htm?no_cache=true)所述 TOP 类型池要求针对接口类型，当前接口全为 STRING。局部声明的实际编译仍待诊断。

发现 SCPR_CT_VALUE_CONV_EXT_INT_STR 的部分数值转换以 OTHERS=0 吞掉异常；因此不以 sy-subrc=0 单独认定恢复值正确。候选将原行与重建行分别原生 EXPORT，逐字节不同即 ROUNDTRIP_LOSSY。授权03、缓冲≤524288字节、规范Base64、STATE摘要、导入后重导出、身份/版本/布局、单表最多1或3行、十九键及全部字段顺序均须满足。缺行只重建删除键，不执行删除；已有行检查全部字段。CURR/QUAN、未支持原生类型、异常描述或任何精度差异均拒绝，不回退 SQL。

直接调用图仅含描述/转换/编码/哈希；没有标准维护 LOAD、ACTIVATE、历史/日志保存、CTS、enqueue/dequeue、COMMIT/ROLLBACK、GUI或 SQL DML。元数据/转换内部的全部通用分支并未因此获得运行证明。内部适配器在调用前后核对本客户函数正文/接口、十项标准源/接口和九表DDIC；这仍不是锁内快照，也不证明当前配置等于前态，更不证明锁、提交、日志及 CTS 恢复。

## 拟议只读验收预算与验收条件

部署及激活仅上述客户函数与工具生成的成员，不改已有源。新固定独立实例最多 **2次正常 RCHECK、4次原生拒绝、4次本地/schema拒绝**；必要 STATE/预检/CTS/源与DDIC读取仍只读。两次正常调用使用固定服务端前态；核对十九行摘要、身份、计数、证明摘要和全部false执行标志。拒绝可选错任务、错版本/STATE摘要、缓冲损坏或身份不符，其他输出应为空；首次未知异常停止、保留原始结果，不盲重试。实际非零FLTP/极值/负零、初始D/T只有在原生样例覆盖时才能登记已测；当前本地合成测试不证明它们。

现有 AI 测试授权沿用；本次新增对象部署必须明确批准。通过新对象诊断、读回、激活、支持时ATC、原生只读调用并证明已有函数源/接口和配置/CTS无本阶段写入后，才能登记该检查器运行结果。没有真实 APPLY、RECOVER、配置改值、配置CTS追加/恢复、协议提交、分发或请求释放预算。

## 后续

[r56最小交付与累计缺口](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-recovery-check-and-standard-command-plan-20261005-231944-r56.md)。本检查器只关闭恢复值转换的一个前置问题；r55 原计划中的完整 APPLY/RECONCILE/RECOVER 桥仍未闭合。标准维护 owner 的业务锁、隐式释放、独立日志/分发提交和精确 CTS 补偿继续作为执行阻塞，不能因该只读检查通过而开放保存。
