# SAP 助手能力自述协议（CAPABILITIES）设计稿

- 状态：**设计稿，未实现、未部署**（Track A / WP-A4）
- 日期：2026-09-17
- 涉及对象：`Z_ORVANTA_MCP_EXECUTE`、`Z_ORVANTA_MCP_DYNPRO_API`、`Z_ORVANTA_MCP_DDIC_API`、`Z_ORVANTA_MCP_QUERY_API`、`Z_ORVANTA_MCP_SCI_API`/`_V2`/`_E2`、`Z_ORVANTA_LOG_READ`、`Z_ORVANTA_OPS_READ`、`Z_ORVANTA_MAINT_READ`、`Z_ORVANTA_SMARTFORM_API`
- 涉及源码：`scripts/bootstrap-sap-helper.ps1`、`scripts/*-source.mjs`、`src/backend.ts`、`src/adt-backend.ts`、`src/capabilities.ts`

---

## 1. 问题与根因（已核实的证据）

1. 2026-09-17 实时 `get_capability_report(w200)` 返回 54 项能力，其中 **available 13 / unsupported 1 / unknown 40**。
2. 10 项 `repository-helper-*` 能力的 unknown 原因由报告自己给出：

   > "The read probe observed repository operation protocol 1.2; it does not prove whether capability version 1.3 is installed."

3. 根因在助手实现：`scripts/bootstrap-sap-helper.ps1` 中 `CASE iv_operation.` 的**每个分支各自设置 `ev_version = '1.x'`**（如 `WHEN 'READ_MESSAGE_CLASS'. ev_version = '1.2'.`，DDIC 侧同理 1.2/1.3/1.7）。因此 `ev_version` 表达的是**刚执行的那个操作码的协议版本**，而不是**该助手已安装的能力版本**。
4. 后果：
   - 服务无法区分「助手未部署」「助手已部署但版本不足」「助手已部署且能力可用」；
   - 也无法回答「SAP 侧装的到底是不是我打包的那份源码」；
   - `capabilities.ts` 只能保守地写 unknown，能力报告失去运维价值。

---

## 2. 目标

| #   | 目标                 | 判定标准                                                                          |
| --- | -------------------- | --------------------------------------------------------------------------------- |
| G1  | 助手能自述已安装能力 | 一次调用返回该助手支持的**最高协议版本**与**全部操作码清单**                      |
| G2  | 服务能区分四种状态   | `absent` / `legacy`（无自述）/ `outdated`（版本不足）/ `available`                |
| G3  | 可核对 SAP 侧交付物  | 返回助手所属**包、传输号、源码 SHA-256**                                          |
| G4  | 零破坏               | `PING` 语义不变；未实现该操作码的旧助手只返回 `OPERATION_NOT_SUPPORTED`，无副作用 |

非目标：不做自动部署、不做自动升级、不缓存到本地状态目录（每次探测实时执行）。

---

## 3. 协议设计

### 3.1 请求

在现有 RFC/HTTP 助手上新增一个操作码，复用现有请求信封：

```abap
iv_operation = 'CAPABILITIES'
```

**不新增导入参数**（见 3.4 修订 R1）：所需最低协议版本由服务侧本地比较，助手只负责自述事实。

### 3.2 响应

复用现有 `ev_status / ev_code / ev_version / ev_message` + `it_source` 行载荷（`add_payload` 宏，`|` 分隔，`%`→`%25`，`|`→`%7C`）。

```text
ev_status  = 'S'
ev_code    = 'CAPABILITIES'
ev_version = '2.6'          " 该助手支持的最高协议版本（唯一权威含义）
ev_message = 'ORVANTA helper capabilities'

it_source 行（按序）：
HELPER|<FUNCNAME>                        " e.g. Z_ORVANTA_MCP_DYNPRO_API
PROTOCOL|MIN|<x.y>                       " 仍兼容的最低协议版本
PROTOCOL|MAX|<x.y>                       " = ev_version，冗余但便于校验
OPERATION|<OPCODE>|<sinceVersion>|<R|W>  " 每个操作码一行，e.g. OPERATION|READ_MESSAGE_CLASS|1.7|R
SCOPE|<scope>|<enabled|disabled>         " 需单独批准的范围，e.g. SCOPE|SM37_DETAILS|enabled
SOURCE|HASH|<sha256>                     " 生成期注入的源码指纹
SOURCE|PACKAGE|<package>
SOURCE|TRANSPORT|<request>|<task>
RUNTIME|HOST|<SID>/<CLIENT>
RUNTIME|TIME|<YYYYMMDDhhmmss>|<TZ>
```

