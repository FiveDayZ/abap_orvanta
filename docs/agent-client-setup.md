# Agent 客户端接入

启动 `start.ps1` 或 `start.cmd` 后，MCP 地址为：

```text
http://127.0.0.1:4847/mcp
```

推荐使用PowerShell 7运行 `start.ps1`。连接配置中的密码环境变量尚未设置时，启动器会在当前终端隐藏输入内容，密码只传给本次服务进程。`start.cmd`不会读取或保存密码，使用前必须自行设置对应环境变量。

## 首次一键接入

0.40.4便携包可直接双击 `open-settings.cmd`打开中文配置中心，完成本地连接配置、本次密码设置、只读连接测试和MCP服务启停。在“服务与接入”中复制地址或客户端配置；配置中心不自动修改Agent全局配置，也不安装SAP助手。此入口使用Windows自带PowerShell，密码仅存于进程内存，关闭浏览器标签页不会退出配置中心，应先停止服务再点击界面“关闭”。停止服务并关闭配置中心后，可双击 `update.cmd`校验并安装 GitHub Release 中的最新稳定版；连接配置、导出和外部状态目录会保留，SAP助手不会随之升级。

左侧复选框选择本次启用的连接；默认选中第一条，点击连接名称只切换编辑对象，不改变启用列表。只勾选 W200 时不要求 W300/W800 的密码，启动后后端只接收选中连接。删除按钮位于每条连接右侧；运行中的连接需先停服，未启用的连接可直接删除，最后一条连接也可删除。确认框支持取消和 Escape，删除只影响本地配置及会话凭据。勾选不写入连接文件，不改变命令行启动入口。

仍需使用原有自动预检/注册流程时，解压便携包后在PowerShell 7中执行：

```powershell
.\setup.ps1
```

该入口按顺序执行SAP助手只读预检、Codex MCP注册和服务启动，并只提示一次所选连接的密码。Codex中已有同名但地址不同的注册时，使用 `-ForceCodex`；只接入其他Agent客户端时使用 `-SkipCodex`。预检失败时不会继续注册或启动，也不会自动执行SAP安装、升级或修复。

## 下次启动

```powershell
cd C:\My\Workplace\Coding\vscode-abap\abap-mcp-standalone\release\abap-mcp-standalone-0.36.28-win-x64
.\start.ps1
```

输入密码后保持PowerShell窗口打开。关闭窗口即停止服务，下次启动会再次要求输入密码。

`setup.ps1`只为 `-ConnectionId`选中的连接复用一次密码；如果 `connections.json`还配置了其他连接，`start.ps1`会继续分别安全提示这些连接的密码。Codex桌面端注册后仍需要重新加载配置，当前任务不会热更新工具列表。

## 修改SAP连接

编辑便携目录中的 `connections.json`。文件可以配置一个或多个连接，每个连接格式如下：

```json
{
  "id": "w200",
  "url": "https://sap.example.invalid:44300",
  "client": "200",
  "language": "EN",
  "username": "DEVELOPER",
  "passwordEnv": "ABAP_MCP_W200_PASSWORD",
  "allowUnauthorized": false,
  "remoteFunctionAllowlist": []
}
```

需要指定ATC检查变式时，可增加可选字段 `"atcVariant": "变式名称"`；未配置时服务读取SAP系统默认ATC变式。`remoteFunctionAllowlist`仅接受准确的 `Z*`或 `Y*`函数名，不支持通配符，默认空数组会拒绝所有正式RFC调用。

修改后重启服务。`id`是Agent调用时使用的 `connectionId`；不同连接必须使用不同的 `id`和 `passwordEnv`。不要在JSON中增加密码字段。

## SAP助手一键安装与预检

当前源码使用 `Z_ORVANTA_MCP_*` 助手、`ZORVANTA_MCP_CORE` 函数组和 `ZCL_ORVANTA_MCP_CORE` 类。旧发布包仍使用其原有入口；需要构建并部署新版文件后才会切换运行服务。保留旧 SAP 对象，不执行旧对象删除，也不自动回退到旧助手。

