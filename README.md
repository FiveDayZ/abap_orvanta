# ORVANTA - 独立 ABAP MCP 服务

ORVANTA 是独立 ABAP MCP 服务，默认 MCP 注册名为 `orvanta`。它不加载 VS Code、不启动 `Code.exe`，直接通过
`abap-adt-api 8.4.3` 访问 SAP ADT。

## 当前实施基线

2026-09-20 版本 `0.46.1` 在 `0.46.0` 基线上收口 D6-1（搜索帮助）并修复三项已确证缺陷。**D6-1 搜索帮助**：新增 `read_search_help` / `upsert_search_help`，`delete_ddic_object` 的 `objectType` 扩展 `SHLP`，DDIC 助手新增 `SHLP` 分支（`READ_SEARCH_HELP` / `UPSERT_SEARCH_HELP` / `DELETE_SEARCH_HELP`，协议 `1.8`，操作码与已部署助手逐字节一致）；闭环（创建→读取→激活→回读→删除）与负向验收（非 `Z*`/`Y*` 名、本地包、标准对象只读）均在 `w200` 实测通过。**缺陷①（描述截断）**：`IV_DESCRIPTION` 由 `LIKE TSTCT-TTEXT`（CHAR 36）改为引用类型 `DD04T-DDTEXT`（`AS4TEXT`，CHAR 60），45 字符描述实测完整往返。**N3（删除成功却报失败，共 10 次）**：`isNotFoundError()` 不认识 SAP 中文 `未找到对象` 这类 404 等价应答，导致"对象已不存在"这一正常终态被上报为失败；谓词补入该表述后，`delete_abap_source_object` 实测返回 `SOURCE_OBJECT_DELETED`。**N4（虚假成功）**：`RPY_FUNCTIONMODULE_UPDATE` 在 ECC 7.31 不存在，`patch_function_module_interface` 的助手分支实际**只写参数文档**；该工具响应改为如实报告 `interfaceWritePerformed: false` / `interfaceWriteSupported: false` / `parameterChangesApplied: false` 并给出平台限制说明，参数改动需人工 SE37 完成。**N5（陈旧索引）**：`search_abap_objects` 会持续列出已删除对象（三次独立复现，一条 >40 分钟仍在），且 `get_abap_object_info` 的字段值不具判别力——两个工具的描述均已显式标注**不得用于存在性判定**，判据须取对象自身的读取路径。工具面 129 项、只读 76 项。本版本已完成 `tsc` 构建与 738 项自动化测试（全部通过）及 4 项静态检查；SAP 运行时回归中，D6-1 闭环、N3、负向验收已实测，其余项仍由测试人员按人工优先规则完成。

2026-09-20 版本 `0.46.0` 把 `v0.45.0` 之后长期停留在工作树的改动冻结为可重建基线，并补齐助手能力自述（CAPABILITIES）协议的服务侧实现。**助手自述**：服务在能力报告中对每个助手单独探询其自述应答，并新增 `helperAttestation` 段（`minProtocol`/`maxProtocol`/操作码与 `since`/`sourceHash`/包与传输）；助手能力的可用性判定改为依据**自述的最高协议**而非单次读取探测，使"未部署"与"未探测"可区分——真实 `w200` 只读报告实测 6 个助手自述（基础助手 `2.7`、仓库助手 `2.6`、DDIC 助手 `1.7`、维护/运维/应用日志助手 `1.0`），能力报告中 `unknown` 由 40 项降到 31 项、`available` 由 13 项升到 22 项。SCI 助手的自述载体（`EV_RESULT` 单导出标量 + JSON 信封）生成器已就绪，但**尚未部署到任何 SAP 系统**。**函数模块写入**：新增 `write_function_module_source`（改写既有函数模块源码），`patch_function_module_interface` 改由基础助手的共享仓库操作码 `PATCH_FUNCTION_INTERFACE` 执行（原生 ADT 加锁路径在 `w200` 上以 HTTP 423 `invalid lock handle` 失败），并在助手写入后回读接口、比对请求、在拒绝时保留有界差异证据。**修复**：无域数据元素（如 `STRINGVAL`，`DD04L.DOMNAME` 为空）不再被当作域头使用，改为读取其自身活动 `DD04L` 行的 `DATATYPE/LENG/DECIMALS`；此前所有使用该元素的接口都以 `Unverified RFC scalar type` 失败并使 `executionSupport.supported=false`。工具面 127 项、只读 75 项，`docs/tool-index.md` 与 `contracts/tool-index.json` 已按注册表重新生成。本版本仅完成静态检查（`tsc` 构建通过）；自动化测试及 SAP 运行时回归**未由本次执行**，仍由测试人员按人工优先规则完成。

2026-09-17 版本 `0.45.0` 建立工具面治理基线：新增 `src/tool-registry.ts`作为全部126项工具的唯一事实源（分组、profile、路由、SAP助手依赖、最低助手协议、风险注解与边界说明），`toolContracts`在加载时统一合并注册表注解并与契约双向校验，任一方缺项即启动失败；此前83项没有任何注解的工具补齐只读/破坏性提示，只读工具由33项修正为75项，`docs/tool-index.md`和`contracts/tool-index.json`由 `npm run matrix:generate`生成、`npm run matrix:check`校验。新增启动期工具开关 `ABAP_MCP_TOOL_PROFILE`（`full`/`readonly`/`platform`/`dev`/`config`/`ops`，默认 `full`，与历史行为一致）与 `ABAP_MCP_TOOL_DENY`（在 profile 之上按名称去掉单个工具，名称不存在时启动失败）：被收窄的工具不出现在 `tools/list`，`tools/call`也被服务端以 `disabled`拒绝，`get_runtime_info`返回实际生效的 `toolProfile`，`get_capability_report`在存在被禁用工具时返回 `toolProfile.disabledToolCount`及各能力的 `disabledToolNames`。同时把 `test/settings.test.ts`中写死的121项工具数改为由注册表推导，并新增 `docs/helper-capabilities-protocol.md`说明助手能力自述（CAPABILITIES）协议设计稿。本版本仅完成静态检查和候选包构建，自动化测试及SAP运行时回归仍由测试人员执行。（该设计稿的"未实现、未部署"表述已于 2026-09-18 失效、并由 0.46.0 条目取代：服务侧与 6 个助手随后落地，详见上一条与 `docs/helper-capabilities-protocol.md` §0。）

2026-09-17 版本 `0.44.1` 为既有 `read_abap_table(SXCI, ...)` 诊断调用增加显式Classic BAdI仓库兼容投影：固定返回 `EXIT_NAME/IMP_NAME/CLASS_NAME/INTER_NAME`，复用 `read_classic_badi_definition` 的定义、实现及类映射结果，并以 `compatibilityProjection=true`、`tableClassVerified=false` 和 `method=classic_badi_repository_helper` 明确说明它不是物理DDIC表读取；无精确 `EXIT_NAME` 筛选时按 `maxRows + 1` 有界发现并如实标记 `truncated`。其他确认不存在的DDIC名称仍保持 `TABLE_QUERY_TABLE_NOT_FOUND`，不恢复不可靠的RFC伪表降级。本版本仅完成静态检查和候选包构建，自动化及运行时回归仍由测试人员执行。

2026-09-17 版本 `0.43.5` 修正第六批第四轮反馈中的错误归因：`SXCI/XI`是Classic BAdI实现的ADT仓库对象子类型，不是DDIC表名。`read_abap_table`在DDIC明确返回对象不存在时，现在稳定返回`TABLE_QUERY_TABLE_NOT_FOUND`并停止，不再误入`RFC_READ_TABLE`或aligned-reader降级；工具描述和表查询文档同步指向`search_badi_objects`及`read_classic_badi_definition`。本版本仅完成静态检查和候选包构建，自动化及运行时回归仍由测试人员执行。

2026-09-17 版本 `0.43.4` 将SAP Helper升级流程改为显式接收传输请求号：写入前核对可修改Workbench请求和当前用户任务，登记`ZORVANTA_MCP_CORE`函数组及`ZCL_ORVANTA_MCP_CORE`类后再执行升级，并对请求号、任务和Helper状态执行回读校验。新请求中尚未包含既有Dynpro/UI对象仅作为信息回执，不再错误阻断Helper升级。该流程已在w200/200使用请求`GR2K923472`、任务`GR2K923473`完成部署回读；VL02N及SXCI功能回归仍由测试人员执行。