要点：

- **`ev_version` 语义被重新定义为「助手支持的最高协议」**。这是唯一的破坏性语义变更，但它只影响 `CAPABILITIES` 这一个新操作码；**其它操作码的既有 `ev_version` 保持原值不变**，老客户端行为不变。
- `SOURCE|HASH` 由生成器在打包时计算并写入 ABAP 常量；服务侧与 `BUILD-INFO.json` 中的助手指纹比对，即可回答「SAP 侧是不是这份源码」。
- `SCOPE` 行让「已部署但范围未批准」（如 `SM37_DETAILS`、`SP01`、日志读取批准门禁）第一次变得可被机器判定。

### 3.3 生成器与部署改动

| 文件                                                          | 改动                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `scripts/bootstrap-sap-helper.ps1`                            | 在每个助手的 `CASE iv_operation.` 顶部增加 `WHEN 'CAPABILITIES'.` 分支，输出上述载荷；`SOURCE\|HASH` 由脚本在生成时替换占位符 |
| `scripts/*-source.mjs`（log / ops / maint / sci / smartform） | 同上，各自补 `CAPABILITIES` 分支                                                                                              |
| `scripts/deploy-*.mjs`                                        | 部署前后各调用一次 `CAPABILITIES`，把 `SOURCE\|HASH` 写进部署证据文件                                                         |

### 3.4 设计修订（2026-09-17 实施期确定）

| #   | 修订                                                                                                                                                                                                                                                                                                                     | 依据与影响                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **取消 `iv_expected_version` 与 `CHECK\|EXPECTED` 行。** 所需最低协议版本由服务侧本地比较（服务本来就知道每项能力所需的 minimumVersion）。                                                                                                                                                                               | 该参数名**已被并发控制语义占用**：`bootstrap-sap-helper.ps1` 中 `iv_expected_version` 在 DDIC_API（约 1498、1597–1609 行）与 DYNPRO_API（约 7168、7192、7280、7353 行）里表示“调用方期望的对象版本”，用于乐观并发校验。复用它做协议协商会造成同名字段双重语义。取消后首个助手 `Z_ORVANTA_MCP_EXECUTE` 的函数接口**完全不变**，满足 G4 零破坏。 |
| R2  | 首个落地范围仅 `Z_ORVANTA_MCP_EXECUTE`。                                                                                                                                                                                                                                                                                 | 其背后的 10 项 `repository-helper-*` 能力（minimumVersion 1.1–2.6）当前全部为 unknown，价值最高。                                                                                                                                                                                                                                              |
| R3  | **仅以 `EV_RESULT` JSON 为契约的助手，把载荷行放进同一信封的 `payload` 数组**（`{"version":"1","status":"S","code":"CAPABILITIES","message":"ORVANTA helper capabilities","readOnly":true,"payload":[…]}`），行种类、取值与顺序与 §3.2 完全一致；服务侧对应放宽 `.strict()` 信封（仅新增可选 `payload`）并复用同一解析。 | `Z_ORVANTA_MAINT_READ`、`Z_ORVANTA_OPS_READ` 既没有 `it_source` 表，也不返回 `ev_status`/`ev_code`/`ev_version`，JSON 信封是它们唯一的应答通道，不存在第二种载体。R3 由用户在 2026-09-17 明确选定（备选是给两个助手新增行表参数，改动接口契约，未采用）。                                                                                      |
| R4  | **`since` 的含义随助手契约而定，且必须在助手中写明**：既有 `x.y` 协议版本的助手取该操作自身分支的 `ev_version`；DDIC 助手取 `src/capabilities.ts` 中 `ddic-helper-*` 分组的最低版本（8×1.2、2×1.5、5×1.6、4×1.7，MIN 1.2／MAX 1.7）；无 `ev_version` 的 JSON 助手取应答信封自身的修订号（`"version":"1"` → `1.0`）。     | DDIC 的 `CASE` 只设置 `lv_object_type`/`lv_write` 标志，真正的 `ev_version` 字面量散落在共享代码路径深处，逐分支扫描无法推导，故记录**契约最低版本**而非历史实现版本（用户 2026-09-17 选定）。JSON 助手的 `1.0` 同理是其信封修订号，为与 `x.y` 可比而编码为 `1.0`。三种含义都写入生成器注释，避免把契约读成历史。                              |
| R5  | **`CAPABILITIES` 豁免助手的调用前输入/权限校验**，但只豁免该一个操作码，其余业务分支校验逐字不变。                                                                                                                                                                                                                       | 该操作不需要调用方输入、不读业务数据、只回自述，与 `Z_ORVANTA_MCP_EXECUTE` 在业务逻辑之前就应答的行为一致。用户 2026-09-17 接受（备选是让自描述也走各助手的业务校验，未采用）。生成器改动已用「新旧渲染逐行多重集对比」验证：除该豁免与新增工作字段外无任何业务行变化。                                                                        |

