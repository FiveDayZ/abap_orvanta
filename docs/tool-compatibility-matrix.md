# 工具兼容矩阵

基线：`vscode_abap_remote_fs` 版本 `2.7.0`，提交
`0466e8ceea4e201335d74a7420ac894384f4a0e2`。

| 工具                                    | 名称/输入契约 | 独立实现                         | VS Code依赖替代          | 当前结论          |
| --------------------------------------- | ------------- | -------------------------------- | ------------------------ | ----------------- |
| `get_connected_systems`                 | 已冻结        | 已实现                           | 独立连接配置             | 真实双跑通过      |
| `abap_debug_session`                    | 独立扩展      | 已实现，当前用户会话             | ADT Debugger API         | w200返回404       |
| `abap_debug_breakpoint`                 | 独立扩展      | 已实现，仅Z/Y源码断点            | ADT Debugger API         | Mock通过          |
| `abap_debug_status`                     | 独立扩展      | 已实现，会话状态与清理           | 服务内会话状态           | Mock通过          |
| `abap_debug_stack`                      | 独立扩展      | 已实现，暂停调用栈               | ADT Debugger API         | Mock通过          |
| `abap_debug_variable`                   | 独立扩展      | 已实现，有界只读变量             | ADT Debugger API         | Mock通过          |
| `abap_debug_step`                       | 独立扩展      | 已实现，单步与继续               | ADT Debugger API         | Mock通过          |
| `sap_helper_status`                     | 独立扩展      | 已实现，只读PING与目标校验       | SAP SOAP/RFC助手         | w200通过          |
| `read_function_module_interface`        | 独立扩展      | 已实现，接口、源码与指纹回读     | SAP仓库助手1.3           | w200通过          |
| `test_remote_function_module`           | 独立扩展      | 已实现，客户RFC标量/结构/表断言  | SAP SOAP/RFC             | w200通过          |
| `invoke_customer_function_module`       | 独立扩展      | 已实现，白名单客户RFC正式调用    | SAP SOAP/RFC             | w200通过          |
| `get_customer_function_call_status`     | 独立扩展      | 已实现，持久化调用凭证只读查询   | Node本地文件系统         | 本地通过          |
| `get_write_operation_status`            | 独立扩展      | 已实现，统一写操作凭证只读查询   | Node本地文件系统         | w200通过          |
| `list_write_recovery_operations`        | 独立扩展      | 已实现，中断/陈旧操作只读列表    | Node本地文件系统         | 本地通过          |
| `release_write_operation_lock`          | 独立扩展      | 已实现，人工确认后仅解除本地锁   | Node本地文件系统         | 本地通过          |
| `create_function_module_with_interface` | 独立扩展      | 已实现，客户远程函数受控创建     | SAP仓库助手1.3           | w200通过          |
| `inspect_repository_assignment`         | 独立扩展      | 已实现，包与开放传输只读检查     | SAP仓库助手1.3           | w200通过          |
| `read_abap_screen`                      | 独立扩展      | 已实现，原生结构回读             | SAP仓库助手1.1           | w200通过          |
| `upsert_abap_screen`                    | 独立扩展      | 已实现，客户屏幕受控写入         | SAP仓库助手1.1           | w200通过          |
| `patch_abap_screen`                     | 独立扩展      | 已实现，组件增删改及坐标移动     | SAP仓库助手1.4           | w200通过          |
| `validate_dynpro_application`           | 独立扩展      | 已实现，屏幕与PBO/PAI静态校验    | 仓库助手及ADT源码读取    | w200通过          |
| `read_abap_gui_definition`              | 独立扩展      | 已实现，完整原生CUA定义回读      | SAP仓库助手1.5           | w200通过          |
| `patch_abap_gui_definition`             | 独立扩展      | 已实现，原生CUA行级增删改        | SAP仓库助手1.5           | w200 Titlebar通过 |
| `create_module_pool`                    | 独立扩展      | 已实现，客户模块池创建           | SAP仓库助手1.1           | w200通过          |
| `read_transaction_code`                 | 独立扩展      | 已实现，事务与GUI属性回读        | SAP仓库助手1.1           | w200通过          |
| `create_transaction_code`               | 独立扩展      | 已实现，客户对话事务创建         | SAP仓库助手1.1           | w200通过          |
| `delete_transaction_code`               | 独立扩展      | 已实现，客户事务受控删除         | SAP仓库助手1.1           | w200通过          |
| `create_report_transaction`             | 独立扩展      | 已实现，仅新建客户Report事务     | SAP仓库助手1.2           | w200通过          |
| `read_abap_message_class`               | 独立扩展      | 已实现，活动消息类完整回读       | ADT或仓库助手1.7         | w200助手通过      |
| `create_abap_message_class`             | 独立扩展      | 已实现，仅新建客户消息类         | ADT或仓库助手1.7         | w200助手通过      |
| `update_abap_message_class`             | 独立扩展      | 已实现，版本化消息增量更新       | SAP仓库助手1.8           | Mock/协议通过     |
| `read_ddic_domain`                      | 独立扩展      | 已实现，活动域和固定值回读       | SAP DDIC助手1.2          | w200通过          |
| `upsert_ddic_domain`                    | 独立扩展      | 已实现，客户域完整替换           | SAP DDIC助手1.2          | w200通过          |
| `read_ddic_data_element`                | 独立扩展      | 已实现，活动数据元素回读         | SAP DDIC助手1.2          | w200通过          |
| `upsert_ddic_data_element`              | 独立扩展      | 已实现，客户数据元素完整替换     | SAP DDIC助手1.2          | w200通过          |
| `read_ddic_structure`                   | 独立扩展      | 已实现，活动平面结构回读         | SAP DDIC助手1.2          | w200通过          |
| `upsert_ddic_structure`                 | 独立扩展      | 已实现，客户平面结构完整替换     | SAP DDIC助手1.2          | w200通过          |
| `read_ddic_transparent_table`           | 独立扩展      | 已实现，活动透明表完整定义回读   | SAP DDIC助手1.3          | w200通过          |
| `create_ddic_transparent_table`         | 独立扩展      | 已实现，仅新建客户透明表         | SAP DDIC助手1.3          | w200通过          |
| `read_ddic_table_type`                  | 独立扩展      | 已实现，活动表类型回读           | SAP DDIC助手1.2          | w200通过          |
| `upsert_ddic_table_type`                | 独立扩展      | 已实现，STANDARD默认键表类型替换 | SAP DDIC助手1.2          | w200通过          |
| `delete_ddic_object`                    | 独立扩展      | 已实现，依赖检查后受控删除       | SAP DDIC助手1.4          | w200通过          |
| `search_abap_objects`                   | 已冻结        | 已实现                           | `ADTClient.searchObject` | 真实双跑通过      |
| `get_abap_object_info`                  | 已冻结        | 已实现，含DDIC和Enhancement      | ADT源码与DD表查询        | 真实双跑通过      |
| `get_abap_object_lines`                 | 已冻结        | 已实现，含方法提取和DDIC回退     | ADT源码与DD表查询        | 真实双跑通过      |
| `get_batch_lines`                       | 已冻结        | 已实现                           | 独立并行读取             | 真实双跑通过      |
| `get_object_by_uri`                     | 已冻结        | 已实现                           | 直接读取ADT URI          | 真实调用通过      |
| `search_abap_object_lines`              | 已冻结        | 已实现，含正则和增强搜索         | 服务端源码搜索           | 真实调用通过      |
| `get_abap_object_workspace_uri`         | 已冻结        | 已实现                           | 确定性 `adt://` URI      | 真实调用通过      |
| `get_abap_object_url`                   | 已冻结        | 已实现                           | 独立生成WebGUI URL       | 真实调用通过      |
| `find_where_used`                       | 已冻结        | 已实现，含过滤、分页和片段       | ADT usageReferences      | w200返回404       |
| `get_sap_system_info`                   | 已冻结        | 已实现                           | 只读查询系统元数据表     | w200返回空值      |
| `get_version_history`                   | 已冻结        | 已实现，含读取和比较版本         | `ADTClient.revisions`    | w200通过          |
| `get_abap_diagnostics`                  | 已冻结        | 已实现，检查活动源码             | ADT syntax check         | w200通过          |
| `get_abap_sql_syntax`                   | 已冻结        | 已实现，无头安全指南             | 内置静态文档             | Mock通过          |
| `execute_data_query`                    | 已冻结        | 已实现，只读/限行/internal       | ADT data preview         | w200调用通过      |
| `run_atc_analysis`                      | 已冻结        | 已实现，对象检查和文档读取       | ADT ATC                  | w200返回404       |
| `run_unit_tests`                        | 已冻结        | 已实现，不自动激活               | ADT ABAP Unit            | w200通过          |
| `analyze_abap_dumps`                    | 已冻结        | 已实现，只读现有Dump             | ADT feeds/dumps          | w200通过          |
| `analyze_abap_traces`                   | 已冻结        | 已实现，只读现有Trace            | ADT trace APIs           | w200返回404       |
| `manage_transport_requests`             | 已冻结        | 已实现，四个只读查询动作         | ADT或仓库助手1.7         | w200助手通过      |
| `abap_download`                         | 已冻结        | 已实现，对象和包本地导出         | Node文件系统 + ADT读取   | w200包内通过      |
| `adt_discovery_export`                  | 已冻结        | 已实现，四文件Markdown导出       | Node文件系统 + ADT发现   | w200包内通过      |
| `replace_string_in_abap_object`         | 已冻结        | 已实现，客户源码矩阵和完整锁流程 | ADT lock/source/activate | w200类写通过      |
| `abap_activate`                         | 已冻结        | 已实现，仅限显式Z/Y对象URI       | ADT activation           | w200链路通过      |
| `create_object_programmatically`        | 已冻结        | 已实现，客户源码创建和传输保护   | ADT或仓库助手1.7         | Include助手通过   |
| `delete_abap_source_object`             | 独立扩展      | 已实现，客户源码对象受控删除     | ADT原生锁和删除          | w200通过          |
| `create_test_include`                   | 已冻结        | 已实现，客户类测试Include创建    | ADT class include API    | w200通过          |
| `manage_text_elements`                  | 已冻结        | 三类对象ADT优先、助手后备        | ADT或仓库助手1.7         | w200助手通过      |