2026-09-17 版本 `0.43.3` 针对第六批复测结果补齐两项：标准事务读取能力明确要求仓库助手1.2并随包提供升级源码；DDIC端点不可用且旧`RFC_READ_TABLE`无法提供完整布局元数据或明确返回`DATA_BUFFER_EXCEEDED`时，改用单独固定指纹的`BBP_RFC_READ_TABLE`尝试一次元数据、数据及二次元数据核对，权限失败不重试、对齐读器失败后关闭。`search_badi_objects`错误提示明确列出四种合法子类型，`inspect_source_enhancements`标注ECC 7.31元数据端点限制。便携包不会自动部署或修改SAP；回归前须由获授权人员执行助手`upgrade`。自动测试和真实SAP验收仍需单独完成。

2026-09-17 版本 `0.43.2` 修正0.43.1复测剩余问题：仓库助手将标准事务只读从Z/Y客户事务写入保护中分离；DDIC端点不可用且旧`RFC_READ_TABLE`完整布局检查明确返回`DATA_BUFFER_EXCEEDED`时，改用单独固定指纹的`BBP_RFC_READ_TABLE`完成元数据、数据及二次元数据核对，其他RFC故障不自动重试。候选包包含更新后的助手升级脚本，但不会自动部署或修改SAP；自动测试和真实SAP验收仍需单独完成。

2026-09-17 版本 `0.43.1` 汇总第五批只读检查修复。真实复测确认ENHO/XH空源码语义、Customer Exit include覆盖及未请求屏幕状态已经生效；标准事务仍被已部署仓库助手的Z/Y写入保护误拦截，SXCI则在DDIC降级后的旧RFC整表元数据预检返回故障。自动测试和真实SAP验收必须与版本号及候选包分别记录。

2026-09-17 版本 `0.42.3` 在 0.42.2 基础上修复 ECC 7.31 已有待激活版本时的单对象激活载荷，并区分写前证据中的活动源与待激活源。SAP仓库助手协议为`2.6`。本版本按脏工作树生成候选包；助手部署、自动测试和真实业务验收必须分别记录，不能由版本号或打包成功替代。

2026-09-15 版本 `0.41.1` 修复 ECC 7.31 Include 激活兼容路径：从 SAP 返回的主程序关系解析激活上下文，严格区分非活动源存在、确认不存在和状态不可用；保存后激活异常会保留阶段结果与源码指纹，禁止自动重放替换；激活成功还需活动源码读回一致。该版本同时包含 `0.41.0` 的 DDIC 助手协议 `1.7` 与透明表复杂组件、技术设置和转换恢复能力。未完成的 SAP 运行验证仍不能由源码、构建或发布结果替代。