### 3.5 后续补齐清单（同一协议，逐文件落地）

| 目标                                                                  | 位置                                                                                                                               | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`Z_ORVANTA_MCP_DDIC_API`~~ **已实现（未部署）**                     | `scripts/bootstrap-sap-helper.ps1` 的 `New-DdicFunctionSource`；提交 `d737997`                                                     | 19 个操作码；`since` 按 R4 取契约最低版本；占位符与仓库助手逐字节相同，复用既有哈希替换；另有 5 项漂移测试。部署需先删除再生成（`-ReplaceExisting`），用户 2026-09-17 决定暂不部署                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Z_ORVANTA_MCP_DYNPRO_API`（GUI/屏幕体）                              | 同上文件，非 DDIC 分支（`$repositoryFunctionSource` 之外的 GUI/屏幕体）                                                            | **经复核，原判断有误：不存在独立的 GUI/屏幕体会。** `bootstrap-sap-helper.ps1` 只创建三个函数模块（`New-InstallProgram` 的 `-FunctionName` 取值仅 `Z_ORVANTA_MCP_EXECUTE`（默认）、`Z_ORVANTA_MCP_DYNPRO_API`（行 9030）、`Z_ORVANTA_MCP_DDIC_API`（行 9036）），且 EXECUTE 与 DYNPRO_API 共用同一份 `$repositoryFunctionSource` 体（仅助手指纹行按 `$FunctionName` 插值）。因此该助手的 GUI/屏幕相关操作早已随共享体一起自述：2026-09-18 实测其 `self-described`、协议 1.1–2.6、36 个 `OPERATION` 行。`New-GuiApiInspectionProgram`／`New-GuiObjectInspectionProgram` 只由 `InspectGuiApis`／`InspectGuiObject` 模式调用，生成的是临时 SE80 式巡检程序，不是助手，不适用本协议                                                                                                                                                  |
| ~~`Z_ORVANTA_MAINT_READ`~~ **已实现；含 `CAPABILITIES` 的版本未部署** | `scripts/maintenance-diagnostic-source.mjs`；提交 `c988648`                                                                        | 3 个操作码；按 R3 走 JSON `payload`；按 R5 豁免 `CAPABILITIES` 的前置校验。助手**本身已部署**在 w200（FUGR/FF、函数组 `ZORVANTA_MAINT`、包 `ZABAP`；原请求/任务 `GR2K923421`/`GR2K923422` 实测均已释放（`R`），当前**无开放分配**，CAPABILITIES 版本改挂 `GR2K923472`/`GR2K923473`）。生成器原先发布空的 `SOURCE\|PACKAGE`/`SOURCE\|TRANSPORT` 行，已按该证据修正                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ~~`Z_ORVANTA_OPS_READ`~~ **已实现；含 `CAPABILITIES` 的版本未部署**   | `scripts/operational-log-source.mjs`；提交 `c988648`                                                                               | 6 个操作码（按生成特性门控）；同样适用 R3／R5。助手本身已部署（包 `ZABAP`；原请求/任务已释放、当前无开放分配，CAPABILITIES 版本改挂 `GR2K923472`/`GR2K923473`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Z_ORVANTA_LOG_READ`（`application-log-read-source.mjs`）             | 该文件只是 READ 分支片段；完整 FM 体（含 SEARCH/DISCOVER）不在仓库中                                                               | 回复契约是单个 `EV_RESULT` JSON，**R3 适用**。2026-09-18 实读线上体（654 行、IF/ELSE 链、无 `CASE`）确认：5 个操作码——`SEARCH`（默认动作，行 46）、`DISCOVER`、`READ`、`READ_DIAGNOSTIC`、`READ_BODY_CHECK`；派发前**没有拒绝式前置门**，因此 `CAPABILITIES` 分支本身可达、**不需要 R5 豁免**，但必须放在 `CLEAR ev_result`（行 45）与默认信封预置（行 51-58）之前，或在该分支内自行覆盖 `ev_result`。信封已带 `"version":"1"`，故 `since` 按 R4＝`1.0`（实测确认而非推断）；未知动作返回 `READ_ONLY_UNSUPPORTED` 而非 `OPERATION_NOT_SUPPORTED`，§4.1 的降级规则需扩展。仓库仍只有 READ 片段（`SEARCH`/`DISCOVER` 的 ABAP 不在仓库中，仅有断言），须先做「把 `Z_ORVANTA_LOG_READ` 全体回迁为生成器＋标记式操作码表」的改造；**无需接口变更**。服务侧另需通道条目、探询接线，以及 `src/application-logs.ts` 信封加可选 `payload` |
| `job-spool-source.mjs` / `report-parameters-source.mjs`               | **不是独立助手**：分别是 `Z_ORVANTA_OPS_READ` 的 `JOB_SPOOL` / `REPORT_PARAMETERS` 分支                                            | **不适用——已被 OPS 协议覆盖**：OPS 操作码表已含这两行并按生成特性门控（`requires`）。若在这两个片段内再加 `CAPABILITIES`，会在同一函数模块内产生重复的 `WHEN 'CAPABILITIES'` 与重复的 `OPERATION` 行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `sci-v2-source.mjs` / `sci-e2-source.mjs`                             | `Z_ORVANTA_MCP_SCI_V2` / `Z_ORVANTA_MCP_SCI_E2`（实测函数组 `ZORVANTA_MCP_CORE`、包 `ZABAP`、请求 `GR2K923472`／状态 `D`、已激活） | **暂不适用**：无 `CASE` 分派、只有 2 个操作码（`PRECHECK`/`RUN`），且回复是 `EV_*` 标量＋`ET_RESULTS` 表——**既无 `it_source` 也无 `EV_RESULT`**，R3 载体不存在。需先做「为 SCI 助手定义能力回复载体（新增导出表或专用通道）」的改造，属**接口变更**（会使已钉住的指纹失效）。未知动作返回 `INVALID_ACTION` 而非 `OPERATION_NOT_SUPPORTED`，§4.1 的降级规则需扩展；`since` 需新增修订（R6）而非猜测。E2 由 V2 文本替换派生，应合并处理                                                                                                                                                                                                                                                                                                                                                                                            |
| `scripts/deploy-*.mjs`                                                | `scripts/deploy-helper-capabilities.mjs`（新增，dry-run／`--apply-approved`）                                                      | 部署前后取证：dry-run 先只读证明线上体等于记录的部署前基线、替换上下文在编辑文本中唯一，并把生成器渲染的 `SOURCE\|HASH` 作为验收值；`--apply-approved` 才做一次 `replace_string_in_abap_object`，随后校验诊断、接口指纹、体哈希、摘要与 TADIR 读回，并把**回滚前置镜像**（旧体全文，仓库内无第二份）落到证据目录。**升级请求：复用 `GR2K923472`**；生成器的 `SOURCE\|TRANSPORT` 已改为 `GR2K923472\|GR2K923473`，与线上 TADIR 分配一致（旧 `GR2K923421`/`GR2K923422` 实测为 `R`，已释放）。`GR2K923472` **不得释放**                                                                                                                                                                                                                                                                                                             |