便携包根目录的 `install-sap-helper.ps1`必须使用PowerShell 7。它读取同目录的 `connections.json`，在网络和配置检查通过后于当前可见终端隐藏输入一次密码；密码只作为当前PowerShell进程中的 `SecureString`传给随包引导脚本，不写入参数、配置或结果文件。

```powershell
.\install-sap-helper.ps1 -Mode status -ConnectionId w200
.\install-sap-helper.ps1 -Mode preflight -ConnectionId w200
.\install-sap-helper.ps1 -Mode install -ConnectionId w200
.\install-sap-helper.ps1 -Mode upgrade -ConnectionId w200
.\install-sap-helper.ps1 -Mode repair -ConnectionId w200
```

- `status`：只读检查 `Z_ORVANTA_MCP_EXECUTE`、`Z_ORVANTA_MCP_DYNPRO_API`、`Z_ORVANTA_MCP_DDIC_API`是否存在及已生成，并检查 `ZORVANTA_MCP_CORE`函数组生成状态；旧ECC的 `ENLFDIR-ACTIVE`可能为空，因此作为 `activeFlag`信息返回，不单独判定失败。
- `preflight`：执行相同只读检查，但任何助手缺失、未生成或函数组语法生成失败都会以失败退出。
- `install`：不覆盖已有函数，仅尝试创建缺失的三个客户助手API，然后执行完整预检。
- `upgrade`：保留已有基础入口，重建仓库助手和DDIC助手为当前便携包内版本，然后执行完整预检。
- `repair`：重建全部三个客户助手API，然后执行完整预检。

安装和修复只允许当前脚本中固定的 `Z*`客户API，不会修改SAP标准对象、创建传输或释放传输。它依赖客户引导RFC `Z_AW_RFC_ABAP_INSTALL_AND_RUN`，并要求客户函数组 `ZORVANTA_MCP_CORE`及基础类 `ZCL_ORVANTA_MCP_CORE`已经存在。全新系统和正式环境应使用经过审核的SAP传输部署这些前置对象；不要把客户引导RFC当作通用生产部署通道。

正式客户RFC调用凭证默认保存在 `%LOCALAPPDATA%\ABAP MCP Standalone\state`，不在便携包目录内。可在启动前设置 `ABAP_MCP_STATE_DIR`覆盖位置；该目录应仅允许当前Windows用户写入。凭证仅包含请求ID摘要、函数名、接口指纹、输入/输出摘要、时间和状态，不保存原始参数或密码。

工具范围同样在启动前用环境变量决定，默认 `full`：`ABAP_MCP_TOOL_PROFILE`取 `full`、`readonly`、`platform`、`dev`、`config`、`ops`之一，`ABAP_MCP_TOOL_DENY`在 profile 之上按名称去掉单个工具（逗号、分号或空白分隔，名称不存在时启动失败）。被收窄的工具不会出现在 `tools/list`，`tools/call`也会被拒绝。给只读用途的客户端配置 `readonly`可以显著减少会话启动时注入的工具定义体积；当前生效值见 `get_runtime_info.toolProfile`。完整清单见仓库 `docs/tool-index.md`。

## Codex

便携包内可执行以下命令自动注册，不会覆盖同名但地址不同的现有配置；确需替换时增加 `-Force`：

```powershell
.\configure-codex.ps1
```

默认使用独立名称 `orvanta`，因此不会改写原有 `abap_fs` 配置。删除该注册：

```powershell
.\configure-codex.ps1 -Remove
```

### 从旧名称迁移

ORVANTA 的默认 MCP 注册名和协议握手名称均为 `orvanta`。升级文件不会自动修改客户端中已有的 `abap_fs_standalone` 注册；运行新版配置器或使用配置中心生成的配置后，确认新名称可调用，再按需移除旧的独立服务注册。不要删除原 VS Code 服务的 `abap_fs` 注册。

为保持部署和历史调用凭证兼容，项目目录、npm 包名、便携包文件名前缀仍为 `abap-mcp-standalone`；`ABAP_MCP_*` 环境变量、状态目录和 `/health` 的 `server` 标识保持不变。75 个工具方法及参数契约不变。命名更新不代表商标或名称独占性查重。

