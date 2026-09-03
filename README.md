# ABAP MCP Standalone - 无头化技术验证

这是独立 ABAP MCP服务的无头化技术验证。它不加载 VS Code、不启动 `Code.exe`，直接通过
`abap-adt-api 8.4.3` 访问 SAP ADT，并通过 Streamable HTTP公开70个读取、诊断、调试、导出和受控写入工具。

## 已实现工具

- `get_connected_systems`
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
- `get_write_operation_status`
- `list_write_recovery_operations`
- `release_write_operation_lock`
- `create_function_module_with_interface`
- `inspect_repository_assignment`
- `read_abap_screen`
- `upsert_abap_screen`
- `patch_abap_screen`
- `validate_dynpro_application`
- `read_abap_gui_definition`
- `patch_abap_gui_definition`
- `create_module_pool`
- `read_transaction_code`
- `create_transaction_code`
- `create_report_transaction`
- `read_abap_message_class`
- `create_abap_message_class`
- `update_abap_message_class`
- `read_ddic_domain`
- `upsert_ddic_domain`
- `read_ddic_data_element`
- `upsert_ddic_data_element`
- `read_ddic_structure`
- `upsert_ddic_structure`
- `read_ddic_transparent_table`
- `create_ddic_transparent_table`
- `read_ddic_table_type`
- `upsert_ddic_table_type`
- `delete_ddic_object`
- `search_abap_objects`
- `get_abap_object_info`
- `get_abap_object_lines`
- `get_batch_lines`
- `get_object_by_uri`
- `search_abap_object_lines`
- `get_abap_object_workspace_uri`
- `get_abap_object_url`
- `find_where_used`
- `get_sap_system_info`
- `get_version_history`
- `get_abap_diagnostics`
- `get_abap_sql_syntax`
- `execute_data_query`
- `run_atc_analysis`
- `run_unit_tests`
- `analyze_abap_dumps`
- `analyze_abap_traces`
- `manage_transport_requests`
- `abap_download`
- `adt_discovery_export`
- `replace_string_in_abap_object`
- `abap_activate`
- `create_object_programmatically`
- `delete_abap_source_object`
- `create_test_include`
- `manage_text_elements`

详细兼容边界见 `docs/tool-compatibility-matrix.md`。

第二阶段已经移植 DDIC 表、结构、表类型、数据元素和域的查询回退，以及 Enhancement 元数据读取。相关路径已通过 Mock SAP 后端测试，仍需在真实 ECC 7.31 系统验证。

## 本地验证

```powershell
npm install
npm run extract:baseline
npm run verify
```

## Windows便携包

使用 PowerShell 7 构建包含官方 Node.js `24.8.0` 运行时的独立 Windows x64 压缩包：

```powershell
npm run verify:release
```

产物生成在 `release/`。目标电脑不需要安装 Node.js、VS Code或 Code OSS。压缩包已经包含默认 `w200`的 `connections.json`。0.28.0首次使用可直接运行 `setup.ps1`：它使用一次安全密码依次完成SAP助手预检、Codex MCP注册和服务启动。只使用其他Agent客户端时增加 `-SkipCodex`。如果预检报告助手缺失，先运行 `install-sap-helper.ps1 -Mode install`，再重新执行 `setup.ps1`。

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

下次启动：

```powershell
cd C:\My\Workplace\Coding\vscode-abap\abap-mcp-standalone\release\abap-mcp-standalone-0.30.0-win-x64
.\start.ps1
```

看到 `Password for <用户名>@<连接ID>:` 后输入SAP密码并按回车，保持该窗口打开。健康检查为 `http://127.0.0.1:4847/health`。

在新的Codex任务中可以直接要求：

```text
使用 abap_fs_standalone MCP，先调用 get_connected_systems，然后在 w200 搜索 ZWMSTCTD01_FRM，并读取第1至20行。只读，不修改SAP对象。
```

当前独立版本提供70个工具。数据查询只接受单条只读 `SELECT`，强制 `internal`模式、`rowRange`和1000行上限；ATC不自动修复，ABAP Unit不自动激活，Dump和Trace只读取已有诊断数据。`abap_download`可将对象或包递归导出到显式绝对路径，默认拒绝覆盖现有目标；`adt_discovery_export`将四个Markdown文件写入便携目录的 `exports`。`manage_transport_requests`保留原工具的四个查询动作，用于读取用户传输、明细、对象清单和差异，不会创建、修改、删除或释放传输。

0.16.0新增无头ABAP用户调试工具，支持会话、Z/Y源码断点、调用栈、只读变量、单步和继续。只允许当前连接用户，不支持终端模式、变量写入或跳转行。本地Mock和MCP协议回归已覆盖调试流程；真实 `w200`调用 `/sap/bc/adt/debugger/listeners` 返回HTTP 404，因此该系统当前明确为不兼容，不能声明真实调试通过。

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