**已部署版本核对（2026-09-18，只读）**：把 w200 上两个助手的当前源码取出，与生成器在 `c882b9f`（引入 `CAPABILITIES` 之前）的渲染结果逐行比对，两者**逐字一致**：

| 助手         | 部署总行数 | 构成                                                  | 比对结果           |
| ------------ | ---------- | ----------------------------------------------------- | ------------------ |
| `MAINT_READ` | 321        | 17 行接口 + 303 行 `maintenanceDiagnosticSource` 体   | 303/303 完全一致   |
| `OPS_READ`   | 1070       | 23 行接口 + 1047 行 `operationalLogReportSource` 变体 | 1047/1047 完全一致 |

**交叉结论（2026-09-18，只读分析）**：

- 这些助手的自描述**当前不改变任何能力判定**：`src/tool-registry.ts` 给 LOG/OPS/SCI/SMARTFORM 的 `minHelperProtocol` 均为 `null`，且 `src/capabilities.ts` 只探询五个助手，MAINT/OPS 的自述也只作为记录、不参与判定。因此即便它们自述成功，也只会多一条 `helperAttestation`（价值在包/请求/源哈希等溯源信息），不会改变可用性判定；要产生判定价值需同时扩展 tool-registry 与探询接线。
- `docs/sci-compatibility.md` 记 SCI 助手传输为 `GR2K923421`（未释放），但 2026-09-18 实测该请求为 `R`（已释放），该陈述已过期；SCI 助手的活动函数组（文档 `ZORVANTA_MCP_CORE` vs 创建时 `ZCODEX_MCP_CORE`）与接口参数表未在仓库中固化，属未验证项。