工具名称和输入契约按原服务基线冻结；仅将依赖编辑器上下文的工具说明调整为独立服务语义。

## 已验证边界

- MCP Streamable HTTP初始化、工具枚举和工具调用。
- 当前70个工具均通过MCP协议枚举；原版工具契约继续按冻结基线回归，独立扩展工具通过协议和Mock回归验证。
- 原版52个语言模型工具和2个MCP专属工具已冻结到 `contracts/full-tool-baseline.json`，并完成SAP核心、编辑器专属、本地工具及影响类型分类。
- Mock SAP后端下普通类、程序和DDIC表的搜索、信息、分段读取、方法提取、Enhancement元数据和批量读取行为。
- 源码和构建产物不存在 `vscode`、`Code.exe`、Extension Host或子进程调用。
- 独立服务直接依赖 `abap-adt-api 8.4.3`，没有 VS Code运行时依赖。
- 诊断波次的Mock覆盖语法检查、只读查询安全边界、ATC、ABAP Unit、Dump和Trace格式化。
- 传输波次的Mock覆盖用户传输、明细、对象清单、对比和非法传输号拒绝；实现只调用读取接口，不创建或更新ADT传输视图配置。
- 导出波次的Mock覆盖绝对目标路径、默认拒绝覆盖、源码文件写入、ADT发现四文件输出和无编辑器状态运行。
- 最终0.6.0便携包在真实 `w200`下载 `ZCL_CA_HZ`成功，生成1个非空源码文件（141320字节）；同一运行实例在便携目录 `exports`下生成4个ADT发现Markdown文件。
- 写入波次的Mock覆盖专用有状态ADT会话、精确唯一替换、已有非活动版本保护、锁定、保存失败后的解锁、传输冲突、激活结果和Z/Y对象限制。
- 0.7.0写入策略覆盖类、类Include、接口、程序、Include、函数组、函数模块、函数组Include、DDL和DCL源码；标准对象、标准父对象、无法证明客户归属的技术Include和结构化DDIC URI在SAP加锁前拒绝。
- 0.8.0创建策略覆盖 `CLAS/OC`、`INTF/OI`、`PROG/P`、`PROG/I`、`FUGR/F`、`FUGR/FF`、`FUGR/I`、`DDLS/DF`和 `DCLS/DL`；创建前执行系统类型发现和SAP名称验证，创建后重新解析对象路径并激活。
- 旧ECC创建兼容层仅在SAP明确拒绝通用内容类型时重试对象专用ADT媒体类型；函数组按v3、v2、v1和无版本媒体类型降级，且只对已确认的内容处理器或`ExceptionInvalidData`转换错误继续重试。函数组Include优先尝试v2媒体类型，并仅对404/501端点缺失继续降级。SAP未及时建立仓库索引时不再把成功创建误报为失败。名称验证端点返回空结果、404或501时，仍保留本地客户命名、系统类型、包和传输约束，并由创建端点最终校验。
- 创建策略拒绝标准对象、标准函数组父对象、自动新建传输、`$TMP`携带传输号和正式包缺少现有传输号；类测试Include在加锁前和锁内各检查一次是否已存在，并在创建后重新读取类结构。
- 0.9.0文本元素策略支持程序、类和函数组；读取不限定客户命名，创建和更新仅允许 `Z*`/`Y*`，保留未改动文本，并协调锁定、保存、解锁、激活和回读验证。标准对象在SAP加锁前拒绝。
- 0.10.0通过真实 `w200` SOAP/RFC通道调用SAP侧客户助手；助手 `1.0`只开放 `PING`和 `VALIDATE_TARGET`，并在SAP侧执行Z/Y命名、对象类型白名单和`S_DEVELOP`显示权限检查。
- 0.11.0增加仓库助手 `1.1`和5个经典Dynpro工具。真实 `w200`已创建并激活模块池 `ZCODEX_MCP_DYNPRO`、屏幕 `0100`和事务 `ZCODEX_MCP_UI`；MCP回读得到5个屏幕字段、4行流逻辑，事务正确指向该模块池和屏幕。
- 0.12.0增加DDIC助手 `1.2`和8个工具，覆盖域、基于域的数据元素、平面结构和STANDARD/default-key表类型。真实 `w200`已创建并激活 `ZCODEX_MCP_DOM_0831`、`ZCODEX_MCP_DE_0831`、`ZCODEX_MCP_STR_0831`和`ZCODEX_MCP_TT_0831`，均回读为包 `ZABAP`并由SAP返回传输记录 `GR2K923421`。最新版便携包还验证了标准对象写入、缺失传输、重复结构字段和陈旧版本令牌均被拒绝。
- 0.13.0将DDIC助手升级至 `1.3`并新增2个透明表工具。读取返回键、非空标记、交付类、Data Class、数据浏览维护标记、大小类别和缓冲设置；创建仅允许最多16字符的全新 `Z*`/`Y*`对象，要求键字段连续位于开头、全部字段非空、Data Class为 `APPL0/APPL1/APPL2`并固定为不缓冲，现有透明表拒绝替换以避免数据转换或丢失。真实 `w200`已在包 `ZABAP`、请求 `GR2K923421`中创建并激活 `ZCMCP_TAB_0831`，回读版本 `20260831132653`；重复创建、标准对象、超长名称和错误键顺序均被拒绝。
- 0.14.0将仓库助手升级至 `1.2`并新增3个工具。真实 `w200` 已创建并回读Report事务 `ZCMCP_R14`，正确指向 `ZCMCP_RPT_0831`，包为 `ZABAP`、请求为 `GR2K923421`；活动Report包含选择屏幕校验和列表输出，源码回读与语法诊断通过。程序文本符号 `R14` 已通过ECC文本池助手创建、回读，并验证重复创建会被拒绝。非法Variant、标准事务码、标准程序和重复事务均在写入前或SAP助手内被拒绝。
- 0.15.0将仓库助手升级至 `1.3`并新增3个函数模块接口工具。旧ECC函数组ADT创建端点返回405或501时，服务使用 `RS_FUNCTION_POOL_INSERT`后备创建；函数接口创建使用ECC兼容的 `RPY_FUNCTIONMODULE_INSERT`参数和 `RSEXC`/`RSFDO`异常说明结构。真实 `w200`已创建并激活 `ZCMCP_FG_1501`和远程函数 `ZCMCP_FM_1501`，回读确认包 `ZABAP`、请求 `GR2K923421`、任务 `GR2K923422`、导入/导出参数、异常说明和源码。有效SOAP调用返回 `MCP:VALIDATION`，空输入调用返回包含 `INVALID_INPUT`的SOAP Fault；标准函数、标准父函数组、缺失传输、重复参数、非法类型和重复创建均被拒绝。
- 0.16.0新增6个无头ABAP用户调试工具，Mock覆盖会话、Z/Y断点、调用栈、只读变量、单步、继续和清理；MCP协议回归覆盖公开契约。真实 `w200`在会话启动阶段对 `GET /sap/bc/adt/debugger/listeners`返回HTTP 404，SOAP未触发、断点未设置、没有SAP源码或传输变更。
- 0.17.0新增客户RFC标量功能验证工具。Mock和本地SOAP端点覆盖活动接口门控、Z/Y限制、远程启用检查、输入输出白名单、精确输出断言、声明异常断言、HTTP 500 SOAP Fault解析、显式副作用确认和有界值。真实 `w200`通过MCP调用 `ZCMCP_FM_1501`完成正反例验证：有效输入精确返回 `MCP:VALIDATION`，空输入返回声明异常 `INVALID_INPUT`，接口指纹为 `3eeec94781429bfe103c7297540e758511e24bd2de7231c0b2d35fa1632ff4a2`。
- 0.18.0将客户RFC验证扩展到平面DDIC结构和TABLES参数，并为接口读取增加可选执行能力分析。工具通过DDIC解析字段白名单，拒绝深层字段、非TABLES位置的表类型、未知参数/字段、接口指纹漂移、Update Task和标准函数；限制200行、每结构100字段、单值4096字符、请求1 MiB和响应10 MiB。真实 `w200`通过MCP调用 `ZCMCP_FM_1801`完成 `BAPIRET2`结构导入/导出和两行TABLES正例、空消息声明异常反例、接口回读、活动源码诊断及仓库分配检查；接口指纹为 `ce80d194fab72df21ea3d49502afebb6b33416674c7bb03a13e92a5d2e4c4951`。
- 0.19.0新增白名单客户RFC正式调用，并支持IMPORTING、EXPORTING和CHANGING位置的平面DDIC表类型。每次调用要求准确白名单、活动接口指纹、请求ID和显式副作用确认；返回实际有界结果、声明异常和输入/输出摘要哈希，不自动重试网络或HTTP故障。真实 `w200`创建并调用 `ZCMCP_FM_1901`，确认 `BAPIRET2_T`两行导入/导出、空表 `INVALID_INPUT`、白名单拒绝、指纹拒绝、未知字段拒绝、201行拒绝、活动源码无诊断，接口指纹为 `e0648e2f04259f9a0c16b095a84117ae32db8a6f9f82951fa5a11e7e2663556d`。
- 0.20.0为正式客户RFC调用增加持久化一次性请求凭证，并新增只读状态查询。文件系统独占创建保证同一连接和请求ID的并发调用只有一次进入目标RFC；相同调用返回 `duplicate_blocked`，不同函数、接口或输入返回 `request_id_conflict`。完成、声明异常、网络/超时不确定结果和重启遗留调用分别报告 `completed`、`declared_fault`和 `outcome_unknown`。凭证只保存元数据与SHA-256摘要，不保存原始输入、输出或密码。
- 0.21.0新增屏幕SHA-256指纹、Flow Logic模块引用、组件新增/更新/删除、坐标移动和Dynpro应用静态验证。坐标移动使用 `update`修改 `LINE`和 `COLUMN`；不提供无法由原生D021S回读证明的表内排序操作。真实 `w200`已安装仓库助手1.4，在 `ZCODEX_MCP_DYNPRO`屏幕 `0100`新增、修改坐标并删除临时组件 `BTN_PATCH_021`；陈旧指纹被拒绝，PBO/PAI定义验证为 `valid`，清理后恢复原5个组件和原语义定义。
- 0.22.0新增完整Menu Painter读取和行级补丁工具，覆盖 `RSMPE_STAT/FUNT/MEN/MNLT/ACT/BUT/PFK/STAF/ATRT/TITT/BUTS`及 `RSMPE_ADM`。客户端先用SHA-256指纹拒绝陈旧编辑，再将合并后的完整定义交给SAP助手1.5；SAP端重新读取活动定义并比较14位修改时间令牌，使用原生`SCUA`对象类别记录`CUAD`传输子对象、调用 `RS_CUA_INTERNAL_WRITE`写入活动定义并回读。真实 `w200`已部署助手1.5，并在 `ZCODEX_MCP_DYNPRO`中完成临时Titlebar `TITLE_MCP_022`新增、更新、陈旧指纹拒绝、删除及语义清理；最终指纹恢复基线，程序保持在`ZABAP`和开放请求`GR2K923421`，Dynpro验证为`valid`。
- 0.23.0新增便携包内PowerShell 7助手安装器，提供 `status`、`preflight`、`install`、`upgrade`、`repair`五种模式；配置解析、明文密码拒绝、连接选择、TCP可达性、单次安全密码传递、三个助手API状态、函数组生成状态和各模式动作映射已通过受控本地后端回归。便携包包含安装器及唯一的SOAP/ABAP生成实现，不依赖VS Code或系统Node.js。
- 0.24.0新增便携包首次接入入口 `setup.ps1`，组合0.23.0只读预检、Codex注册和服务启动。受控回归验证了单次 `SecureString`复用、临时密码环境变量清理、`SkipCodex`分支和预检失败后禁止注册/启动；现有 `start.ps1`增加内部 `PassThru`返回模式，直接启动行为保持兼容。
- 0.25.0完成完整经典屏幕闭环。真实 `w200`临时创建 `ZCMCP_DYN_0250`、屏幕 `0100`、`STATUS_025`、`TITLE_025`和事务 `ZCMCP_0250`，精确回读5个功能码、菜单、4个工具栏按钮、5个PF键、状态映射、10个屏幕组件及PBO/PAI定义。功能文本使用ECC原生 `TEXT_TYPE=S`，`BACK/EXIT/CANC`使用Exit类型和 `AT EXIT-COMMAND`。用户在SAP GUI实际验证屏幕按钮、菜单、工具栏、F键和三种退出路径；随后事务和模块池均由SAP助手删除并验证不存在。对象位于 `ZABAP`和开放请求 `GR2K923421`，未释放传输、未修改标准对象。
- 0.26.0新增ECC仓库助手1.7后备：消息类读取/新建、CLASS/FUNCTION_GROUP文本符号读取/合并、函数组技术Include新建及传输明细读取。协议、Mock、生成器和安全门控已覆盖；真实 `w200`已验证 `ZCMCP_MSG_0260`、`ZCL_CMCP_0260`、`ZCMCP_FG_0260`、`LZCMCP_FG_0260F01`及请求 `GR2K923421`。写入仍限 `Z*`/`Y*`、正式包和已有传输，传输操作保持只读且没有释放入口。
- 0.27.0为22个SAP写入或潜在副作用工具增加统一操作ID、持久化SHA-256凭证、目标级跨进程独占锁、重复ID/输入冲突拒绝、前置条件摘要、完成/失败/中断状态和人工恢复指引；新增 `get_write_operation_status`。本地协议与故障回归覆盖完成、失败、重复、同目标并发、服务重启中断和陈旧锁失败关闭。凭证不保存原始源码或业务载荷。该层不自动重试，不自动删除陈旧锁，也不承诺任意业务RFC回滚。
- 0.27.1完成真实SAP安全验收。真实 `w200/200`在包 `ZABAP`、请求 `GR2K923421`中临时创建并回读活动模块池 `ZCMCP_SAFE_0271`，验证同ID重复返回 `duplicate_blocked`、同ID变更输入返回 `operation_id_conflict`、已存在对象失败凭证为 `failed`、隔离状态目录播种的未完成凭证恢复为 `interrupted`、残留目标锁返回 `target_concurrency_conflict`，并确认 `automaticRetry=false`和 `automaticRollback=false`。删除返回 `completed`后，独立ABAP FS搜索、对象信息和源码读取均确认对象不存在；未释放传输，未修改SAP标准对象。
- 0.28.0在写动作前持久化只读SAP观察证据，包含目标存在性、活动状态、版本或指纹、包、请求、任务及观察时间；无法确认存在性时不调用写动作。恢复中心可只读列出中断/陈旧操作，并在最新凭证哈希、精确人工确认和原因齐全时仅解除本地目标锁。Mock和MCP协议覆盖证据、旧凭证兼容、列表边界、活动操作拒绝、哈希冲突和人工解除；不清除SAP锁、不自动重试、不自动回滚RFC。
- 0.30.0新增消息类版本化增量更新、七类源码对象ADT受控删除，以及域、数据元素、结构和表类型的依赖检查后删除。Mock、SOAP生成器和MCP协议覆盖版本冲突、增删改保留语义、禁止清空、重复操作、包/父对象/确认门控、依赖拒绝、写后不存在验证和版本2操作凭证。真实 `w200/200`已完成七类源码对象和四类DDIC对象的创建、证据回读、冲突或依赖拒绝、逆序删除和最终不存在验证；消息类增量更新因缺少可靠的公开清理路径，未执行真实写入。
- 0.30.1统一源码生命周期操作的本地目标锁身份，函数组子对象按父函数组互斥；源码删除要求调用方SHA-256指纹并在SAP锁内重新读取比较，冲突时解锁且不调用删除接口。本地锁身份和锁内指纹回归已覆盖；真实 `w200`陈旧指纹拒绝和七类源码删除已通过。
- 0.30.2修复便携安装器产品版本硬编码，并在源码读取结果中公开完整活动源码SHA-256；锁内删除比较显式读取活动版本。真实 `w200`已重新创建仓库和DDIC助手并通过生成/活动预检，源码与DDIC生命周期验收通过且临时对象已清理。
- 包和传输检查确认模块池与事务均属于 `ZABAP`，请求 `GR2K923421`及用户任务 `GR2K923422`保持可修改；请求中包含 `R3TR PROG ZCODEX_MCP_DYNPRO`和 `R3TR TRAN ZCODEX_MCP_UI`。屏幕 `0100`没有独立的 `LIMU DYNP`记录，由已入请求的主程序对象覆盖。
- WebGUI已实际打开 `ZCODEX_MCP_UI`，确认初始文本显示、输入字段可编辑、`Clear`清空内容且`Exit`返回Easy Access；SAP页面来源没有控制台错误。浏览器扩展自身的报错与SAP页面无关。
- 真实 `w200`已在 `$TMP`创建并激活 `ZCODEX_MCP_CLS_0828`、`ZCODEX_MCP_IF_0828`、`ZCODEX_MCP_PRG_0828`和 `ZCODEX_MCP_I_0828`；源码回读和语法诊断通过。`ZCODEX_MCP_CLS_0828`测试Include创建、回读、激活和诊断通过。
- 真实 `w200`已创建并激活函数组 `ZCODEX_MCP_FG_0828`和函数模块 `ZCODEX_MCP_FM_0828`。函数组创建在v3媒体类型返回`ExceptionInvalidData`后以v2成功；两者源码均已回读，活动源码无语法错误或警告。
- 真实 `w200`只读解析并读取 `ZCL_CA_HZ`、`Z001`、`Z009_I01`、`ZCA_FM_005_HZ_CX`和`ZIF_CCJF`成功，覆盖类、程序、Include、函数模块和接口的实际ADT URI。
- `w200`批准对象 `ZCODEX_FS_SYNC_0807`连续两次完成无写入锁定/解锁，证明每次会话均能自动清理。
- 同一对象完成临时精确替换、保存、解锁、激活、无诊断、反向恢复和再次激活；最终活动源码与测试前SHA-256均为 `FDF04E1221CF686339325271B287C1424241CF7DA9D4E49C420C140693AA540D`。
- Codex CLI通过独立端点 `http://127.0.0.1:4847/mcp`实际调用 `get_object_by_uri`并读取最终恢复后的 `w200`源码。
- 0.4.1将 `X-Requested-With: XMLHttpRequest`应用到全部ADT客户端后，`ZCL_TESTEE`的ABAP Unit请求由403恢复为正常结果；对象当前没有测试类，服务返回 `NO TESTS FOUND`且未执行激活。
- 旧ECC类元数据按显式ADT内容类型重试后，`ZCL_CA_HZ`版本列表返回2个版本，版本1源码读取4666行，版本1与版本2比较成功。
- `analyze_anst_enhancements`只处理本地XLSX，已重分类为本地工具并排除，避免引入Excel运行时依赖。