也可以手工在用户级 `~/.codex/config.toml` 或受信任项目的 `.codex/config.toml` 中加入：

```toml
[mcp_servers.orvanta]
url = "http://127.0.0.1:4847/mcp"
```

本项目通过 `configure-codex.ps1`配置Codex的HTTP MCP入口。这里的配置器面向Codex，不代表ChatGPT桌面端会读取相同配置；其他客户端应按各自的MCP配置入口接入。

## 其他 Agent 客户端

支持 Streamable HTTP MCP 的客户端通常使用以下服务器定义；具体配置文件位置和外层字段名以客户端文档为准：

```json
{
  "mcpServers": {
    "orvanta": {
      "url": "http://127.0.0.1:4847/mcp"
    }
  }
}
```

当前已完成两层验证：

- `@modelcontextprotocol/sdk 1.29.0` 客户端完成协议初始化、工具枚举和调用。
- Codex CLI `0.92.0` 使用 Streamable HTTP实际产生 `mcp_tool_call`，调用 `get_connected_systems` 并返回 `Connected SAP systems: codex`。

Codex桌面端需要在注册后重新加载配置，当前会话不会热更新工具列表。Claude、Cursor等其他产品仍需分别执行真实安装与交互测试，不能只凭通用配置示例宣称兼容。

## Agent调用示例

```text
使用 orvanta MCP，先调用 get_connected_systems，然后在 w200 搜索 ZWMSTCTD01_FRM，并读取第1至20行。只读，不修改SAP对象。
```

```text
使用 orvanta MCP，在 w200 查询 ZCL_CA_HZ 的对象信息，再读取指定方法源码。不要调用原来的 abap_fs。
```

```text
使用 orvanta MCP，批量读取 w200 中 ZWMSTCTD01_FRM 和 ZCL_CA_HZ 的前10行，并分别汇总。
```

0.36.28源码注册85个工具，注册数不代表全部真实SAP路径通过。0.31.0新增只读 `get_capability_report`，应在连接新系统或升级SAP助手后先调用；它按真实只读探测结果区分本地、原生ADT、助手后备、不支持和未知，不会把工具注册当作系统可用证明。0.33.0至0.34.0补齐透明表字段追加、字段变更和受控删除；0.35.0的 `patch_function_module_interface`支持函数参数与经典异常的新增、重命名、属性修改和删除。破坏性操作必须提供最近读取的版本或指纹、准确包、已有请求、唯一操作ID和明确确认；透明表变更还要求数据丢失确认。写工具使用版本2凭证；未知结果先查询恢复中心，禁止直接换ID重试。客户对象写入限制为 `Z*`/`Y*`，正式包要求已有请求；支持本地对象的源码工具允许 `$TMP`但禁止携带请求。不创建或释放传输。

0.30.1要求`delete_abap_source_object`额外提供最近一次活动源码回读的SHA-256 `expectedFingerprint`。服务在SAP锁内再次读取并比较；不一致时返回`SOURCE_FINGERPRINT_CONFLICT`并解锁。源码创建、修改、激活、文本、屏幕和删除使用统一目标身份；函数组、函数模块和函数组Include按父函数组互斥。

0.30.2的`get_abap_object_lines`会返回完整未裁剪活动源码的`Full Source SHA-256`；删除时应直接使用该值。便携安装器从`BUILD-INFO.json`读取并报告实际产品版本。

0.33.0真实SAP验收脚本不会创建或清理透明表，而是在明确批准的现有客户表上保留一个新字段。执行前必须确认该字段属于正式设计并批准准确范围，然后运行：

```powershell
.\scripts\run-ddic-safe-append-validation.ps1 -ApproveWrite `
  -TableName <已批准Z或Y透明表> -FieldName <新字段> `
  -DataElement <活动数据元素> -PackageName ZABAP `
  -TransportNumber GR2K923421
```

若已批准专用测试表及后续SE11人工清理，可由同一脚本先证明对象不存在，再创建固定的`MANDT`/`VALUE`基线表并追加验收字段：

```powershell
.\scripts\run-ddic-safe-append-validation.ps1 -ApproveWrite `
  -CreateValidationTable -TableName ZCMCP_TAB_0330 `
  -FieldName APPEND_MSG -DataElement BAPI_MSG `
  -InitialDataElement BAPI_MSG -PackageName ZABAP `
  -TransportNumber GR2K923421