结论：仓库生成器仍是这两个助手的唯一事实来源，没有手工漂移，因此本轮升级是**干净重生成**（MAINT 体 303 → 356 行，OPS report 变体 1047 → 1099 行），升级后 `SOURCE|HASH` 可直接作为部署证据使用。

**体哈希与 `SOURCE|HASH` 验收取值（2026-09-18 实测／重算）**：

| 助手                                | 线上体哈希（部署中）                                               | 升级后体哈希（当前生成器）                                         | 升级后应自述的 `SOURCE\|HASH`                                      |
| ----------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `Z_ORVANTA_MAINT_READ`              | `f2a1580c9ab7560d882af51d6c9152933248c0d51026ac56024417d540b763be` | `4f373280253d2287193cec1b9a16def6e7f41fdc21c95b3e4790f274533c7a0a` | `69f20bb0907f0a508b14efc3609695d959d8c6c4f9f89026f22586733fc2a066` |
| `Z_ORVANTA_OPS_READ`（report 变体） | `6cd998bf1e80e61e5d3c20ea416997a3310cc20611919134fe779149b95210ea` | `dd6975b1bdbe5cad935d0490fef21966919604c7435cf00da8639efd36bcaf6c` | `0781c11ded0de139c633066b1e4774f15e9b782053162aad984b78f0b7877ce1` |

- 体哈希＝生成器导出的体数组按 `\n` 连接后的 SHA-256。线上体自 `DATA:` 起、`ENDFUNCTION.` 前止（尾随空行已去），与生成器数组一致——这一点由上文逐行比对证明。
- `SOURCE|HASH` 是**自指哈希**：生成器在四个 `ORVANTAHASHSLOT1..4` 占位符仍在体中时取 SHA-256，再把该摘要填回占位符。因此不能用渲染后的文本直接重算，必须先还原占位符（`capabilityBodyDigest`）。
- 上表末列随生成器演进会变化，部署验证器在运行时重算（`helperCapabilityDigests`）；此处记录的是当前 HEAD 的取值。

**升级部署尝试（2026-09-18，未写入）**：两个目标只读 dry-run 通过后执行 `--apply-approved`，SAP 在写入阶段返回
`HTTP 423 Resource MAIN Z_ORVANTA_MAINT_READ is not locked (invalid lock handle …)`。服务回执标记
`sapInvocationStarted=true`、`outcomeMayBeUnknown=true`、`localLockReleased=true`，并明确要求先读回核对、不得自动重试——本次遵守。