2026-09-14 当前源码的基础、仓库、DDIC、查询及 SCI 助手入口已切换为 `Z_ORVANTA_MCP_*`，使用函数组 `ZORVANTA_MCP_CORE` 和类 `ZCL_ORVANTA_MCP_CORE`。安装脚本、探针和当前测试断言同步更新，SCI 保留完整指纹校验；旧 SAP 对象及已有发布包不删除、不覆盖，也不自动回退调用旧助手。修改源码不等于当前运行服务已切换，新入口的人工测试及运行包部署仍需完成。具体迁移约束见 [SCI 命名迁移](docs/sci-compatibility.md#namespace-migration-2026-09-14)。

2026-09-14 新增 SMARTFORMS 读取、创建、保存、激活的本地候选接入与 SAP 辅助代码。三个辅助对象已在 w200/200 的 ZABAP 包创建、激活并通过语法与接口回读核对；请求 GR2K923421、任务 GR2K923422。运行服务已更新为0.40.1 BOM修正候选，14项本地测试及两个标准表单6次只读调用通过；已获授权并完成 ZORVANTA_SF_TEST 在 ZABAP 的创建、保存、激活、草稿隔离与过期指纹/重复创建拒绝验证；ATC及故障恢复边界仍有缺口。接口、部署对象及验收步骤见[SMARTFORMS 接入说明](../.doc/orvanta-smartforms-mcp-20260914.md)（工作区文档，不随便携包交付）。

2026-09-11第三批候选版本 `0.36.36` 静态注册91个工具，在类型检查基础上增加TPMODE域固定值校验，允许S、E和有DDIC依据的空值。新增源码已由用户完成471项回归及9项入口检查，真实域值验收待完成。validation改为structural_and_domain，完整业务校验未验证、保存关闭。此前类型预览、Unit和有限SCI证据分别保留。当前交付边界见 [第三批候选版](docs/mvp-batch3-candidate.md)。

- MVP-01：保留0.36.30完整行修正，补充空值/零值回归及候选指纹校验；真实550值验收仍待完成。
- MVP-02：RFC标量、结构及表字段共享DDIC值约束；异常名准确匹配，接口补丁增加锁内完整源码指纹；四方向及异常本地回归已通过，真实SAP待验。
- MVP-03：新增只读 `preview_source_changes`；已有写工具增加可选 `expectedSourceFingerprint`，锁内复核。
- MVP-08：新增只读 `get_runtime_info` 和运行产物/恢复清单核对入口；不自动探测SAP、切换服务或回滚业务。
- MVP-05/06：新增 `search_sap_locks`、`search_failed_updates`、`read_failed_update` 客户端接入及只读助手候选，默认关闭；不执行SAP解锁、更新重处理或删除。详见[只读维护诊断契约](docs/maintenance-diagnostics.md)。

以下是0.36.28已保存的阶段证据，不能作为0.36.31验收结果：

- M1-M4：原约定的限定范围已有验收证据，不代表所有SAP路径通过。
- M5：日志核心15项、英文原生对照7组及程序过滤2组已通过；特殊样本延期、受限身份移出本轮门禁，整体证据仍为Partially Verified。
- M6：系统信息、有界单表查询、语法检查和限定SCI范围已验；原生ATC已批准延期，引用分析及真实调试尚未完成。
- M7/M8：0.36.28限定集成与候选包已有人工通过报告；真实SAP恢复及跨环境仍是独立门禁。Git HEAD仍为0.34.0，候选来自累积工作树，不是仅凭HEAD可重建的发布基线。

完整阶段、延期决定、证据及下一步见工作区[全局实施基线](../.doc/global-implementation-baseline.md)。该链接指向源码工作区记录，不是便携包内文件；包内能力说明见[工具矩阵](docs/tool-compatibility-matrix.md)和[日志契约](docs/diagnostic-suite.md)。

## 历史里程碑

以下版本章节保留各自实施时点的结果及限制，不是当前运行状态。旧条目的“待部署”“尚未验收”由上方基线及对应新证据解释，不反向改写历史失败。当前统一编号为M6.4引用分析、M6.5真实调试；历史 `m64-*` 调试证据保留名称。

## 2026-09-08 日志正文验收（历史）

当时修复SM37八参数正文渲染、SM21空尾槽误判，完成223项本地测试及15项真实检查。后续已补齐限定英文原生对照、程序过滤，并完成231项本地测试及修正后15项真实回归。ZCA/606仍为已确认缺失定义负例，不伪造正文；特殊样本延期。可在服务及样本满足前置条件时运行 `node scripts/probe-log-body-acceptance.mjs`，不要因复盘重复执行已有通过项。详见[日志套件](docs/diagnostic-suite.md)。

## 0.36.12 日志套件（实施中）

新增作业检索、作业日志、系统日志及跨日志关联的本地接入。SLG1消息路径和新的SAP助手尚未完成，不据此宣称四阶段已交付。本阶段不逐版本切换，全部实施后统一测试。见 [整批实施状态与契约](docs/diagnostic-suite.md)。

## 0.36.11 SLG1 有界样本发现

新增 `discover_application_logs`，最多返回20条已有日志头引用，仅含日志号、对象、子对象和SAP本地时间。按日志号降序抽样，不代表按时间最新或完整清单。保留跨对象显示权限、逐行权限和BAdI保守拒绝，原搜索仍要求精确对象及不超过24小时。SAP分支已部署，新增工具的真实非空验收须在新版服务启动后完成。

## 0.36.10 SLG1 首批部署与兼容修正

`search_application_logs`、`read_application_log` 提供分页、范围校验和管理员批准门禁。w200 已部署首批只读日志头助手，消息详情仍关闭。0.36.10 修正 SOAP 数字实体解码及源码替换中的字面量美元符号；没有批准记录时明确返回不可用。现有日志对照和新版服务端到端验收仍待完成，不自动切换当前服务。见 [SLG1 实施与部署门禁](docs/application-logs.md)。

## 0.36.8 RFC 宽结构兼容

RFC 测试与白名单调用的平面结构、表行字段上限统一由 100 提升为 500，覆盖 DDIC 能力分析、输入、预期输出及实际输出。110 字段抬头不再因旧字段数量上限被拒绝；未知字段、深层结构、表行数、单值和报文大小限制保持不变。真实业务 RFC 仍需按其接口与授权独立验收。

## 0.36.7 ST22 结构化诊断

新增 `diagnose_sap_failure`：只读解析错误分析、调用栈和位置，支持程序、用户、SAP 本地时间过滤和重复错误分组。可依据已有操作回执及显式 SAP 时区生成时间关联候选，不认定根因、不自动修改或重试。原 `analyze_abap_dumps` 保持兼容；SLG1、SM21、SM37 尚未交付。详见 [M5 运行诊断](docs/runtime-diagnostics.md)。

## 0.36.6 SCI 受限检查

新增独立工具 `run_sci_analysis`，通过已部署且源码指纹匹配的 `Z_CODEX_MCP_SCI_API` 执行无头 SCI 检查。首轮仅允许函数组 `ZCODEX_MCP_CORE`，检查语法与危险语句，不运行 ABAP Unit，不将结果标为 ATC 通过。`precheck` 只读取 DEFAULT 变式配置；`run` 使用独立的两规则匿名检查。原生 `run_atc_analysis` 既有动作不变。详见 [SCI 兼容说明](docs/sci-compatibility.md)。

M6.3 的 `check_quality` 已完成双对象语法诊断和边界拒绝的真实验收。0.36.19 已部署，GET-only `precheck_atc` 确认 W200 的 ATC 配置端点返回 404，未创建工作清单或运行；WebGUI 亦提示不存在事务 ATC。工作清单 ID 修正路径仍缺原生执行正例，不以固定范围 SCI 替代原生 ATC，不自动评定质量门禁通过。详见 [质量检查说明](docs/quality-checks.md)。

引用分析 0.36.20 已部署，真实 W200 验收确认精确 URI 和类型名称补查定位一致，五类无效输入均拒绝；原生引用仍返回 404。候选版 0.36.21 修正原生请求中的工作区 URI 和第 0 列坐标丢失问题，尚待部署验证其对 W200 的实际影响。不能把 404 当作无引用。详见 [引用分析说明](docs/where-used.md)。

## 0.36.2 RFC 兼容补丁

新增平面透明表作为 RFC 结构、TABLES 行类型及 DDIC 表类型行类型的解析。函数长源码读取配套仓库助手 2.1，使用受协商的分段协议还原最长 255 字符源码行；不会截断源码或绕过权限错误。此补丁不解决 SAP 调试端点 404，也不扩展长源码函数的接口写入能力。升级步骤和限制见 [RFC 兼容说明](docs/rfc-compatibility.md)。

## 0.35.0 MVP 验收边界

2026-09-07 的 M1–M3 已在 `w200/200` 验证函数导入参数新增、重命名、修改和删除、源码维护/激活/诊断、CHAR20 RFC 正反例、正式白名单调用和重复提交保护，临时对象最终清理完成。完整本地回归为114项；实际进程崩溃、连接丢失和12路并发使用Mock SAP后端，不是对真实SAP事务的中断测试。

M4提供同版本Windows便携包、构建来源和逐文件SHA-256清单，排除编译后的测试程序。`BUILD-INFO.json`中的 `standaloneSourceCommit`和 `standaloneSourceDirty`描述独立仓库，原 `sourceBaseline*`仅描述历史扩展基线。清单覆盖依赖目录之外的交付文件，依赖由锁文件固定；校验用于完整性检查，不等同于发布者签名。构建默认拒绝覆盖已有同版本产物，审查后可显式传入 `scripts/package-windows.ps1 -ReplaceExisting`。

75个工具注册不等于全部真实SAP路径通过：其他参数类别的接口补丁、复杂RFC边界、真实SAP并发与中断恢复仍需单独验收；当前系统ATC、where-used和调试端点的缺口保留。此前出现的ADT响应头异常及一次只读 `socket hang up`尚未定位根因。详细能力及升级边界见下列文档。

## 已实现工具

- `get_connected_systems`
- `get_capability_report`
- `get_runtime_info`
- `preview_source_changes`
- `search_sap_locks`
- `search_failed_updates`
- `read_failed_update`
- `abap_debug_session`
- `abap_debug_breakpoint`
- `abap_debug_status`
- `abap_debug_stack`
- `abap_debug_variable`
- `abap_debug_step`
- `sap_helper_status`
- `read_function_module_interface`
- `test_remote_function_module`
- `invoke_customer_function_module`
- `get_customer_function_call_status`
- `get_write_operation_status`
- `list_write_recovery_operations`
- `release_write_operation_lock`
- `create_function_module_with_interface`
- `patch_function_module_interface`
- `inspect_repository_assignment`
- `read_abap_screen`
- `upsert_abap_screen`
- `patch_abap_screen`
- `validate_dynpro_application`
- `read_abap_gui_definition`
- `patch_abap_gui_definition`
- `create_module_pool`
- `delete_module_pool`
- `read_transaction_code`
- `create_transaction_code`
- `delete_transaction_code`
- `create_report_transaction`
- `read_abap_message_class`
- `create_abap_message_class`
- `update_abap_message_class`
- `delete_abap_message_class`
- `read_ddic_domain`
- `upsert_ddic_domain`
- `read_ddic_data_element`
- `upsert_ddic_data_element`
- `read_ddic_structure`
- `upsert_ddic_structure`
- `read_ddic_transparent_table`
- `create_ddic_transparent_table`
- `append_ddic_transparent_table_fields`
- `patch_ddic_transparent_table_fields`
- `read_ddic_table_type`
- `upsert_ddic_table_type`
- `delete_ddic_object`
- `search_abap_objects`
- `get_abap_object_info`
- `get_abap_object_lines`
- `get_batch_lines`
- `get_object_by_uri`
- `search_abap_object_lines`
- `inspect_source_enhancements`
- `search_enhancement_objects`
- `search_customer_exit_objects`
- `read_customer_exit_definition`
- `read_customer_exit_project`
- `inspect_customer_function_exits`
- `inspect_customer_screen_menu_exits`
- `search_bte_dispatchers`
- `read_bte_configuration`
- `prepare_enhancement_configuration_workflow`
- `search_badi_objects`
- `read_classic_badi_definition`
- `inspect_enhancement_framework`
- `inspect_fico_rule_exit_program`
- `get_abap_object_workspace_uri`
- `get_abap_object_url`
- `find_where_used`
- `get_sap_system_info`
- `get_version_history`
- `get_abap_diagnostics`
- `get_abap_sql_syntax`
- `execute_data_query`
- `read_abap_table` (bounded structured single-table queries; see [scope and legacy limits](docs/table-query.md))
- `run_atc_analysis`
- `run_sci_analysis`
- `run_unit_tests`
- `analyze_abap_dumps`
- `diagnose_sap_failure`
- `search_application_logs`
- `discover_application_logs`
- `read_application_log`
- `search_background_jobs`
- `read_background_job_log`
- `read_system_logs`
- `correlate_sap_logs`
- `analyze_abap_traces`
- `manage_transport_requests`
- `cleanup_transport_entries`
- `abap_download`
- `adt_discovery_export`
- `replace_string_in_abap_object`
- `abap_activate`
- `create_object_programmatically`
- `delete_abap_source_object`
- `create_test_include`
- `manage_text_elements`

详细兼容边界见 `docs/tool-compatibility-matrix.md`。

第二阶段已经移植 DDIC 表、结构、表类型、数据元素和域的查询回退，以及 Enhancement 元数据读取。`inspect_source_enhancements`将原生ADT实现元数据与源码中的事实标记分开返回，并把不支持、无权限、超时和其他错误与真正的空结果区分。`search_enhancement_objects`分别搜索 `ENHC/ENHS/ENHO/BADI/BADII`，`search_customer_exit_objects`分别搜索 `SMOD/CMOD`，均保留每种仓库类型的独立可用状态。`inspect_customer_function_exits`遍历指定主程序的有界静态include图，将三位静态 `CALL CUSTOMER-FUNCTION` 调用关联到精确 `EXIT_<程序>_<编号>` 函数，并在函数源码可读时提取 `ZX*` 实现include；动态操作数会独立保留。`search_bte_dispatchers`按标准命名分别搜索Event与Process调度函数，并从精确函数名提取数字或字母数字标识符。`search_badi_objects`进一步使用 `SXSD/XD`、`SXCI/XI`、`ENHS/XS`、`ENHO/XHB` 精确子类型，分开Classic定义、Classic实现、Enhancement Spot容器和New BAdI实现；Spot结果本身不证明其中存在New BAdI定义。`inspect_enhancement_framework`结构化返回显式Point/Section、实现语句，以及源码和FORM/Method/Function/Module首尾推导出的隐式候选；候选仍须在SAP增强编辑器确认。`inspect_fico_rule_exit_program`关联FI校验/替代出口程序中 `GET_EXIT_TITLES` 的目录声明和实际 `FORM`，保留缺失实现及未声明实现。上述搜索与静态检查工具不读取Customer Exit项目激活、Screen/Menu Exit配置、BTE配置、BAdI接口/过滤器/Multiple Use/开关/激活，也不读取GGB0/GGB1规则、OB28/OBBH激活或运行时执行。现已补充Mock回归用例但尚未执行，真实ECC 7.31仍需人工验证。

`inspect_customer_screen_menu_exits`可读取调用方明确列出的活动屏幕Flow Logic，提取 `CALL CUSTOMER-SUBSCREEN` 区域，并可读取活动GUI定义中以 `+` 开头的Menu Exit功能码及其引用位置。屏幕与GUI读取分别保留失败状态；结果只证明仓库钩子存在，不证明SMOD组件归属、CMOD项目分配或激活、客户子屏幕实现、菜单文本生效或运行时执行。

前一段“上述工具”的限制仅指原有搜索与静态检查工具。`read_customer_exit_definition`精确读取SMOD定义及MODSAP组件；`read_customer_exit_project`精确读取CMOD项目的原始MODATTR状态和MODACT增强分配。原始组件类型码和项目状态码会保留，不猜测目标版本中的状态含义。SAP助手对标准程序的 `READ_SCREEN` 与 `READ_GUI_DEFINITION` 只读请求不再套用Z/Y写保护；对应写操作仍只允许Z/Y客户程序。新增配置读取依赖尚未部署的助手 `2.2`。

`read_bte_configuration`按明确的Event或Process标识符读取定义、SAP应用处理函数分配、客户产品处理函数分配，以及TBE11/TBE24提供的原始激活字段。它不会执行处理函数、推断处理顺序、验证函数存在性或修改FIBF配置；该能力依赖尚未部署的SAP仓库助手 `2.3`。

`read_classic_badi_definition`按精确名称读取Classic BAdI定义、接口、过滤器类型、Multiple Use原始标志、实现分配、过滤值、实现类和实现激活原始值。它不读取New BAdI内部定义、Enhancement Framework开关或运行时调用；该能力依赖尚未部署的SAP仓库助手 `2.4`。

`inspect_source_enhancements`现在保留ADT活动增强端点返回的实现类型与版本、元素ID与完整名、模式、替换标志、精确行列位置URI及被增强对象，并分开统计实现数和元素数。这只证明指定基础源码对象上的活动代码插件元素，不等于New BAdI定义、Filter、Switch或运行时执行已验证。

仓库助手 `2.6` 补齐可自动化的增强开发生命周期：`read_enhancement_implementation`读取ENHO活动、非活动、已保存非活动、未保存非活动状态，以及包、Hook/New BAdI元数据、过滤器和逐Hook源码；`create_enhancement_hook_implementation`与`create_new_badi_implementation`创建并激活实现；`update_enhancement_hook_implementation`按`extId`替换单个Hook源码；`update_new_badi_implementation`更新New BAdI实现类、过滤器、默认标志、活动标志和文本；`manage_enhancement_implementation_state`激活或丢弃ENHO非活动版本；`delete_enhancement_implementation`执行受保护删除；`manage_classic_badi_implementation`通过SAP标准SXO API创建、激活、停用或删除Classic BAdI实现。所有写操作仅允许Z/Y对象，要求当前指纹、现有包和传输，不创建或释放传输，也不直接更新SAP标准配置表。更新操作遇到已有非活动ENHO版本时会拒绝覆盖。Classic BAdI创建的 `methods[].source` 是SXO API要求的完整展开方法实现，不是省略 `METHOD/ENDMETHOD` 的方法体。

"完整增强开发版"指增强发现、实现对象开发和可验证的安全生命周期已覆盖，并不把SAP配置事务或带界面的标准入口伪装成无界面API：User Exit标准Include仍不自动修改；CMOD项目、FIBF产品与处理函数分配、GGB0/GGB1规则及OB28/OBBH激活均由人工执行。`prepare_enhancement_configuration_workflow`为这三类配置提供统一只读预检和受控人工流程：复用CMOD/BTE精确读回及可选FI出口程序检查，列出缺失输入、事务步骤、包/传输要求、保存与激活确认点、停止条件、写后读回和业务验收证据；它不会打开GUI、保存、激活、生成规则、执行业务事务或释放传输。

2026-09-16在`w200`的只读接口核对中，`MOD_KUN_ACTIVATE`属于CMOD内部激活/停用入口，但不能完整承担项目创建和增强分配；`BF_FUNCTIONS_READ`与`BF_FUNCTIONS_FIND`只读取BTE处理函数；发现的`G_BOOL_*`与`G_VSR_*`接口用于规则读取、检查、运行、模拟或传输，未形成涵盖GGB0/GGB1编辑及OB28/OBBH激活的稳定无屏幕维护API。因此本版本没有把这些局部或事务内部函数包装为配置写入API，也不直接更新`MOD*`、`TBE*`、`TPS*`或FI规则配置表。

ECC 7.31未确认公开的无界面ENHO停用API，因此ENHO状态管理只提供激活和`discard_inactive`；Classic BAdI过滤器更新依赖会打开SE19屏幕的标准更新入口，当前不自动执行，类源码可继续通过现有源码工具维护。Customer Exit的ZX Include、子屏幕和菜单对象，BTE处理函数以及FI出口程序可继续使用现有Z/Y源码、函数模块、Dynpro和GUI工具开发。助手 `2.6` 当前仅在本地源码中完成，尚未部署或在真实ECC执行写入验收。

## 本地验证

```powershell
npm install
npm run extract:baseline
npm run verify
```

## Windows便携包

0.40.4 Windows 便携包新增一键更新入口。Release 和 Windows 资产统一按 `orvanta-mcp-<版本号>`命名，便携 ZIP 使用 `orvanta-mcp-<版本号>-win-x64.zip`。先停止 MCP 服务并关闭配置中心，再双击 `update.cmd`；更新器从 [GitHub Releases](https://github.com/FiveDayZ/abap_orvanta/releases) 获取最新稳定版 Windows x64 包，校验 SHA-256、版本、平台和包内文件清单后替换程序文件。它保留 `connections.json`、`exports` 以及便携目录外的操作状态和回执；检测到 ORVANTA 仍在运行时拒绝覆盖，替换失败时恢复原版本。自动更新不安装或升级 SAP 助手，不修改 SAP 对象、业务数据或传输。GitHub Release 的 SHA-256 用于下载完整性校验，不等同于发布者数字签名。

配置中心采用 SAP 蓝色工作台布局，左侧可勾选本次启用的连接，并逐条删除本地连接。只启用 W200 时，只要求 W200 的本次密码；W300/W800 可继续保留且不参与启动。运行中的连接不可修改或删除，未启用的连接仍可管理。右上角使用 GitHub 官方 Octicon 提供 ORVANTA 仓库入口。

解压整个ZIP后，双击 `open-settings.cmd`，在浏览器中管理SAP连接、输入本次密码、测试ADT与基础助手、启动或停止本界面管理的MCP服务，并复制客户端接入配置。这个入口使用Windows自带PowerShell启动包内Node，不要求用户安装Node或PowerShell 7；旧版脚本入口仍按原要求保留，命令行启动不使用网页中的本次勾选。

配置中心仅监听 `127.0.0.1`，每次打开使用独立会话令牌。密码只保存在当前进程内存，不写入文件或浏览器存储；停止MCP后可在界面选择“关闭”清除密码并退出配置中心。仅关闭浏览器标签页不会停止后台服务。现有端口被占用时会拒绝启动，不会停止其他进程；有工具仍在执行时拒绝通过界面停止。配置保存期间检测旧版本与并发编辑，异常配置文件不会被覆盖。

这个界面不执行SAP助手安装/升级，不修改业务数据，不自动改写Agent配置。连接测试分别报告ADT和基础助手状态，不代表仓库/DDIC助手全量验收。升级仍须保留操作凭证目录；不要混用旧、新进程共享状态。客户端没有MCP配置入口时，仍需要管理员协助接入。

使用 PowerShell 7 构建包含官方 Node.js `24.8.0` 运行时的独立 Windows x64 压缩包：

```powershell
npm run verify:release
```

产物生成在 `release/`。目标电脑不需要安装 Node.js、VS Code或 Code OSS。压缩包已经包含脱敏的 `w200`连接模板，用户需填写自己的 SAP 地址和用户名；便携包使用精简 README，不携带源码仓库中的开发历史或测试记录。0.28.0首次使用可直接运行 `setup.ps1`：它使用一次安全密码依次完成SAP助手预检、Codex MCP注册和服务启动。只使用其他Agent客户端时增加 `-SkipCodex`。如果预检报告助手缺失，先运行 `install-sap-helper.ps1 -Mode install`，再重新执行 `setup.ps1`。

```powershell
.\setup.ps1
.\setup.ps1 -ForceCodex
.\setup.ps1 -SkipCodex
```

`setup.ps1`不会自动安装、升级或修复SAP助手，避免首次启动隐式修改SAP。服务运行期间保持该PowerShell 7窗口打开；关闭窗口即停止服务。后续不需要重复注册和预检时，直接运行 `start.ps1`。如果密码环境变量尚未设置，启动器会在当前终端安全提示输入，密码不会写入配置文件；不使用PowerShell时也可以先设置环境变量再运行 `start.cmd`。

Agent客户端配置见 `docs/agent-client-setup.md`。
便携包中的 `configure-codex.ps1` 可以用独立名称注册或移除 Codex MCP配置，不会修改现有 `abap_fs` 条目。
Codex CLI `0.92.0` 已实际调用便携服务的 MCP工具；Codex桌面端仍需在注册后重新加载配置。

## 连接配置

便携目录根部的 `connections.json`是实际生效的连接配置，默认包含当前 `w200`。可以直接修改 `id`、`url`、`client`、`language`、`username`、`passwordEnv`和 `allowUnauthorized`。`remoteFunctionAllowlist`是允许正式调用的客户RFC准确名称数组，默认空数组；只接受 `Z*`或 `Y*`且不支持通配符。密码从 `passwordEnv`指定的环境变量读取，不允许增加 `password`字段。

客户RFC调用凭证和0.28.0统一写操作凭证不写入便携目录，默认保存在当前Windows用户的 `%LOCALAPPDATA%\ABAP MCP Standalone\state`。需要调整位置时，在启动服务前设置 `ABAP_MCP_STATE_DIR`为独立可写目录；不要让多个不受信任用户共享同一个状态目录。

工具范围可以在启动前用环境变量收窄，默认 `full`，即与历史行为一致地暴露全部工具：

- `ABAP_MCP_TOOL_PROFILE`：取 `full`、`readonly`、`platform`、`dev`、`config`、`ops`之一。`readonly`只暴露标注为只读的工具（当前75项）；被收窄的工具既不出现在 `tools/list`，`tools/call`也会被服务端以 `Tool <name> disabled`拒绝，而不是仅从清单隐藏。
- `ABAP_MCP_TOOL_DENY`：在所选 profile 之上按名称去掉单个工具，用逗号、分号或空白分隔。名称不存在时服务启动直接失败，避免拼写错误让开关静默失效。

实际生效的 profile 与启用/禁用数量见 `get_runtime_info.toolProfile`；存在被禁用工具时，`get_capability_report`额外返回 `toolProfile.disabledToolCount`，并把受影响能力中不可调用的工具列在 `disabledToolNames`。工具清单由 `src/tool-registry.ts`单一维护，`npm run matrix:generate`生成 `docs/tool-index.md`。

下次启动：

```powershell
cd C:\My\Workplace\Coding\vscode-abap\abap-mcp-standalone\release\abap-mcp-standalone-0.36.28-win-x64
.\start.ps1
```

看到 `Password for <用户名>@<连接ID>:` 后输入SAP密码并按回车，保持该窗口打开。健康检查为 `http://127.0.0.1:4847/health`。

在新的Codex任务中可以直接要求：

```text
使用 orvanta MCP，先调用 get_connected_systems，然后在 w200 搜索 ZWMSTCTD01_FRM，并读取第1至20行。只读，不修改SAP对象。
```

当前源码静态注册127个工具，具体已验范围见上方当前基线。`get_capability_report`对指定连接执行有界只读探测，分别报告本地实现、已验证的原生ADT、SAP助手后备、不支持端点和无法在无目标条件下确认的能力；工具已注册或Discovery已公布不会被直接当作可用证明。`execute_data_query`只接受单条只读 `SELECT`，强制 `internal`模式、`rowRange`和1000行上限，不表示W200原生自由查询已恢复；`read_abap_table`是独立的结构化单表入口，最多500行。ATC不自动修复，ABAP Unit不自动激活，Dump和Trace只读取已有诊断数据。`abap_download`可将对象或包递归导出到显式绝对路径，默认拒绝覆盖现有目标；`adt_discovery_export`将四个Markdown文件写入便携目录的 `exports`。`manage_transport_requests`保留原工具的四个查询动作，用于读取用户传输、明细、对象清单和差异，不会创建、修改、删除或释放传输。`cleanup_transport_entries`是独立写工具，只允许从一个可修改任务中移除调用方明确列出的1至20条CTS对象记录；要求完整清单指纹、位置、操作ID和确认值，写后回读证明目标消失且其他条目未变化，不删除仓库对象，也不删除或释放请求。

### 功能演进记录

以下描述各版本当时的实现、测试与限制；历史字段上限、接口范围和环境状态不替代当前契约或最新证据。

0.16.0新增无头ABAP用户调试工具，支持会话、Z/Y源码断点、调用栈、只读变量、单步和继续。只允许当前连接用户，不支持终端模式、变量写入或跳转行。本地Mock和MCP协议回归已覆盖调试流程；当时真实W200监听请求返回HTTP404。后续只读预检和能力诊断已取得新证据，但真实调试闭环仍未验收，不能只按旧404判断全部支持条件。

0.17.0新增 `test_remote_function_module`，在不依赖ADT Debugger的情况下对远程启用的客户函数做功能验证。0.18.0进一步支持标量、平面DDIC结构和TABLES参数，并为 `read_function_module_interface`增加可选执行能力分析。调用前先回读活动接口，只允许 `Z*`/`Y*`远程函数，拒绝Update Task、深层结构、非TABLES位置的表类型和未知字段；每次调用必须显式设置 `acknowledgePotentialSideEffects=true`。结构和表结果支持精确断言，调用可携带预期接口指纹以防止接口漂移。单次调用最多200行、每个结构最多100字段、单值最多4096字符、SOAP请求最多1 MiB，响应保持10 MiB上限。真实 `w200`已验证 `ZCMCP_FM_1801`的 `BAPIRET2`导入结构、导出结构和两行TABLES参数：正常调用精确返回 `MCP:VALIDATION`、`ROW:FIRST`和`ROW:SECOND`，空消息返回声明异常 `INVALID_INPUT`。

0.19.0新增 `invoke_customer_function_module`，用于返回已允许客户RFC的实际结果而不是预先断言结果，并支持IMPORTING、EXPORTING和CHANGING位置的平面DDIC表类型。正式调用必须同时满足准确 `remoteFunctionAllowlist`、`Z*`/`Y*`、远程启用、非Update Task、活动接口指纹和显式副作用确认；标准函数、深层类型、未知字段和超限负载在执行前拒绝。声明异常作为结构化 `fault`返回，未声明SOAP故障作为工具错误；超时和HTTP错误不自动重试，也不承诺通用回滚、幂等或Dry Run。结果包含不暴露原始输入的调用凭证哈希。真实 `w200`已验证 `ZCMCP_FM_1901`的 `BAPIRET2_T`导入/导出、两行结果、声明异常、白名单、指纹、字段和行数门控。

0.20.0新增 `get_customer_function_call_status`，并为正式客户RFC调用增加跨并发和服务重启的持久化重复防护。每个连接内的 `requestId`只能使用一次：相同函数、接口和输入再次提交返回 `duplicate_blocked`，相同ID对应不同调用返回 `request_id_conflict`，两者都不会调用目标RFC。正常结果记录为 `completed`，声明异常记录为 `declared_fault`；网络错误、超时、未声明SOAP故障和重启前未完成调用保守标记为 `outcome_unknown`，禁止自动重试。凭证默认写入 `%LOCALAPPDATA%\ABAP MCP Standalone\state`，可用 `ABAP_MCP_STATE_DIR`覆盖；文件仅保存元数据和SHA-256摘要，不保存原始输入、输出或凭证。

0.21.0新增 `patch_abap_screen`和 `validate_dynpro_application`。屏幕回读现在包含确定性SHA-256指纹及PBO、PAI、POH、POV模块引用；增量补丁以显式 `add`、`update`、`remove`操作维护组件，组件移动通过 `update`修改 `LINE`和 `COLUMN`，未列出的公开 `RPY_DYFATC`属性保持原样。补丁要求当前指纹和已有传输，拒绝陈旧指纹、重复组件操作、未知组件、无显式变更及SAP回读无变化。验证工具核对组件、坐标、Flow Logic模块方向及主程序源码中的MODULE定义；模块池使用Include时只报告覆盖范围警告，不会伪装成完整Include验证。PBO/PAI源码仍通过现有精确源码编辑与激活工具维护。GUI Status、Menu Painter和复杂控件定义不属于0.21.0。

0.22.0新增 `read_abap_gui_definition`和 `patch_abap_gui_definition`。读取工具返回活动Menu Painter的11组原生CUA表、管理记录、SAP版本令牌和确定性SHA-256指纹；补丁工具以显式行级 `add`、`update`、`remove`维护状态、功能码、菜单、工具栏、PF键、状态功能映射和Titlebar，并完整保留未修改行。写入仅允许 `Z*`/`Y*`程序，要求当前指纹和已有Workbench传输；服务先读取并合并完整定义，SAP仓库助手1.5在写入前再次检查SAP版本令牌，使用 `RS_CUA_INTERNAL_WRITE`后立即回读，服务再精确核对结果。`validate_dynpro_application`现在递归读取最多32个Include、深度8，并核对静态 `SET PF-STATUS`和 `SET TITLEBAR`引用是否存在。Tabstrip、Table Control等仍通过Dynpro字段定义维护，不提供独立的高层控件设计器。真实 `w200`已部署助手1.5，并在 `ZCODEX_MCP_DYNPRO`完成临时Titlebar `TITLE_MCP_022`的新增、更新、陈旧指纹拒绝、删除及语义清理；最终指纹恢复基线，Dynpro应用验证为 `valid`。该回归证明了Titlebar路径，不等同于所有CUA分区组合均已完成真实运行时测试。

0.23.0在便携包根目录新增PowerShell 7一键助手入口 `install-sap-helper.ps1`，复用随包交付的 `app\scripts\bootstrap-sap-helper.ps1`，不复制SOAP或ABAP生成逻辑。它从 `connections.json`选择连接，拒绝明文密码，先校验配置和TCP可达性，再在可见终端中只提示一次密码。`status`只读报告三个客户助手API的存在/生成状态和函数组状态；旧ECC的 `ENLFDIR-ACTIVE`可能为空，因此仅作为信息输出。`preflight`在助手缺失、未生成或函数组生成失败时失败；`install`只创建缺失API；`upgrade`保留现有基础入口并重建仓库/DDIC API；`repair`重建全部三个API。安装器不会创建或释放传输，也不会修改SAP标准对象。全新SAP系统仍需先具备已审核的客户函数组 `ZCODEX_MCP_CORE`、类 `ZCL_CODEX_MCP_CORE`和客户引导RFC；正式环境应优先使用经过审查的SAP传输。

```powershell
.\install-sap-helper.ps1 -Mode status -ConnectionId w200
.\install-sap-helper.ps1 -Mode preflight -ConnectionId w200
.\install-sap-helper.ps1 -Mode install -ConnectionId w200
.\install-sap-helper.ps1 -Mode upgrade -ConnectionId w200
.\install-sap-helper.ps1 -Mode repair -ConnectionId w200
```

0.24.0新增 `setup.ps1`首次接入入口。它复用0.23.0预检、现有Codex配置器和PowerShell 7启动器，按“预检 -> Codex注册 -> 启动服务”顺序执行；同一安全密码在当前进程中同时用于预检和服务，不写入文件，服务退出后恢复原环境变量。`-ForceCodex`允许替换同名但地址不同的Codex注册，`-SkipCodex`用于其他Agent客户端。预检失败时不会注册Codex或启动服务；默认不会隐式执行SAP安装、升级或修复。

0.25.0完成经典交互屏幕闭环。真实 `w200`在包 `ZABAP`和请求 `GR2K923421`中临时创建模块池 `ZCMCP_DYN_0250`、屏幕 `0100`、GUI Status `STATUS_025`、Titlebar `TITLE_025`和事务码 `ZCMCP_0250`。功能定义显式使用ECC原生静态文本类型 `RSMPE_FUNT-TEXT_TYPE = S`；普通功能码 `HELLO/CLEAR`与退出功能码 `BACK/EXIT/CANC`分别按正常和Exit类型写入，PAI通过独立 `AT EXIT-COMMAND`模块处理退出。SAP回读精确确认菜单、工具栏、PF键、状态功能映射、按钮、PBO、PAI和事务指向，源码诊断无错误或警告，Dynpro验证为 `valid`。用户在SAP GUI实际执行屏幕按钮、菜单、工具栏、F键及Back/Exit/Cancel后，验证脚本删除事务和模块池并由SAP助手确认不存在；未释放传输，也未修改SAP标准对象。

0.26.0为ECC缺失或不兼容的ADT端点增加SAP仓库助手1.7后备路径：消息类读取和新建、CLASS/FUNCTION_GROUP文本符号读取与合并、函数组技术Include新建，以及传输请求、任务和对象明细读取。服务仍优先使用ADT，仅在明确的404、405、501、内容类型不兼容或文本锁句柄缺失时进入后备；任意其他错误保持失败，不会掩盖权限、网络或部分写入问题。所有新增写入继续限制为 `Z*`/`Y*`、正式包和已有传输；传输能力保持只读，不提供创建、修改、删除或释放操作。真实 `w200/200` 已通过仓库助手验证 `ZCMCP_MSG_0260`消息类、`ZCL_CMCP_0260`类文本、`ZCMCP_FG_0260`函数组文本、技术Include `LZCMCP_FG_0260F01`以及请求 `GR2K923421`的任务和对象明细；消息占位符实体正确回读为 `&1`，任务 `GR2K923422`没有空任务行。标准对象写入均被拒绝，请求未释放。

0.27.0为22个SAP写入或潜在业务副作用工具增加统一操作凭证。调用方应为每次操作提供唯一 `operationId`；为兼容旧Agent该字段暂时可省略，但自动生成的ID只有在收到工具响应后才能用于恢复。服务在执行前以独占文件创建操作凭证和目标锁，同一连接、同一目标的并发操作失败关闭；相同操作ID不会再次执行，不同输入复用同一ID会报告冲突。响应包含变更前目标/前置条件摘要、输入及结果或错误SHA-256、完成/失败/中断状态和人工恢复指引；原始源码、业务输入输出和密码不写入凭证。`get_write_operation_status`只读查询凭证。服务重启或凭证收尾异常时禁止自动重试，必须先回读SAP目标、检查SAP锁和传输分配，再由人工处理残留本地锁。该安全层不是SAP LUW协调器，不承诺任意业务RFC自动回滚、幂等或Dry Run；变更前摘要是调用时声明的目标和并发前置条件，不是完整SAP对象快照。

0.27.1增加可重复执行的真实SAP安全验收脚本。真实 `w200/200`在准确批准范围内临时创建 `ZCMCP_SAFE_0271`，回读确认对象活动、属于 `ZABAP`和开放请求 `GR2K923421`；同ID重复、同ID变更输入、已存在对象失败、持久化中断状态和同目标并发锁均按预期失败关闭。删除完成后又通过独立ABAP FS搜索、元数据读取和源码读取三种方式确认对象不存在。中断场景使用隔离状态目录播种未完成凭证，不代表真实SAP写入进程被强制终止。未释放传输，也未修改SAP标准对象。

0.28.0在取得本地目标锁后、调用写工具前执行只读SAP观察，并将存在性、活动状态、版本或SHA-256指纹、包、请求、任务和观察时间写入版本2凭证；无法确认目标是否存在时失败关闭且不调用写操作。`list_write_recovery_operations`只读列出中断及残留本地锁，`release_write_operation_lock`要求最新凭证哈希、精确人工确认值 `SAP_STATE_VERIFIED`和非空原因，只解除本地目标锁并记录原因哈希。恢复中心不会清除SAP锁、自动重试、调用SAP恢复动作或自动回滚RFC；SAP最终状态仍必须由人工核对。

0.30.0补齐客户对象生命周期：`update_abap_message_class`使用14位版本令牌和显式 `add`、`update`、`remove`操作增量维护消息，保留未涉及消息并禁止清空消息类；`delete_abap_source_object`通过ADT原生锁和删除接口受控删除类、接口、程序、Include、函数组、函数组Include和函数模块；`delete_ddic_object`通过SAP DDIC助手1.4在依赖检查后受控删除域、数据元素、结构和表类型。三个工具都要求准确 `Z*`/`Y*`对象、正式包、已有请求、唯一操作ID、变更前SAP观察、明确永久删除确认（删除工具）和写后回读凭证。透明数据库表删除、自动SAP解锁、自动重试、自动回滚和传输释放仍不提供。本地Mock、SOAP生成器和MCP协议已验证；真实 `w200/200`已完成七类源码对象和四类DDIC对象的创建、包/请求/任务/指纹回读、陈旧指纹或依赖拒绝、逆序删除及最终不存在验证。消息类增量更新因当前没有可靠的公开清理路径，未创建临时消息类进行真实写入验收。

0.30.1统一源码创建、修改、激活、文本元素、屏幕和删除操作的本地目标锁身份；函数组子对象按父函数组互斥。源码删除新增必填SHA-256 `expectedFingerprint`，并在取得SAP锁后重新读取活动源码、比较指纹，再执行删除。指纹冲突会解锁并停止，不调用删除接口。

0.30.2在真实助手升级验收中修复便携安装器仍显示0.26.0的问题，安装器现在从构建元数据读取版本；`get_abap_object_lines`返回完整未裁剪活动源码的SHA-256，供受控删除使用。删除锁内回读显式请求活动版本，避免把非活动草稿作为删除比较基线。

0.31.0新增动态能力中心 `get_capability_report`。报告包含产品版本、连接ID、脱敏基础地址、客户端、语言、用户、观察时间、三个助手当前读取操作返回的协议版本，以及按能力归组的71个工具状态和证据。助手读取返回的版本不等同于助手整体最高版本；高于已观察读取协议的能力保持 `unknown`，不会误报为系统不支持。探测只调用ADT发现、仓库搜索、单行只读查询、传输列表、Dump/Trace列表和三个助手读取入口；对象相关诊断、调试、RFC及写入能力在没有准确目标时也保持 `unknown`，不会借助写调用探测，不清除任何SAP或本地锁，也不自动重试或声明回滚。真实 `w200/200` 只读验收已通过：71个注册工具全部被报告覆盖，25项能力中12项可用、1项不支持、12项未知；ADT Discovery返回21个工作区和39个集合。

0.32.0补齐函数接口、事务和消息类的可验证生命周期。函数模块沿用显式接口新建、完整接口与源码指纹回读，以及0.30.0受控源码删除；事务回读新增包和确定性SHA-256定义指纹，受控删除现在同时覆盖对话事务和Report事务，并可拒绝陈旧指纹；新增 `delete_abap_message_class`，要求当前14位版本、准确包、已有请求和 `PERMANENT_DELETE`确认，通过仓库助手1.9记录删除对象后删除客户消息类并回读确认不存在。所有写入继续限制为 `Z*`/`Y*`，不创建或释放传输，不自动重试，不清除SAP锁，也不承诺RFC自动回滚。真实 `w200/200`已升级仓库助手1.9，并在 `ZABAP`、`GR2K923421`下通过 `ZCMCP_FG_0320`、`ZCMCP_FM_0320`、`ZCMCP_PRG_0320`、`ZCMCP_RPT_0320`和 `ZCMCP_MSG_0320`完整生命周期验收；接口指纹、包、请求、任务、Report事务指纹冲突、消息版本冲突和增量定义均按预期回读，五个临时对象最终均确认不存在。

0.33.0新增 `append_ddic_transparent_table_fields`，通过DDIC助手1.5仅向已有客户透明表末尾追加可为空、非键且引用活动数据元素的字段。调用必须提供最近一次读取返回的14位版本和SHA-256指纹、准确正式包、已有请求及唯一操作ID；服务和SAP助手均拒绝已有字段、`MANDT`、键字段、强制非空字段、非活动数据元素、陈旧定义和包冲突。为避免全表回写破坏复杂布局，包含Include或Append结构的透明表会被拒绝。写入完整保留现有字段顺序、交付类、数据维护设置及技术设置，并在激活后完整回读核对。字段删除、重命名、数据元素替换、键或非空属性修改、技术设置修改、透明表删除和自动数据库转换恢复仍不支持。真实 `w200/200` 已升级DDIC助手1.5，并在 `ZABAP`、`GR2K923421`下把 `APPEND_MSG`追加到 `ZCMCP_TAB_0330`；恢复核验确认字段位于第3位、引用 `BAPI_MSG`、可为空且非键，原两个字段和表设置不变，旧版本/指纹被拒绝。原进程的完成凭证已丢失，因此结论依据SAP写后回读和追加前记录；测试表已由用户在SE11删除，并通过无SAP写入的回读确认不存在。

0.34.0新增 `patch_ddic_transparent_table_fields`，以有序 `remove`、`rename`和 `update`操作维护已有客户透明表的直接字段；`update`支持数据元素、键和非空属性。调用要求当前版本、完整定义指纹、准确包、已有请求、`DESTRUCTIVE_SCHEMA_CHANGE`确认和显式数据丢失确认。服务与DDIC助手1.6双层拒绝复杂Include/Append布局、`MANDT`变更、重复最终字段、无效键顺序、可空键、非活动数据元素、无变化补丁和陈旧定义，并保留表说明、交付类、维护设置及技术设置。`delete_ddic_object`同时增加 `TABL`，透明表删除要求 `PERMANENT_DELETE`及数据丢失确认，执行依赖检查并回读确认不存在。不会自动重试、自动清除SAP锁、声明数据库转换回滚或释放传输。真实`w200/200`已升级DDIC助手1.6，并在`ZABAP`、`GR2K923421`下通过临时表`ZCMCP_TAB_0340`完成字段删除、重命名、数据元素/键/非空属性修改、陈旧定义拒绝和最终删除验收；表已确认不存在，未写业务数据且未释放传输。

0.35.0新增 `patch_function_module_interface`，对已有客户函数模块的IMPORTING、EXPORTING、CHANGING、TABLES参数及经典异常执行有序新增、重命名、属性修改和删除。调用要求最近回读的接口指纹与实现源码指纹、准确正式包、已有请求和唯一操作ID；重命名、修改或删除还必须提供 `DESTRUCTIVE_INTERFACE_CHANGE`确认。服务先核对函数归属、包、请求及活动ADT源码，再通过ADT原生锁定、保存和激活链路替换完整接口声明；仓库助手2.0随后在函数锁内确认结构已生效并维护参数说明，最后完整回读。函数组归属、短文本、远程/Update Task属性、全局接口和实现源码必须保持不变。SAP结果未知时禁止自动重试；不会自动清除SAP锁、自动回滚接口、创建或释放传输。

`sap_helper_status`是独立版本新增的只读扩展工具，当前源码通过 SAP SOAP/RFC 调用 `Z_ORVANTA_MCP_EXECUTE`。`ping`返回助手版本和就绪状态；`validate_target`由SAP侧检查 `Z*`/`Y*`命名空间、对象类型白名单和当前登录用户的 `S_DEVELOP`显示权限。该工具不修改SAP数据。历史上，`w200/200` 已安装函数组 `ZCODEX_MCP_CORE`、类 `ZCL_CODEX_MCP_CORE`和远程函数 `Z_CODEX_MCP_EXECUTE`；2026-09-07 M1回读确认仓库助手归属包为 `ZABAP`，不得继续按历史 `$TMP`假定升级目标。这些旧对象保留，不作为新版助手的自动回退入口。

受控写入仅允许客户对象。源码链路支持类、类Include、接口、程序、Include、函数组、函数模块、函数组Include、DDL和DCL；每个可变对象及其父级归属都必须是 `Z*`或 `Y*`。0.30.0可受控删除类、接口、程序、Include、函数组、函数组Include和函数模块，但不删除DDL或DCL。结构化仓库链路支持创建模块池、创建或替换及增量维护经典Dynpro屏幕、读取和增量维护GUI Status/Menu Painter定义、创建和读取对话事务、创建Report事务，以及通过ECC助手读取、新建和版本化增量更新消息类。DDIC助手 `1.7`候选在既有域、数据元素、平面结构、表类型和透明表能力上，新增复杂Include/Append布局保留、技术设置补丁及原生表转换恢复。字段补丁仍只修改直接数据元素字段；ECC 7.31表名最多16个字符，键字段必须连续位于字段列表开头且不可为空。写入要求正式包、已有传输和并发令牌或工作清单指纹；破坏性表结构变更还要求数据丢失确认。标准对象会在SAP写入前拒绝，服务不会创建或释放传输。真实SAP写入仍必须取得对象级批准。原版全部54个工具契约及独立化分类冻结在 `contracts/full-tool-baseline.json`。

0.15.0新增函数模块接口读取、带显式接口创建和仓库分配检查。`read_function_module_interface`返回导入、导出、更改、表参数、异常、源码及SHA-256指纹；`create_function_module_with_interface`仅在已有客户函数组中创建全新的客户函数模块，并校验参数重名、类型、源码、正式包和已有传输；`inspect_repository_assignment`只读返回包、父对象、开放请求/任务、活动状态和原始系统。旧ECC的ADT函数组创建端点返回405或501时，服务使用SAP仓库助手 `1.3`的 `RS_FUNCTION_POOL_INSERT`后备路径。函数模块创建、传输分配和接口仍由SAP回读验证，服务不创建或释放传输。

`create_object_programmatically`以原工具输入契约创建并激活客户源码对象，当前允许 `CLAS/OC`、`INTF/OI`、`PROG/P`、`PROG/I`、`FUGR/F`、`FUGR/FF`、`FUGR/I`、`DDLS/DF`和 `DCLS/DL`。创建前检查系统是否公开对应类型并调用SAP名称验证；旧ECC未返回可解释的验证结果或未提供验证端点时，服务仍保留本地名称、类型、包和传输限制，并让创建端点作最终判定。`FUGR/I`端点明确返回404、405或501时，0.26.0改由SAP助手在已存在的客户函数组内创建技术Include。对象、函数模块和父函数组执行 `Z*`/`Y*`限制。`$TMP`对象不得携带传输请求，非本地包必须提供现有传输号；`type=new`明确拒绝。`create_test_include`仅为现有客户类创建测试Include，创建前后检查结构，并协调锁定、传输、解锁和激活。两个工具都不会创建或释放传输，真实调用必须取得准确对象名的当前任务授权。

在便携包目录中运行 `.\start.ps1 -Port 4847`，按安全提示输入密码。不要将密码写入命令历史、脚本或配置文件。源码开发启动前运行 `npm run build`；凭据通过受控的当前进程环境提供，不在文档中使用明文赋值示例。

MCP地址为 `http://127.0.0.1:4847/mcp`，健康检查为
`http://127.0.0.1:4847/health`。

`manage_text_elements` 对程序文本池使用SAP仓库助手，复用程序已有的开放传输分配并在写入后回读验证；0.26.0把同一后备扩展到类和函数组。真实 `w200` 的ADT文本锁端点返回空响应，文本元素URI也无激活映射，因此服务在该明确能力缺失时转用仓库助手1.7；`ZCL_CMCP_0260`和 `ZCMCP_FG_0260`的文本符号 `026`均已完成写入和回读。权限、网络或其他保存错误不会触发后备。

历史0.35.0交付记录中的基础SAP助手为 `1.0`、仓库助手为 `2.0`、DDIC助手为 `1.6`。透明表字段追加及破坏性生命周期已在真实 `w200`的获批临时对象范围完成，当时未释放传输 `GR2K923421`；不据这些旧版本号推断当前SAP助手或传输状态。面向其他SAP系统的正式安装应使用经过审查的SAP传输，不依赖客户引导RFC。

## 依赖选择

| 依赖                        |  固定版本 | 用途        | 选择原因                    |
| --------------------------- | --------: | ----------- | --------------------------- |
| `abap-adt-api`              |   `8.4.3` | SAP ADT通信 | 与当前 MCP内核版本一致，MIT |
| `@modelcontextprotocol/sdk` |  `1.29.0` | MCP协议     | 与当前 MCP内核版本一致，MIT |
| `zod`                       | `3.25.76` | 输入契约    | 与当前 MCP内核版本一致，MIT |

0.2.0便携包已完成本机无头冒烟验证。0.3.0诊断工具已完成Mock后端、协议和部分真实 `w200`验证。0.4.0新增受控精确替换与激活链路，并复用原ABAP FS针对ECC 7.31“有会话Cookie但无CSRF响应Token”的兼容处理。已在批准对象 `ZCODEX_FS_SYNC_0807`上连续完成两次无写入锁定/解锁，以及临时替换、保存、解锁、激活、诊断和反向恢复；最终活动源码与测试前SHA-256一致。0.4.1将原ABAP FS的请求标识头应用到全部ADT客户端，并为旧ECC类版本历史增加显式ADT内容类型重试；真实 `w200` ABAP Unit请求、版本列表、历史源码读取和版本比较均已通过。0.5.0新增只读传输请求查询，直接调用ADT用户传输和传输明细接口，不复用会改写用户传输视图配置的VS Code路径。真实 `w200`可查询当前用户传输列表，但该旧ECC的传输明细端点返回不完整结构，因此明细、对象清单和对比会明确报告不兼容。where-used现明确返回404，属于当前系统未提供对应ADT端点，而不是账号权限拒绝。0.6.0新增无头源码下载和ADT发现导出；最终便携包已在真实 `w200`下载 `ZCL_CA_HZ`的1个非空源码文件（141320字节），并在包内 `exports`目录生成4个发现Markdown文件。该旧ECC本次返回21个workspace和39个collection，但没有返回template link、core discovery entry或RES_APP class。0.7.0增加客户源码对象写入矩阵和父对象保护；真实 `w200`已只读解析类、程序、Include、函数模块和接口，标准对象硬拒绝及函数组技术Include写入流程由自动测试覆盖。0.8.0新增客户源码对象创建和类测试Include创建；在准确授权后，真实 `w200`已创建并激活 `$TMP`类、接口、程序、Include、函数组、函数模块和类测试Include。函数组创建通过媒体类型降级在v2成功；函数组和函数模块源码均已回读且无语法诊断。ECC 7.31不公开DDL/DCL创建类型，函数组Include创建端点即使使用v2媒体类型仍返回501，因此这些类型保持不支持。0.15.0新增3个函数模块接口工具，通过SAP仓库助手 `1.3`兼容旧ECC函数组创建、接口创建和仓库分配回读；真实 `w200`完成远程函数创建、激活、诊断、有效SOAP调用和异常SOAP调用验证。`analyze_anst_enhancements`属于本地XLSX分析工具，不是SAP核心能力，本阶段不引入Excel依赖。