```

0.34.0破坏性透明表生命周期验收会新建临时表，验证字段删除、重命名、数据元素/键/非空属性修改和最终表删除。执行前必须批准准确表名、两个数据元素、包、请求及完整清理范围，并确认可能的数据丢失：

```powershell
.\scripts\run-ddic-table-lifecycle-validation.ps1 -ApproveDestructiveWrite `
  -TableName <已批准临时Z或Y透明表> `
  -InitialDataElement BAPI_MSG -ReplacementDataElement <活动数据元素> `
  -PackageName <已批准包> -TransportNumber <已有请求>
```

上述0.33.0模式发现同名表已存在时会拒绝执行，不覆盖或复用既有定义；成功后表和字段仍需在SE11中人工清理。0.34.0生命周期脚本只处理获批的全新临时表，并在成功路径验证受控删除和最终不存在。

0.35.0函数接口验收脚本只处理固定的临时函数组和函数模块。它依次验证未使用导入参数的新增、重命名、类型/可选/传值/说明属性修改和删除，并确认实现源码指纹不变、陈旧接口指纹被拒绝及最终清理：

```powershell
.\scripts\run-function-interface-patch-validation.ps1 -ApproveWrite `
  -PackageName ZABAP -TransportNumber GR2K923421
```

正式函数的参数被实现源码或调用方使用时，接口修改可能导致激活或兼容性问题。必须先评估所有调用方并准备人工恢复；该工具不会自动修改实现源码、自动回滚接口或自动重试。

若进程在SAP已完成追加后丢失本地成功凭证，可使用失败前记录的版本和指纹执行只读恢复核验。恢复模式不会再次追加字段，只接受与固定验证基线完全一致的表，并继续验证旧版本保护：

```powershell
.\scripts\run-ddic-safe-append-validation.ps1 -ApproveWrite `
  -ResumeValidation -TableName ZCMCP_TAB_0330 `
  -FieldName APPEND_MSG -DataElement BAPI_MSG `
  -PreviousVersion <追加前14位版本> `
  -PreviousFingerprint <追加前SHA-256指纹> `
  -PackageName ZABAP -TransportNumber GR2K923421
```

0.33.0脚本验证已有字段和表设置保持不变、新字段位于末尾且为可空非键字段、版本2凭证包含写前指纹，以及旧版本/指纹无法再次写入。该历史脚本仍保留字段，不会自动转用0.34.0破坏性删除路径。

## 写操作中断恢复

1. 在调用写工具前生成并记录唯一 `operationId`，同一次意图只能使用同一个ID。
2. 工具返回 `completed`时保存 `receiptHash`和 `resultHash`；返回 `failed`、`interrupted`、`target_concurrency_conflict`或响应丢失时，不得自动重试。
3. 使用 `get_write_operation_status`并传入原 `operationId`与连接ID。根据 `preChangeSummary`回读准确SAP对象，检查活动/非活动版本、SAP锁、包和开放传输分配。
4. 使用 `list_write_recovery_operations`只读查看中断和残留本地锁。只有原持有进程已结束且人工确认SAP最终状态后，才可调用 `release_write_operation_lock`，并传入原 `operationId`、最新 `receiptHash`、`confirmation=SAP_STATE_VERIFIED`和人工原因。存活、身份不确定或PID复用时均拒绝释放。
5. 结果未知时继续使用原 `operationId`查询，正式RFC同时保留原 `requestId`，禁止换ID绕过去重。只有人工明确原操作结果并批准一个新的操作后，才生成新ID并重新读取前置条件。

恢复操作只删除本服务的本地目标锁。它不会连接SAP清锁、重放原操作、重试网络请求或回滚业务RFC；原因正文不持久化，只保存SHA-256摘要。凭证版本1继续可读，但其 `sapInvocationStarted`为未知。两个RFC入口在输入校验和重复防护完成后、业务调用前记录开始标记；`sapInvocationStarted=false`不表示此前完全没有访问SAP，接口、DDIC及写前证据读取仍可能发生。