- **读回核对结果**：`Z_ORVANTA_MAINT_READ` 线上体仍为 `f2a1580c…`（303 行）、分配仍为空，即**对象未被修改**，写操作未生效。
- 已确认写入路径要求 stateful ADT 会话（服务已满足，错误中 `stateful=true`）；打包版 0.45.0（`e568fe1`）与仓库 HEAD 之间**没有**与锁相关的服务端改动，因此"换用更新的构建"不构成修复假设。
- 只读诊断尝试：`search_sap_locks`（用户 `WYS`）返回 `status=unavailable, code=HELPER_NOT_APPROVED`——读取 SM12 需要一个另行部署并通过指纹批准的锁助手，当前 w200 不具备，故**SAP 侧锁状态无法观测**。
- 未执行：任何重试、锁清理、传输操作或对象删除。
- 两条待用户处置的候选（见任务报告）：把两个对象分配到 `GR2K923472`（bootstrap 的 `AssignPackageTransport` 模式或 SE80 手工分配）；以及在 SM12 中确认／清理可能残留的会话锁（这两个对象此前无开放分配，历史会话中断可能留下锁项）。
- 追加诊断（2026-09-18 09:20）：`get_write_operation_status` 复核该操作（`capabilities-maint-1789693304068`）为 `status=failed`、`localLockReleased=true`、`outcomeMayBeUnknown=true`；`list_write_recovery_operations` 返回 `count=0`、`automaticCleanup=false`。即**服务侧没有挂起或待恢复的写操作**，`release_write_operation_lock` 无对象可释放，失败点只落在 SAP 对 PUT 的拒绝上。
- 该次调用与历史上成功的 `scripts/deploy-report-parameters.mjs` **逐参数同形**：同一工具、同样的 `fileUri` 推导（`get_abap_object_workspace_uri` 的 `Workspace URI:`）、同样传 `transportNumber`／`operationId`／`expectedSourceFingerprint`。因此失败不是脚本参数或调用形状问题，而是运行期 SAP 侧状态；排查 SM12 时应同时看**其他用户**是否持有这两个对象——若某个加锁步骤被静默放弃而调用继续执行，随后的 PUT 就会以本条 423 被拒。
- 追加诊断（2026-09-18 09:24，一次受控重试后）：以新 `operationId` 重试一次，仍以同一 423 被拒，但**锁句柄是新的**（`JPJS3SdWevuvqRcEKrfJKFsnixE=`），且读回显示对象体仍为 `f2a1580c…`／303 行、TADIR 分配仍为空 ⇒ 该失败**可复现**，不是瞬时冲突；随后按回执要求停止，不再重试。
- 服务端源码核对（只读）：`src/adt-backend.ts` 的替换路径先 `client.lock(target.objectUri, "MODIFY")`（行 3594）、再 `client.setObjectSource(target.sourceUri, …)`（行 3630），而 `objectUri = sourceUri.replace(/\/source\/main$/i, "")`（行 3765）——即"锁对象、写其源码"的规范配对，与错误中的 PUT URL 一致。**加锁调用本身是成功的**（失败会走 `capabilityFailure("lock")` 分支），被拒的是随后携带该句柄的 PUT。因此这不是服务的 URI 映射缺陷，也与同族对象的历史成功写入不矛盾：失败点在 SAP 侧的会话／锁状态。
- 仍未执行：锁清理、传输分配、传输释放、对象删除；`release_write_operation_lock` 未调用（服务侧无待恢复操作，无对象可释放）。
- 追加诊断（2026-09-18 09:32，4848 仓库构建／全新 ADT 会话）：**同样失败，且证明是系统性的**。MAINT 经 4848 重试仍得同一 423（新句柄 `fMbdAxTCicWXCrnzJ4XTGCJCDjY=`）；再换**另一个对象** OPS（函数组 `ZORVANTA_LOG`）同样被拒（新句柄 `p+UCUCFRgqnu7PAk/fPVCKifaVY=`）。至此共 **4 次写入尝试、2 个服务进程（4847／4848）、2 个对象／函数组**，全部呈现"加锁成功、PUT 被拒"，两个对象读回均等于部署前基线（`f2a1580c…`／303、`6cd998bf…`／1047，分配均为空）。**因此与本地服务进程无关，属 SAP 侧系统性拒绝。**
- 传输复核（只读）：`GR2K923472` 状态 `D`、owner `WYS`、恰好 1 个任务 `GR2K923473`（`D`、0 对象），主传输含 `ZORVANTA_MCP_CORE`(FUGR) 与 `ZCL_ORVANTA_MCP_CORE`(CLAS)，清理指纹 `e472cc4cdfaa3ec18252f682b885a263f94f96cfb7f6c1bb8aad3c1f6c7167a8` ⇒ **传输侧健康，不是成因**。
- 下一步指向 SM12：需检查**任意用户**（不只 `WYS`）是否在这两个对象／函数组上持有锁，并确认没有 SAP GUI／SE80／SE37 编辑器正打开它们——会话被中断或对象被打开都会留下锁项，使加锁调用仍返回句柄而 PUT 被拒。若 SM12 干净，剩余嫌疑是该系统（7.31 SP04）上的 ADT 加锁／会话行为本身，届时需另行授权排查服务端，或改用其他构建做对照实验。
- 排查结论（2026-09-18 09:38，用户确认 SM12 无锁、无打开后授权排查）：**最可能的成因是这两个对象当前没有任何开放传输分配**。历史记录证明该工具在本系统上确实成功写过函数模块，且当时对象是有分配的：`code-update-20260910-172621.md` 记录 `ZORVANTA_MAINT` 创建时"用户明确批准：函数组 `ZORVANTA_MAINT`、RFC `Z_ORVANTA_MAINT_READ`、包 `ZABAP`、请求 `GR2K923421`。实际归属任务 `GR2K923422`"；`code-update-20260907-110620.md` 记录分配回读为"请求为 `GR2K923421`"；`code-update-20260910-095944.md` 以显式 `GR2K923421` 更新源码成功。释放 `GR2K923421` 会清掉这些开放分配，于是两个对象现在 `requestNumber`／`taskNumber` 均为空。
- 同一族的历史拒绝也有记录：`code-update-20260908-123029.md` 的"对象锁定请求 `GR2K923421`，不能使用任务号 `GR2K923422`；保存前被拒绝"——说明 SAP 把**加锁与对象的传输绑定**一起校验，绑定不一致即在保存前拒绝，本轮的 423 属同一族。
- 处置：把 `R3TR FUGR ZORVANTA_MAINT` 与 `R3TR FUGR ZORVANTA_LOG` 加入任务 `GR2K923473`（请求 `GR2K923472`，函数模块随函数组传输）后再写入。服务的 `manage_transport_requests` 明确只读（"Never creates, assigns, activates, deletes, or releases"），`cleanup_transport_entries` 只做移除，故该分配只能由用户在 SE01／SE09 完成。
- 顺带排除库层编码问题：`abap-adt-api` 8.4.3 的 `setObjectSource` 经 axios `params` 传 `lockHandle`（`AxiosHttpClient.js` 行 45），axios 会做百分号编码；`unLock` 里额外的 `encodeURIComponent` 反而可能导致双重编码，但不影响写入判定。
- 新增前置校验（本轮代码变更）：`deploy-helper-capabilities.mjs` 在读到分配之后、生成回滚前置镜像与调用唯一一次写入之前，调用 `helper-capabilities-evidence.mjs` 中的纯函数 `assertOpenAssignment`。对象没有开放传输分配时立即停止，并给出可执行信息（对象名、要分配的 `FUGR`、请求 `GR2K923472`、任务 `GR2K923473`、SE01/SE09），证据里记 `dry_run_blocked`（应用模式记 `stopped`）并以非零退出；这样不会再以 423 收场，也不会为注定失败的运行留下前置镜像。该守卫不新增任何变更类工具调用，仍只有一个 `replace_string_in_abap_object`。