0.30.0补齐客户对象生命周期：`update_abap_message_class`使用14位版本令牌和显式 `add`、`update`、`remove`操作增量维护消息，保留未涉及消息并禁止清空消息类；`delete_abap_source_object`通过ADT原生锁和删除接口受控删除类、接口、程序、Include、函数组、函数组Include和函数模块；`delete_ddic_object`通过SAP DDIC助手1.4在依赖检查后受控删除域、数据元素、结构和表类型。三个工具都要求准确 `Z*`/`Y*`对象、正式包、已有请求、唯一操作ID、变更前SAP观察、明确永久删除确认（删除工具）和写后回读凭证。透明数据库表删除、自动SAP解锁、自动重试、自动回滚和传输释放仍不提供。本地Mock、SOAP生成器和MCP协议已验证；真实 `w200`对象生命周期验收尚未执行。

`sap_helper_status`是独立版本新增的只读扩展工具，通过 SAP SOAP/RFC 调用已安装的 `Z_CODEX_MCP_EXECUTE`。`ping`返回助手版本和就绪状态；`validate_target`由SAP侧检查 `Z*`/`Y*`命名空间、对象类型白名单和当前登录用户的 `S_DEVELOP`显示权限。该工具不修改SAP数据。真实 `w200/200` 已安装 `$TMP`函数组 `ZCODEX_MCP_CORE`、类 `ZCL_CODEX_MCP_CORE`和远程函数 `Z_CODEX_MCP_EXECUTE`；没有修改SAP标准对象，也没有创建或释放传输。

受控写入仅允许客户对象。源码链路支持类、类Include、接口、程序、Include、函数组、函数模块、函数组Include、DDL和DCL；每个可变对象及其父级归属都必须是 `Z*`或 `Y*`。0.30.0可受控删除类、接口、程序、Include、函数组、函数组Include和函数模块，但不删除DDL或DCL。结构化仓库链路支持创建模块池、创建或替换及增量维护经典Dynpro屏幕、读取和增量维护GUI Status/Menu Painter定义、创建和读取对话事务、创建Report事务，以及通过ECC助手读取、新建和版本化增量更新消息类。Report事务只允许新建，可选引用已存在的Variant。DDIC助手 `1.4`支持域、基于域的数据元素、平面结构和STANDARD/default-key表类型的读取、完整替换及依赖检查后删除，并支持透明表活动定义读取和客户透明表创建。透明表只允许新建，不允许替换或删除；ECC 7.31表名最多16个字符，新表字段必须引用数据元素，键字段必须连续位于字段列表开头，所有字段强制非空，并要求 `APPL0`、`APPL1`或 `APPL2` Data Class，默认禁止缓冲。写入要求正式包和已有传输，更新或删除DDIC对象还要求14位版本令牌。重命名和高层可视化控件设计器仍不在范围内。标准对象会在SAP写入前拒绝，服务不会创建或释放传输。真实SAP写入仍必须取得对象级批准。原版全部54个工具契约及独立化分类冻结在 `contracts/full-tool-baseline.json`。

0.15.0新增函数模块接口读取、带显式接口创建和仓库分配检查。`read_function_module_interface`返回导入、导出、更改、表参数、异常、源码及SHA-256指纹；`create_function_module_with_interface`仅在已有客户函数组中创建全新的客户函数模块，并校验参数重名、类型、源码、正式包和已有传输；`inspect_repository_assignment`只读返回包、父对象、开放请求/任务、活动状态和原始系统。旧ECC的ADT函数组创建端点返回405或501时，服务使用SAP仓库助手 `1.3`的 `RS_FUNCTION_POOL_INSERT`后备路径。函数模块创建、传输分配和接口仍由SAP回读验证，服务不创建或释放传输。

`create_object_programmatically`以原工具输入契约创建并激活客户源码对象，当前允许 `CLAS/OC`、`INTF/OI`、`PROG/P`、`PROG/I`、`FUGR/F`、`FUGR/FF`、`FUGR/I`、`DDLS/DF`和 `DCLS/DL`。创建前检查系统是否公开对应类型并调用SAP名称验证；旧ECC未返回可解释的验证结果或未提供验证端点时，服务仍保留本地名称、类型、包和传输限制，并让创建端点作最终判定。`FUGR/I`端点明确返回404、405或501时，0.26.0改由SAP助手在已存在的客户函数组内创建技术Include。对象、函数模块和父函数组执行 `Z*`/`Y*`限制。`$TMP`对象不得携带传输请求，非本地包必须提供现有传输号；`type=new`明确拒绝。`create_test_include`仅为现有客户类创建测试Include，创建前后检查结构，并协调锁定、传输、解锁和激活。两个工具都不会创建或释放传输，真实调用必须取得准确对象名的当前任务授权。