### 0.35.0升级与状态保留

先停止使用同一 `ABAP_MCP_STATE_DIR`的旧服务，备份并保留完整状态目录，再切换新包；禁止旧版和新版并行共享目录。M3为版本2凭证和版本1锁增加可选 `ownerPid`，旧版严格解析器可能拒绝新字段，不能把直接降级视为兼容。

无 `ownerPid`的历史凭证仍可读取，但在线恢复拒绝释放对应锁，需停止服务后离线核查；残留 `.recovery`标记也不会自动清理。不得删除凭证或状态目录以绕过保护。SAP助手升级是独立的授权操作：基础1.0、仓库2.0、DDIC1.6为历史接入基线，不代表当前所有助手版本；先只读预检并核对实际包和传输，启动包不会自动升级SAP。当前阶段状态见[全局实施基线](../../.doc/global-implementation-baseline.md)，离线交付与恢复检查见[M8交付清单](../../.doc/m8-offline-delivery.md)。

下面提及的 `scripts/run-*.ps1`为源码仓库开发验收入口，不随便携包分发。包内交付 `setup.ps1`、`start.ps1`、`start.cmd`、`configure-codex.ps1`、`install-sap-helper.ps1`及其所需探针和助手脚本。

示例：`operationId=agent-20260903-zobject-change-001`。操作ID不应包含密码、业务数据或其他敏感信息。

0.27.1已在真实 `w200/200`以临时模块池 `ZCMCP_SAFE_0271`验证完成、失败、重复ID、输入冲突、中断凭证和同目标并发冲突；创建时回读确认包 `ZABAP`、请求 `GR2K923421`和活动源码，删除后由独立ABAP FS搜索、对象信息和源码读取确认不存在。中断凭证由隔离状态目录模拟服务重启遗留，不代表真实SAP调用被强制中止。

真实 `w200`已验证 `$TMP`类、接口、程序、Include、函数组、函数模块和类测试Include创建。0.15.0在旧ECC函数组ADT创建端点返回405或501时使用SAP仓库助手后备创建；已在正式包中创建 `ZCMCP_FG_1501`和带完整接口的远程函数 `ZCMCP_FM_1501`，并通过接口回读、诊断、激活、仓库分配和外部SOAP正反例验证。0.26.0已通过SAP仓库助手在客户函数组 `ZCMCP_FG_0260`中创建并回读技术Include `LZCMCP_FG_0260F01`；对象位于 `ZABAP`和请求 `GR2K923421`，未释放传输。

0.17.0已通过 `test_remote_function_module` 对 `ZCMCP_FM_1501`完成真实MCP正反例验证：`IV_INPUT=VALIDATION`精确返回 `EV_OUTPUT=MCP:VALIDATION`，空输入返回声明异常 `INVALID_INPUT`。该结果仅证明此测试函数及当前标量契约，不代表其他客户RFC没有业务副作用。

0.18.0已通过 `test_remote_function_module` 对 `ZCMCP_FM_1801`完成真实结构化MCP验证：`IS_REQUEST`和 `ES_RESPONSE`使用 `BAPIRET2`，`CT_ITEMS`为 `BAPIRET2` TABLES参数；两行输入精确返回 `ROW:FIRST`和 `ROW:SECOND`，空消息返回声明异常 `INVALID_INPUT`。活动源码无语法诊断，仓库分配为 `ZABAP`、`GR2K923421`和用户任务 `GR2K923422`。

0.19.0已通过 `invoke_customer_function_module` 对 `ZCMCP_FM_1901`完成真实正式调用验证：IMPORTING `IT_ITEMS`和EXPORTING `ET_ITEMS`均使用 `BAPIRET2_T`，两行结果完整返回，空表返回声明异常 `INVALID_INPUT`；白名单、指纹、未知字段和201行限制均在函数调用前拒绝。活动源码无诊断，仓库分配为 `ZABAP`、`GR2K923421`和用户任务 `GR2K923422`。