**部署取证路径（2026-09-18 实测结论）**：

- **不可用**：用 `test_remote_function_module` 探询 `CAPABILITIES`。该工具要求至少一项输出期望（`src/tools.ts:1670-1676`，报错 `Provide output expectations or expectedException, but not both`），且期望值按**精确**比较（`assertExpectedRemoteOutputs` → `isDeepStrictEqual`，`src/tools.ts:9951`，无通配或正则）；而 `CAPABILITIES` 回复含主机、时间与自指 `SOURCE|HASH`，写不出精确期望。实测该调用还会预留一条失败的写操作回执，因此它并非无副作用的只读探针。
- **可用**：只读的 `get_capability_report`（`src/contracts.ts:268`；其说明明确探询不触发写、不清锁、不重试、不声称回滚）已返回按助手解析好的 `helperAttestation` 条目：`helper`、`minProtocol`/`maxProtocol`、`operations[]`（`opcode`/`since`/`write`）、`scopes`、`sourceHash`、`packageName`、`transport`、`host`、`observedAt`、`attestation`、`detail`。实测 `Z_ORVANTA_MCP_DYNPRO_API` 已完整自述（1.1–2.6、36 个操作），而 `MAINT_READ`/`OPS_READ` 当前为 `attestation: "operation-scoped"`、`sourceHash`/`packageName`/`transport` 等均为 `null`——这正是升级前的期望状态，也是升级后必须改变的证据。
- 因此部署取证以**服务侧唯一解析器**为准：部署脚本只读该报告，再把协议区间、操作码表、`sourceHash`、包与请求逐项与生成器表比对，并另行校验线上体哈希；脚本不再自带第二份行解析器，以避免与服务侧实现漂移。

**服务侧实况复核（A4-4，2026-09-18 只读）**：用含本协议的构建探询 w200，`helperAttestation` 返回**五条**记录且报告未报错：

| 助手                       | 判定               | 说明                                                              |
| -------------------------- | ------------------ | ----------------------------------------------------------------- |
| `Z_ORVANTA_MCP_EXECUTE`    | `operation-scoped` | 自述省略 HELPER 标识行，按设计降级；不影响既有能力判定            |
| `Z_ORVANTA_MCP_DYNPRO_API` | `self-described`   | 协议 1.1–2.6、36 个 `OPERATION` 行，并带 `SOURCE\|HASH`、包与请求 |
| `Z_ORVANTA_MCP_DDIC_API`   | `operation-scoped` | 按操作码作用域应答（本地已实现 19 个操作码，尚未部署）            |
| `Z_ORVANTA_MAINT_READ`     | `operation-scoped` | 线上仍是无 `CAPABILITIES` 的版本；升级后应为 `self-described`     |
| `Z_ORVANTA_OPS_READ`       | `operation-scoped` | 同上                                                              |