```powershell
$env:ABAP_MCP_DEV200_PASSWORD = "本次进程使用的密码"
$env:ABAP_MCP_CONFIG = "$PWD\connections.json"
$env:ABAP_MCP_PORT = "4847"
npm run build
npm start
```

MCP地址为 `http://127.0.0.1:4847/mcp`，健康检查为
`http://127.0.0.1:4847/health`。

`manage_text_elements` 对程序文本池使用SAP仓库助手，复用程序已有的开放传输分配并在写入后回读验证；0.26.0把同一后备扩展到类和函数组。真实 `w200` 的ADT文本锁端点返回空响应，文本元素URI也无激活映射，因此服务在该明确能力缺失时转用仓库助手1.7；`ZCL_CMCP_0260`和 `ZCMCP_FG_0260`的文本符号 `026`均已完成写入和回读。权限、网络或其他保存错误不会触发后备。

当前基础SAP助手版本为 `1.0`，开放 `PING`和 `VALIDATE_TARGET`；0.30.0便携包包含仓库助手 `1.8`和DDIC助手 `1.4`。真实 `w200`当前已验证的安装基线仍是仓库助手1.7和DDIC助手1.3；升级及0.30.0消息更新、源码删除和DDIC依赖删除尚未获准确临时对象授权，因此不能声明真实SAP通过。已验证基线中的Titlebar、Dynpro、消息类新建、类/函数组文本、函数组Include和传输明细保持有效；传输 `GR2K923421`未释放。面向其他SAP系统的正式安装应使用经过审查的SAP传输，不依赖客户引导RFC。

## 依赖选择

| 依赖                        |  固定版本 | 用途        | 选择原因                    |
| --------------------------- | --------: | ----------- | --------------------------- |
| `abap-adt-api`              |   `8.4.3` | SAP ADT通信 | 与当前 MCP内核版本一致，MIT |
| `@modelcontextprotocol/sdk` |  `1.29.0` | MCP协议     | 与当前 MCP内核版本一致，MIT |
| `zod`                       | `3.25.76` | 输入契约    | 与当前 MCP内核版本一致，MIT |

0.2.0便携包已完成本机无头冒烟验证。0.3.0诊断工具已完成Mock后端、协议和部分真实 `w200`验证。0.4.0新增受控精确替换与激活链路，并复用原ABAP FS针对ECC 7.31“有会话Cookie但无CSRF响应Token”的兼容处理。已在批准对象 `ZCODEX_FS_SYNC_0807`上连续完成两次无写入锁定/解锁，以及临时替换、保存、解锁、激活、诊断和反向恢复；最终活动源码与测试前SHA-256一致。0.4.1将原ABAP FS的请求标识头应用到全部ADT客户端，并为旧ECC类版本历史增加显式ADT内容类型重试；真实 `w200` ABAP Unit请求、版本列表、历史源码读取和版本比较均已通过。0.5.0新增只读传输请求查询，直接调用ADT用户传输和传输明细接口，不复用会改写用户传输视图配置的VS Code路径。真实 `w200`可查询当前用户传输列表，但该旧ECC的传输明细端点返回不完整结构，因此明细、对象清单和对比会明确报告不兼容。where-used现明确返回404，属于当前系统未提供对应ADT端点，而不是账号权限拒绝。0.6.0新增无头源码下载和ADT发现导出；最终便携包已在真实 `w200`下载 `ZCL_CA_HZ`的1个非空源码文件（141320字节），并在包内 `exports`目录生成4个发现Markdown文件。该旧ECC本次返回21个workspace和39个collection，但没有返回template link、core discovery entry或RES_APP class。0.7.0增加客户源码对象写入矩阵和父对象保护；真实 `w200`已只读解析类、程序、Include、函数模块和接口，标准对象硬拒绝及函数组技术Include写入流程由自动测试覆盖。0.8.0新增客户源码对象创建和类测试Include创建；在准确授权后，真实 `w200`已创建并激活 `$TMP`类、接口、程序、Include、函数组、函数模块和类测试Include。函数组创建通过媒体类型降级在v2成功；函数组和函数模块源码均已回读且无语法诊断。ECC 7.31不公开DDL/DCL创建类型，函数组Include创建端点即使使用v2媒体类型仍返回501，因此这些类型保持不支持。0.15.0新增3个函数模块接口工具，通过SAP仓库助手 `1.3`兼容旧ECC函数组创建、接口创建和仓库分配回读；真实 `w200`完成远程函数创建、激活、诊断、有效SOAP调用和异常SOAP调用验证。`analyze_anst_enhancements`属于本地XLSX分析工具，不是SAP核心能力，本阶段不引入Excel依赖。