`w200` 不公开可写ADT文本元素锁和激活映射。0.14.0对PROGRAM改用SAP仓库助手文本池路径；0.26.0将同一文本池后备扩展到CLASS和FUNCTION_GROUP。只有ADT明确不兼容时才进入助手路径；任意权限、网络或部分写入错误仍直接失败。真实写入前必须批准准确对象和文本ID。

助手调用示例：

```text
使用 orvanta 的 sap_helper_status，action=ping，connectionId=w200；只返回助手状态，不修改SAP。
```

基础SAP助手 `1.0`提供 `PING`和 `VALIDATE_TARGET`；0.35.0便携包提供仓库助手 `2.0`和DDIC助手 `1.6`。透明表安全追加和破坏性透明表生命周期已在真实 `w200`验证。临时表`ZCMCP_TAB_0340`已完成字段删除、重命名、数据元素/键/非空属性修改、陈旧定义拒绝和最终删除，且不得释放传输。

函数模块调用示例（创建前必须批准准确对象名）：

```text
使用 orvanta MCP，在 w200 先调用 inspect_repository_assignment 检查已批准的 Z* 或 Y* 函数组，再调用 create_function_module_with_interface 创建全新的客户函数模块。明确提供 IMPORTING、EXPORTING、CHANGING、TABLES、EXCEPTIONS 和 ECC 7.31兼容源码；packageName=ZABAP，transportNumber=GR2K923421。创建后调用 read_function_module_interface 回读接口与源码，并再次检查仓库分配、激活和诊断。不要覆盖已有函数，不要创建或释放传输。
```

函数模块功能验证示例（函数可能产生业务副作用，调用前必须批准准确对象名和输入）：

```text
使用 orvanta MCP，在 w200 调用 test_remote_function_module 验证 ZCMCP_FM_1501。先由工具回读活动接口；inputParameters={"IV_INPUT":"VALIDATION"}，expectedOutputs={"EV_OUTPUT":"MCP:VALIDATION"}，acknowledgePotentialSideEffects=true。不要调用标准函数，不要将Z/Y命名视为只读保证。
```

结构和表参数验证示例：

```text
使用 orvanta MCP，在 w200 先调用 read_function_module_interface 读取 ZCMCP_FM_1801，并设置 includeExecutionSupport=true。确认 executionSupport.supported=true 后，调用 test_remote_function_module；structureInputs提供IS_REQUEST，tableInputs提供CT_ITEMS，expectedStructureOutputs和expectedTableOutputs传入完整精确结果，并把回读的fingerprint作为expectedInterfaceFingerprint。acknowledgePotentialSideEffects=true。不要调用标准函数，不要省略对象级授权。
```

白名单客户RFC正式调用示例：

```text
确认 connections.json 的 remoteFunctionAllowlist 已包含用户明确批准的准确函数名并重启服务。使用 orvanta MCP，先调用 read_function_module_interface 且 includeExecutionSupport=true；核对接口和executionSupport后，将读取到的fingerprint传给 invoke_customer_function_module，并提供唯一requestId、准确输入和acknowledgePotentialSideEffects=true。返回超时或网络错误时不要自动重试，应先在SAP核对业务结果。
```

调用后可使用 `get_customer_function_call_status`和原 `requestId`查询 `completed`、`declared_fault`、`in_progress`或 `outcome_unknown`。`duplicate_blocked`表示相同调用已被本地凭证拦截，`request_id_conflict`表示该ID此前用于不同函数、接口或输入；两种情况的 `sapInvoked`均为 `false`。状态为 `outcome_unknown`时必须人工核对SAP业务结果，不能通过删除凭证或更换ID直接重试。

经典Report调用示例（执行前必须批准准确对象名）：

```text
使用 orvanta MCP，在 w200 对已批准的Z/Y可执行程序维护文本符号；如消息类不存在，使用 create_abap_message_class 新建；最后使用 create_report_transaction 创建指向该程序的Report事务。packageName=ZABAP，transportNumber=GR2K923421。已有消息类和事务不得覆盖，不创建或释放传输。
```

DDIC调用示例（写入前仍需批准准确对象名）：