- 能力直方图保持不变（`available 21` / `unsupported 1` / `unknown 32`），且 `safety.sapWritesInvoked=false`：新增的两个探询没有放大任何能力判定。
- 因此「五条自述」是**部署后**才可能出现的状态：DDIC 与 MAINT/OPS 需各自部署带 `CAPABILITIES` 的版本，而 `EXECUTE` 缺少 HELPER 行是它自身的既有行为。当前构建可验收的事实是「五条记录、报告不报错、不写 SAP」。

---

## 4. 服务侧设计

### 4.1 类型与探测

```ts
// src/backend.ts
export interface SapHelperCapabilities {
  helper: string
  minProtocol: string | null
  maxProtocol: string | null
  operations: Array<{ opcode: string; since: string; write: boolean }>
  scopes: Array<{ scope: string; enabled: boolean }>
  sourceHash: string | null
  packageName: string | null
  transport: string | null
  host: string | null
  observedAt: string
  attestation: "self-described" | "operation-scoped" | "absent"
}

export interface SapBackend {
  probeHelperCapabilities(connectionId: string, helper: string): Promise<SapHelperCapabilities>
}
```

- `adt-backend.ts`：按助手所属端点分发（`EXECUTE` / `DYNPRO` / `DDIC` / `SMARTFORM` 走 SOAP；`LOG` / `OPS` / `MAINT` / `SCI` 走各自现有通道）。
- 旧助手返回 `OPERATION_NOT_SUPPORTED` → 返回 `attestation: "operation-scoped"` 并保留现有单次操作协议结果，**不报错**。

### 4.2 能力判定

`src/capabilities.ts` 的 `capabilityWithHelper(id, helper, minimumVersion, toolNames)` 改为优先使用 `maxProtocol`：

| 情况                                 | availability                   | 报告文案要点                                                 |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------ |
| 助手调用失败/不存在                  | `unsupported` 或 `unavailable` | 明确「未部署或不可达」，附原始错误码                         |
| 可调用但无自述能力                   | `unknown`                      | 「已部署但无法自述版本；按操作码 1.2 判定，不足以证明 ≥1.3」 |
| 自述 `maxProtocol >= minimumVersion` | `available`                    | 附 `sourceHash`、`package`、`transport`                      |
| 自述 `maxProtocol < minimumVersion`  | `unsupported`                  | 「已部署版本 X.Y，低于所需 Z」                               |

`get_capability_report` 新增顶层字段：

```json
"helperAttestation": [
  { "helper": "Z_ORVANTA_MCP_DYNPRO_API", "maxProtocol": "2.6", "sourceHash": "…",
    "packageName": "ZABAP", "transport": "GR2K923472", "attestation": "self-described" }
]
```

---

## 5. 验收标准（部署后由人工执行）

| #    | 步骤                                    | 期望                                                                                         |
| ---- | --------------------------------------- | -------------------------------------------------------------------------------------------- |
| A4-1 | 在 `w200` 对每个助手调用 `CAPABILITIES` | `ev_status='S'`，`ev_version` 为该助手最高协议，载荷含 `PROTOCOL\|MAX` 与全部 `OPERATION` 行 |
| A4-2 | 对照打包清单校验 `SOURCE\|HASH`         | 与部署证据中的指纹一致                                                                       |
| A4-3 | 重新运行 `get_capability_report(w200)`  | 原 10 项 `repository-helper-*` unknown 归零；`helperAttestation` 出现全部已部署助手          |
| A4-4 | 在未升级的助手/端点调用 `CAPABILITIES`  | 返回 `OPERATION_NOT_SUPPORTED`，无副作用，报告标注 `operation-scoped`                        |
| A4-5 | 回归既有只读工具                        | `search_abap_objects`、`read_abap_table`、`read_background_job_log` 等仍返回原结果结构       |

**未完成上述验收前，不得在文档或能力报告中宣称「助手版本可自证」。**

---

## 6. 风险与缓解

| 风险                                    | 缓解                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 助手升级需要新的 Workbench 传输与激活   | 复用 0.43.4 确立的「显式请求号 + 写后回读」流程；升级前先跑 `CAPABILITIES` 记录旧版本            |
| 生成期哈希注入错误                      | 部署脚本在部署后立即调用 `CAPABILITIES` 并把返回的 `SOURCE\|HASH` 与本地计算值比对，不一致即失败 |
| 新旧助手混布                            | 判定表按「每个助手」独立报告，不做整体结论                                                       |
| `ev_version` 语义变更被误用到其它操作码 | 仅在 `CAPABILITIES` 分支使用新语义；在生成器中加注释与断言，其余分支保持原值                     |