## 尚未验证

- 0.3.0新增七个诊断工具与原服务的双跑。
- 0.16.0无头调试的真实暂停、栈、变量、单步、继续和SOAP结果尚未验证。`w200` ADT Discovery显示Debugger workspace但没有collection，且 `/sap/bc/adt/debugger/listeners`返回HTTP 404；需SAP管理员先核实该ECC版本是否提供及是否启用 `/sap/bc/adt/debugger` 服务，不能将管理员权限视为端点存在的证明。
- 0.19.0客户RFC调用支持标量、平面DDIC结构、经典TABLES以及平面行类型的DDIC表类型；仍不支持深层结构、嵌套表、对象引用或任意复杂XML映射。客户命名空间和白名单都不代表只读；每次真实调用仍需针对函数名和输入取得授权。通用MCP层不能为任意业务RFC保证回滚、幂等或Dry Run。
- 0.20.0的持久化凭证只阻止Agent层重复提交，不会把任意SAP函数改造成业务幂等接口。`outcome_unknown`不证明SAP已提交或未提交；服务不提供凭证删除、自动重试或自动业务核对工具。
- 0.27.1真实 `w200`验收证明了模块池创建/删除路径及操作凭证状态，不等同于22个写工具逐项真实回归。`preChangeSummary`记录调用时声明的目标、指纹/版本/精确源码匹配等并发前置条件及传输号，不是完整SAP对象快照。文件锁只协调共享同一 `ABAP_MCP_STATE_DIR`的独立服务实例，不能替代SAP原生锁或消除读取与写入之间的全部竞争窗口；`interrupted`场景由隔离目录播种未完成凭证，不是实际进程在SAP写入中被强制终止。
- 0.21.0屏幕指纹检查发生在独立服务读取屏幕后、调用SAP补丁助手前，当前不是SAP端原子比较；并发修改仍存在读取与写入之间的竞争窗口。真实写入前必须确保目标屏幕没有其他编辑者，并在写入后立即回读核对。
- 0.22.0 GUI补丁增加SAP端14位版本令牌检查和写后精确回读，但旧ECC时间粒度为秒，同一秒内的并发编辑仍不能视为强事务锁。工具公开原生CUA行，不提供高层可视化菜单设计器；调用者必须维护状态、功能、菜单、工具栏和PF键之间的有效关系。0.25.0已验证一套完整组合的SAP GUI运行时行为，但不代表所有SAP标准图标、动态文本、复杂控件和多语言组合均已覆盖。
- 0.23.0安装器的本地和便携包受控预检已验证；真实 `w200`也已从0.23.0便携包完成 `status`和 `preflight`，三个助手均存在且已生成，函数组生成检查通过，整体 `ready=true`。旧ECC中基础助手和DDIC助手的 `ENLFDIR-ACTIVE`为空，但 `GENERATED=X`且此前已有真实调用证据，因此不作为失败条件。后续0.30.2已真实执行 `upgrade`并通过助手生成/活动预检；`install`和`repair`模式仍未真实执行。安装器不能在空白SAP系统中创建前置函数组、基础类或客户引导RFC，正式系统仍应优先使用经过审查的SAP传输。
- 0.24.0一键接入的受控脚本回归和便携包文件/启动回归已覆盖；真实用户环境也已在PowerShell 7可见窗口执行完整 `setup.ps1`：真实 `w200`预检整体 `ready=true`，已有Codex注册被识别为相同地址并保持不变，服务随后监听 `127.0.0.1:4847`，健康检查正常，MCP探针枚举62个工具并返回 `Connected SAP systems: w200`。验收结束后关闭该临时服务进程，用户后续可用同一入口重新启动。
- `get_abap_object_workspace_uri` 返回独立服务可消费的确定性ADT URI，不再承诺VS Code虚拟文件树路径。
- `w200` where-used在请求头兼容修复后由403变为404，证明账号/会话拒绝已排除，但当前ECC没有提供该ADT端点；不使用不完整源码扫描伪造where-used结果。
- `w200` 对T000、CVERS、SVERS和时区自由查询曾返回空结果；0.3.0会将每个空结果写入 `queryWarnings`，但无法凭空补足系统元数据。
- 独立 `abap_activate`工具未单独对带有预先存在非活动版本的对象执行；已验证的是精确替换内部复用的同一激活后端链路。
- 旧版已授权的函数组技术Include `LZCODEX_MCP_FG_0828F01`没有创建；ADT通用请求返回404，v2媒体类型端点返回501。0.26.0已改用仓库助手后备，并在准确批准对象 `LZCMCP_FG_0260F01`上完成真实创建和源码回读。
- `w200`不公开 `DDLS/DF`和 `DCLS/DL`创建类型，`ZCODEX_MCP_DDL_0828`与 `ZCODEX_MCP_DCL_0828`在写入前被拒绝并确认不存在；ECC 7.31不具备本阶段所需CDS创建能力。
- 0.30.0源码和DDIC删除已在真实 `w200`批准的临时对象范围内通过。透明数据库表、DDL、DCL及其他未列类型仍无删除入口；任何后续写入仍必须先批准准确对象、父对象、包、请求和清理范围。
- PROGRAM文本符号继续使用已验证的仓库助手路径。0.26.0将CLASS和FUNCTION_GROUP文本符号扩展为ADT优先、仓库助手1.7后备；真实 `w200`已对 `ZCL_CMCP_0260`和 `ZCMCP_FG_0260`的文本符号 `026`完成写入和回读。
- 基础助手 `1.0`仍不写入；仓库助手 `1.5`在1.4基础上增加原生CUA读取和受控写入，不代表所有结构化仓库对象均可写。1.5已安装到真实 `w200`，活动函数源码无诊断并通过Titlebar真实写入回归。
- 真实 `w200` 文本元素ADT锁端点返回HTTP 200但不返回锁句柄，文本元素URI激活返回 `No URI-Mapping defined`。0.26.0将该明确能力缺失分类为可进入ECC文本池助手后备；权限、网络和其他保存失败不会触发后备。
- 0.13.0透明表能力仅支持读取和新建，不支持现有透明表结构替换、技术设置变更、删除或重命名。`w200` 的ADT Discovery未公开消息类端点；0.26.0通过T100A/T100只读及受控新建助手后备完成 `ZCMCP_MSG_0260`真实创建和回读。0.30.0消息更新依赖仓库助手1.8；由于当前没有可靠的公开消息类删除路径可保证临时对象清理，真实增量更新验收尚未执行。
- `manage_transport_requests`在真实 `w200`查询当前用户 `WYS`成功。0.26.0对旧ECC不完整的ADT明细增加E070/E07T/E071只读助手后备，真实回读确认 `GR2K923421`、任务 `GR2K923422`及20条主请求/任务对象记录；不会释放传输。
- `adt_discovery_export`在真实 `w200`返回21个workspace和39个collection，但该旧ECC本次未返回template link、core discovery entry或RES_APP class；导出链路和四文件落盘已验证，空项不代表这些发现能力在该系统可用。