```text
使用 orvanta MCP，在 w200 先调用 read_ddic_domain 读取当前版本。仅对已批准的 Z* 或 Y* 对象调用 upsert_ddic_domain；packageName=ZABAP，transportNumber=GR2K923421，更新时传入读取结果中的 expectedVersion。完成后再次回读并核对包、版本和定义。不要创建或释放传输。
```

生命周期删除调用必须先只读确认准确类型、父对象、包、请求、版本或指纹，再使用新的 `operationId`和 `confirmation=PERMANENT_DELETE`。函数组子对象必须提供 `parentName`；DDIC依赖返回 `DEPENDENCIES_EXIST`时停止并人工处理引用，不能强制删除。删除响应后再次搜索或读取确认对象不存在，并保存 `receiptHash`。任何网络中断或结果未知都先查询原操作凭证，不自动重试、不自动清除SAP锁。

透明表调用示例：

```text
使用 orvanta MCP，在 w200 先调用 read_ddic_transparent_table 检查对象不存在。仅对已批准且名称不超过16字符的新 Z* 或 Y* 对象调用 create_ddic_transparent_table；字段引用已激活数据元素，键字段连续放在字段列表开头，dataClass使用APPL0、APPL1或APPL2，packageName=ZABAP，transportNumber=GR2K923421。完成后再次回读并核对字段、键、非空属性、交付类、Data Class、包和版本。不要替换已有表，不要创建或释放传输。
```

经典Dynpro调用示例：

```text
使用 orvanta MCP，在 w200 只操作已批准的 Z* 或 Y* 客户对象。先创建模块池，再创建或更新屏幕，最后创建事务码；packageName 使用 ZABAP，transportNumber 使用 GR2K923421。完成后回读屏幕和事务，并验证激活与诊断。不要创建或释放传输请求。
```

增量维护屏幕时先调用 `read_abap_screen`取得最新 `fingerprint`，再调用 `patch_abap_screen`并显式列出每个 `add`、`update`或 `remove`；移动组件时使用 `update`修改 `LINE`和 `COLUMN`。修改Flow Logic后调用 `validate_dynpro_application`核对PBO/PAI模块方向和定义；然后通过精确源码编辑工具维护对应MODULE源码并激活。指纹陈旧时必须重新读取和人工合并，不要直接整屏覆盖。

维护GUI Status或Titlebar时先调用 `read_abap_gui_definition`，保存返回的 `fingerprint`并检查11个原生CUA分区。调用 `patch_abap_gui_definition`时只提交明确的行级 `add`、`update`或 `remove`，复合键字段必须完整；不要猜测内部编号或同时对同一行执行多个操作。补丁成功后再次调用 `validate_dynpro_application`，确认源码中的静态 `SET PF-STATUS`和 `SET TITLEBAR`均存在。指纹或SAP版本冲突时重新读取并人工合并，禁止自动覆盖。

创建本地测试类的Agent指令示例（执行前仍需用户批准准确对象名）：

```text
使用 orvanta MCP，在 w200 调用 create_object_programmatically，创建用户已批准的 Z* 或 Y* 类，packageName 使用 $TMP。创建后读取返回的 Workspace URI，写入兼容 ECC 7.31 的源码，激活并运行诊断。不要创建或释放传输请求。
```

`w200`的旧ECC ADT传输明细端点返回不完整结构时，0.26.0会转用E070/E07T/E071只读助手后备。真实回读已确认请求 `GR2K923421`、任务 `GR2K923422`及主请求和任务对象清单，且没有空任务行；查询和对比均不创建、修改或释放传输。

```text
使用 orvanta MCP，在 w200 调用 manage_transport_requests 查询当前用户的传输请求；只读，不释放或修改传输。
```

清理开放CTS任务条目前，先用 `manage_transport_requests` 的 `get_transport_objects` 动作读取父请求的完整对象清单、任务归属、`position`和 `Cleanup Fingerprint`。只有父请求与任务均为可修改状态、目标条目唯一且位置完整时，才可在取得准确清理授权后调用 `cleanup_transport_entries`，并提供新的 `operationId`、原指纹和 `confirmation=REMOVE_CTS_ENTRIES`。该工具不删除仓库对象，不删除或释放请求；网络中断或结果未知时先查询原操作凭证并人工核对SE09，不得自动重试。
