# SAP 助手能力自述协议（CAPABILITIES）

- 状态：**服务侧已实现并发布（0.46.0）；SAP 侧 8 个助手中 6 个已部署并自述，SCI V2／E2 的载体生成器已就绪但未部署**（Track A / WP-A4）
- 日期：2026-09-17 设计；2026-09-20 状态校准
- 涉及对象：`Z_ORVANTA_MCP_EXECUTE`、`Z_ORVANTA_MCP_DYNPRO_API`、`Z_ORVANTA_MCP_DDIC_API`、`Z_ORVANTA_MCP_QUERY_API`、`Z_ORVANTA_MCP_SCI_API`/`_V2`/`_E2`、`Z_ORVANTA_LOG_READ`、`Z_ORVANTA_OPS_READ`、`Z_ORVANTA_MAINT_READ`、`Z_ORVANTA_SMARTFORM_API`
- 涉及源码：`scripts/bootstrap-sap-helper.ps1`、`scripts/*-source.mjs`、`src/backend.ts`、`src/adt-backend.ts`、`src/capabilities.ts`

> **历史版本说明**：本文件 2026-09-17 初次成稿时标注为"设计稿，未实现、未部署"。该标注在 2026-09-18 起即已失真（服务侧与多个助手相继落地），2026-09-20 予以校准。下文 §1 记录的仍是**设计前的**问题与证据，保持不变以便追溯根因。

## 0. 当前实施状态（2026-09-18 真实只读能力报告实测，2026-09-20 校准）

证据文件：`.doc/helper-capabilities-evidence/capability-report-attestation-20260918T072557Z.json`（对 `w200` 的真实只读 `get_capability_report`，包版本 0.45.0）。该报告共 55 项能力：`available 22 / unsupported 2 / unknown 31`（设计前基线为 54 项、`13 / 1 / 40`）。

> 该证据文件的 `helperAttestation` 只有 **6 条**（当时只探询 6 个助手）。SCI V2／E2 的探询接线是随后加入的，因此下表中 SCI 两行**不是**该文件的实测值，而是由"载体未部署"这一事实推出的当前应有状态；待 SCI 载体部署后须以新的真实报告替换。

| 助手                                   | 自述状态             | 协议范围       | 操作码数 | `SOURCE\|HASH`（源指纹）                                           | 包 / 传输              |
| -------------------------------------- | -------------------- | -------------- | -------- | ------------------------------------------------------------------ | ---------------------- |
| `Z_ORVANTA_MCP_EXECUTE`（基础助手）    | `self-described`     | 1.1 – **2.7**  | 37       | `fbf26be00f96c60e0bdf583248e0a00ae02bbb6c0482ab09698c940dc00c0433` | `ZABAP` / `GR2K923472` |
| `Z_ORVANTA_MCP_DYNPRO_API`（仓库助手） | `self-described`     | 1.1 – 2.6      | 36       | `06812bcc8d3e7ccab9b51764b61a079f7c2d44e5132e27ec748ac3a00152e014` | `ZABAP` / `GR2K923472` |
| `Z_ORVANTA_MCP_DDIC_API`               | `self-described`     | 1.2 – **1.10** | **24**   | `780aa87df7c5da59ed42aca8325ad0d4592a5dbae39bca062bede39f12a67d91` | `ZABAP` / `GR2K923472` |
| `Z_ORVANTA_MAINT_READ`                 | `self-described`     | 1.0 – 1.0      | 3        | `69f20bb0907f0a508b14efc3609695d959d8c6c4f9f89026f22586733fc2a066` | `ZABAP` / `GR2K923472` |
| `Z_ORVANTA_OPS_READ`                   | `self-described`     | 1.0 – 1.0      | 6        | `0781c11ded0de139c633066b1e4774f15e9b782053162aad984b78f0b7877ce1` | `ZABAP` / `GR2K923472` |
| `Z_ORVANTA_LOG_READ`                   | `self-described`     | 1.0 – 1.0      | 5        | `07383ef8df98408752203244607bf2b30b225b0f3b506e958d93ae25cde573ab` | `ZABAP` / `GR2K923472` |
| `Z_ORVANTA_MCP_SCI_V2`                 | 未自述（载体未部署） | —              | —        | —                                                                  | —                      |
| `Z_ORVANTA_MCP_SCI_E2`                 | 未自述（载体未部署） | —              | —        | —                                                                  | —                      |

> **2026-09-21 更新**：`Z_ORVANTA_MCP_DDIC_API` 行改为当日只读 `get_capability_report(w200)` 的实测值（1.10 / 24 个操作码，`sourceHash` 未变）。该实测清单含 `READ_LOCK_OBJECT` 与 `RESUME_TRANSPARENT_TABLE_ACTIVATION`，**不含** `UPSERT_LOCK_OBJECT` 与 `DELETE_LOCK_OBJECT` —— 这正是 R-1 缺陷的证据：协议版本满足 1.9／1.10，但两个写操作码从未部署。其余行仍是 2026-09-18 证据文件的值。

**服务侧实现要点**（0.46.0）：

- 能力报告新增 `helperAttestation` 段，对 8 个助手**各自**探询 `CAPABILITIES`；助手的自述是**该助手自己的**判据，绝不跨助手投影（旧/新混部不会被合并成一个结论）。
- 自述的最高协议是**权威**：`src/capabilities.ts` 的 `helperCapability` 只要拿到 `self-described`，就按 `maxProtocol` 与最低协议比较，而不是按"恰好执行过的那个操作码"的 `ev_version`。
- **助手与最低协议不再在能力规格里手写**：它们由 `src/tool-registry.ts` 派生（`resolveHelperCapabilityRoute` / `helperCapabilityRoutes`），`npm run matrix:check` 会对全部 15 项助手能力做一致性校验。这条改动修掉了 `write_function_module_source` 被误判为 `unsupported` 的缺陷（该工具已路由到基础助手 2.7，能力规格却仍按仓库助手 2.6 判定）。
- 维护／运维／应用日志助手的自述仅作**记录**：它们的读工具受本地审批文件门控，能力报告不执行那次业务读取，因此其能力判定现状不变。
- SCI V2／E2 的载体（新增导出标量 `EV_RESULT`、类型 `STRINGVAL`、值为 R3 JSON 信封）生成器已实现（`scripts/sci-carrier-source.mjs`），**尚未部署**；部署后必须重钉 `src/sci-v2.ts` 的指纹。

**仍未完成**：SCI V2／E2 载体**体部**部署与指纹重钉（D2-3；接口前置条件已完成，见 §3.5）；DDIC 助手 `DTEL` 分支补 `DATATYPE`/`LENG`（D2-2，用于修掉无域数据元素的服务侧回退依赖）。R6 的四项未决问题已于 2026-09-20 全部结案，见 §3.5 后的处置表。

**2026-09-20 只读复测（D1 验收，服务 0.46.0 / 启动指纹 `12fa3435…`）**

证据：`.doc/orvanta-capability-report-d1-acceptance-2026-09-20T01-33-45.917Z.json`、`.doc/orvanta-interface-execution-support-d2-acceptance-2026-09-20T01-33-45.917Z.json`。全部为只读调用（`get_capability_report`、`read_function_module_interface`），未执行任何 SAP 写入。

- 报告共 55 项能力：`available 23 / unsupported 1 / unknown 31`（2026-09-18 为 `22 / 2 / 31`）。**唯一从 `unsupported` 变为 `available` 的是 `repository-helper-function-source-write`**，其 reason 已改为「The **Z_ORVANTA_MCP_EXECUTE** helper self-described protocol 2.7, which satisfies minimum 2.7.」——即 D1-1 的注册表派生判定在真实系统上生效，E-1 漂移已消除。`repository-helper-function-interface-patch` 同样改为按 `Z_ORVANTA_MCP_EXECUTE` 2.7 ≥ 2.0 判 `available`。
- 唯一仍 `unsupported` 的是 `adt-runtime-traces`（`abap-traces` 端点 HTTP 404，平台不暴露），与本次改动无关。
- `helperAttestation` 现为 **8 条**：6 个助手 `self-described`，SCI V2／E2 均为 `operation-scoped`（接口已含 `EV_RESULT`、体部未部署，正是预期状态）。
- **2026-09-20 D3 起将变为 56 项能力**：`adt-quality` 原将 `run_atc_analysis` 与 `run_unit_tests` 绑在同一 `unknown` 上，已拆出 `adt-abap-unit`（按本平台**已**广告 `/sap/bc/adt/abapunit/testruns`，定性 `unknown`）；`adt-quality` 保留原 ID 与 ATC 语义，改为 `platform_unsupported`，`adt-debugger` 亦然。新分布预期为 `available 23 / unsupported 1 / platform_unsupported 2 / unknown 30`。**本节上面的 55 项数字是拆分前那份实测报告的原始值，按不可回改的记录保留**；56 项须以重启后的新真实报告为准，届时替换本行。
- **`Z_ORVANTA_MCP_DYNPRO_API` 已在 SAP 侧升到协议 2.7**（2026-09-18 为 2.6），源指纹由 `06812bcc…` 变为 `f09e382b…`。上表该行是 09-18 的快照，此处为准。

**2026-09-22 D6-3 工作树增量（未发布、未升版本、助手未部署）**

- DDIC 助手能力表新增三个操作码：`READ_NUMBER_RANGE_OBJECT`(24) / `UPSERT_NUMBER_RANGE_OBJECT`(26) / `DELETE_NUMBER_RANGE_OBJECT`(26)，`sinceVersion` 均为 `1.11`，每行都有对应的 `CASE` 分支；`PROTOCOL|MAX` 由能力表**推导**为 `1.11`（不是手改的字面量），`PROTOCOL|MIN` 仍为 `1.2`。
- 服务侧新增 `read_number_range_object` / `upsert_number_range_object`，`delete_ddic_object` 的 `objectType` 增 `NROB`；能力组由 **18** 增至 **19**（新增 `ddic-helper-number-range-object`）。范围仅 `TNRO` + `TNROT`，**区间值 `NRIV` 不在范围内**。
- 并发令牌是 **40 字符 SHA-1 定义摘要**（覆盖规范 `TNRO` 行与**全部** `TNROT` 行，读路径与写路径算法同一处，因此与调用方登录语言无关），**不是** DDIC 时间戳：`TNRO` 既无 `AS4DATE` 也无 `AS4TIME`。工具 schema 把它声明为字符串并注明"定义摘要"。
- **操作码长度上限逐助手不同，且是硬约束**：`Z_ORVANTA_MCP_DDIC_API` 的 `IV_OPERATION` 是 `BAPIRET2-PARAMETER`（**CHAR 32**）；`Z_ORVANTA_MCP_EXECUTE` 与 `Z_ORVANTA_MCP_DYNPRO_API` 的 `IV_OPERATION` 是 `RS38L-NAME`（**CHAR 30**）。超过上限的名字在抵达 `CASE` 之前就被 RFC 截断，助手只会回 `OPERATION_NOT_ALLOWED`（这正是 R-20 的成因），因此 `src/helper-operation-limits.ts` 在发出任何 SAP 调用之前失败关闭，`test/helper-operation-limits.test.ts` 按每个助手**自己的**参数类型推导上限，不设全局常量。新增操作码必须同时满足三条：能力表有行、`CASE` 有 `WHEN`、长度不超该助手上限。
- **R-20c（同批）**：`repository-helper-enhancement-lifecycle` 组的仓库侧工具行补上 `requiredOperations`（`READ_ENHANCEMENT_IMPL` / `CREATE_HOOK_ENHANCEMENT` / `CREATE_BADI_ENHANCEMENT` / `UPDATE_HOOK_ENHANCEMENT` / `UPDATE_BADI_ENHANCEMENT` / `MANAGE_ENHANCEMENT_STATE` / `DELETE_ENHANCEMENT_IMPL` / `MANAGE_CLASSIC_BADI_IMPL`，逐个按助手能力表核对而非按工具名推断），使该组能力判定不再"仅凭协议版本"。

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

#### 3.2.1 载荷分组与"非活动版本描述"的含义（2026-09-21 17:10 事件后明确）

分组字母决定载荷落到响应的哪个袋子：`M`→`metadata`（读操作自身的元信息）、`H`→`header`（对象属性）、`V`→固定值、`F`→字段、`S1/S2/S3`→搜索帮助三段、`L1/L2`→锁对象两段。

活动路径把对象属性发在 `H`；**非活动版本描述路径（`INACTIVE_VERSION_DESCRIBED`，协议 1.10）把同一批属性发在 `M`**——在该路径下它们描述的是被读取的那个版本，而不是活动版本。服务侧因此把 `M` 作为 `H` 的回退来源（两处都有同名键时以 `H` 为准）。缺失这条回退时，非活动读取会返回空 `description`/`tableClass` 等，而 SAP 自己的 `DD02L` 行其实带着 `TRANSP`：这是**客户端丢行**，不是对象为空。非活动回执同时给出 `inactiveVersionAttributes`（助手原样上报的属性，去掉 `INACTIVE`/`GOTSTATE`），便于区分" SAP 没给"与"客户端没映射"。

**技术设置（DD09V）在 1.10 及更早只在活动路径上报**：`TABKAT`/`TABART`/`BUFALLOW`/`PUFFERUNG` 由活动分支的 `H` 行发出（取自 `ls_dd09v`），非活动分支一条都不发。因此非活动回执里的 `dataClass`/`sizeCategory` 是**客户端默认值**，不是 SAP 存储值——2026-09-21 17:37 事件正是把它当成事实（`dataClass=""`、`sizeCategory=0`），而批准定义要求 `APPL1/1`。服务侧据此：非活动回执给出 `technicalSettingsReported`（**按载荷里是否出现这些键判定**，故助手升级后自动变为 `true`，不需要版本开关）与 `warnings`；`resume_ddic_table_activation` 在无法确认可用设置时拒绝激活（`INACTIVE_TECHNICAL_SETTINGS_NOT_REPORTED`／`INACTIVE_TECHNICAL_SETTINGS_INCOMPLETE`），并提供指纹保护的 `settingsRepair` 先写 DD09L 再激活、最后按活动读取逐项验证。

**规范正文（下一次载体起）在非活动分支补报这四项**，与表头同出自那次 `DDIF_TABL_GET state = 'M'`（`dd09l_wa = ls_current_dd09v`）。这是**加法变更**：1.10 助手不含这些行，服务侧按"未上报"处理，因此不需要协议版本升级即可安全共存。

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

| R6 | **SCI 助手（`Z_ORVANTA_MCP_SCI_V2`／`_E2`）的能力回复载体＝新增一个导出标量 `EV_RESULT`（类型 `STRINGVAL`），其值为 R3 JSON 信封**：行放进同一信封的 `payload` 数组，**不新增导出表**。`since` 取信封自身的修订号（`"version":"1"` → `1.0`），**不得**取助手的 `ev_version`（2.0／3.0 是 SCI 规则档案版本，与协议版本无关）。`CAPABILITIES` 分支插在体的**第一条可执行语句之前**（业务 `CLEAR:` 预置块之前），因此不需要 R5 式豁免。未知动作的降级扩展见 §4.1：SCI 老体在任何业务校验之前就返回 `INVALID_ACTION`（不是 `OPERATION_NOT_SUPPORTED`），服务侧必须同等降级为 `operation-scoped`。 | 依据（2026-09-18，只读）：两个助手的接口都没有 `EV_RESULT`——导出 12／13 个 `EV_*` 标量＋`ET_RESULTS` 表，既无 `it_source` 也无 `EV_RESULT`，故 R3 的「行放 `payload`」是唯一可复用且不新增表的载体；两体与 `scripts/sci-v2-source.mjs`／`scripts/sci-e2-source.mjs` **逐字节一致**（234／284 行，体哈希 `dbf10817…`／`2f2b1380…`），且都不含 `CAPABILITIES` ⇒ 本次是干净新增，不是合并未知改动。`EV_RESULT` 属**接口变更**（新增一个 `EXPORTING` 标量），会使 `src/sci-v2.ts` 钉住的 `SCI_V2_FINGERPRINT`／`SCI_E2_FINGERPRINT` 失效（该常量保存的是整体 `fingerprint`，比较见 `src/tools.ts:1720`），**部署后必须重钉**；`src/sci.ts` 的 E1 助手 `Z_ORVANTA_MCP_SCI_API` 不受影响。用户 2026-09-18 选定「单个导出标量 `EV_RESULT`（`STRINGVAL`）＋ JSON 信封」，备选「新增导出表」未采用；载体生成器 `scripts/sci-carrier-source.mjs` 已按此实现（分支 23 行、体 257／307 行、全部行 ≤71 字符），**尚未部署** |

### 3.5 后续补齐清单（同一协议，逐文件落地）

| 目标                                                                  | 位置                                                                                                                               | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`Z_ORVANTA_MCP_DDIC_API`~~ **已实现、已部署并自述（1.2–1.7）**      | `scripts/bootstrap-sap-helper.ps1` 的 `New-DdicFunctionSource`；提交 `d737997`                                                     | 19 个操作码；`since` 按 R4 取契约最低版本；占位符与仓库助手逐字节相同，复用既有哈希替换；另有 5 项漂移测试。2026-09-18 实测已 `self-described`、协议 1.2–1.7、19 个 `OPERATION` 行、源指纹 `780aa87d…`（见 §0）。**注意**：其 `DTEL` 分支仍不返回 `DATATYPE`/`LENG`，无域数据元素（如 `STRINGVAL`）因此解析失败——服务侧已用读 `DD04L` 回退兜住，见 D2-2                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
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

- 这些助手的自描述**是否参与能力判定，取决于该助手是否有"按协议版本判定"的能力规格**（2026-09-20 校准；原表述"当前不改变任何能力判定"已过期）：
  - **参与判定**：基础助手 `Z_ORVANTA_MCP_EXECUTE`、仓库助手 `Z_ORVANTA_MCP_DYNPRO_API`、DDIC 助手 `Z_ORVANTA_MCP_DDIC_API`。`src/tool-registry.ts` 为它们的工具给出了 `sapHelper` + `minHelperProtocol`，能力报告按自述的最高协议给出 `available` / `unsupported`。基础助手的自述尤其关键：它承载 `write_function_module_source`（2.7）与 `patch_function_module_interface`（2.0）。
  - **仅作记录**：MAINT／OPS／应用日志助手——其读工具受本地审批文件门控，能力报告不执行那次业务读取；SCI 助手——其 `run_sci_analysis` 目前只钉 `Z_ORVANTA_MCP_SCI_API`（1.0），V2／E2 无自述载体。对这些助手，自述只增加溯源信息（包、请求、源哈希），不改变可用性判定。
  - 因此"要让某个助手的自述产生判定价值"，需要它在注册表里有带 `minHelperProtocol` 的工具，并在 `src/capabilities.ts` 里有对应的助手能力规格（现在由 `HELPER_CAPABILITY_TOOLS` 声明、由注册表派生路由）。
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
- 只读诊断尝试：`search_sap_locks`（用户 `WYS`）返回 `status=unavailable, code=HELPER_NOT_APPROVED`——当时记为"需要另行部署并通过指纹批准的锁助手，当前 w200 不具备"。**2026-09-21 复核更正**：该回执由**服务侧本地批准门禁**在访问 SAP **之前**产生（状态目录下无 `maintenance-diagnostic-approvals.json`），**不能**据此推断助手未部署——`Z_ORVANTA_MAINT_READ` 当时已部署在 `w200`（函数组 `ZORVANTA_MAINT`、包 `ZABAP`），缺的是含 `CAPABILITIES` 的版本，故其能力为 `operation-scoped`；正确结论是**SAP 侧锁状态未被观测**（`readOnly` 门禁拦下），而不是"助手不存在"。携带 R-17 的版本起，该回执附带 `reason` 与 `expectedApprovalFile` 以区分两类缺口（见 `docs/maintenance-diagnostics.md` §启用门禁）。
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
- 分配补齐后复测（用户执行 SE01/SE09 指派，`GR2K923472` 现含 4 个对象，两助手读回 `requestNumber=GR2K923472`）：前置守卫通过，SAP 仍以**新句柄**返回同一 423。随后用"只加锁不保存"探针（`oldString` 保证不存在）验证**加锁/读取/解锁成功**且未保存源码 ⇒ 失败点在 **PUT**。对照 `ZORVANTA_MCP_CORE`／`ZCL_ORVANTA_MCP_CORE`／`Z_ORVANTA_MCP_EXECUTE`／`Z_ORVANTA_MCP_DYNPRO_API` 的分配回读（同为 `request=GR2K923472`、`task=""`）可知"任务号为空"是正常形态 ⇒ **"缺分配导致 423"被推翻**。
- 服务端代码事实（只读）：`replaceSourceWithClient`（L3569 起）用同一个 client 完成 `lock`(L3594)→读取(L3603)→`selectTransport`(L3629)→`setObjectSource`(L3630)→`unLock`(L3641)；`withStatefulClient`(L1602-1635) 每次新建 `ADTClient`、先无状态 `login()` 再置 `stateful`(L1627)；`preserveCookieSessionWithoutCsrf`(L1667-1675) 因"ECC 7.31 可能只给 cookie 不给 CSRF 令牌"改写 `loggedin`；写入 client 的 `debugCallback` 只上报失败响应（423 诊断行来自此）。SAP 的 423 **回显了它收到的句柄**，且库须解析出非空 `LOCK_HANDLE` 才会放入请求 ⇒ 发出的句柄即加锁返回的句柄，而 SAP 仍判"未加锁" ⇒ 剩余嫌疑集中在**写入步骤的会话/令牌绑定**。

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

**R6 状态补充（2026-09-18：只读核对＋生成器落地；未部署、未运行测试）**

上表 `sci-v2-source.mjs`／`sci-e2-source.mjs` 一行的结论（「R3 载体不存在，需先定义载体，属接口变更」）已由 R6 处置：载体＝**单个导出标量 `EV_RESULT`（`STRINGVAL`）＋ R3 JSON 信封**，生成器 `scripts/sci-carrier-source.mjs` 冻结两个基线（哈希同时钉在文件注释与 `test/sci-carrier-source.test.ts`）并各自注入 23 行 `CAPABILITIES` 分支（`_V2` 体 257 行／摘要 `fa352053…`，`_E2` 体 307 行／摘要 `fc7c6418…`，均为占位符仍在时的 `SOURCE|HASH` 值）。`_E2` 仍由 `_V2` 文本替换派生，但两个基线各自冻结并各自注入分支（HELPER 标识行必须写各自的函数名），派生关系改由测试重新断言。

部署前置条件（2026-09-20 只读复核后的真实状态）：

1. ~~在两个助手的 `EXPORTING` 中新增 `EV_RESULT TYPE STRINGVAL`~~ **已完成（w200 实测，非本轮所为）**。2026-09-20 只读 `read_function_module_interface` 实测：`Z_ORVANTA_MCP_SCI_V2` 与 `Z_ORVANTA_MCP_SCI_E2` 的 `EXPORTING` **都已含 `EV_RESULT`，类型 `STRINGVAL`，`valueContract.dataType = STRG`**，两助手均 `remoteEnabled=true`、`executionSupport.supported=true`（`reasons` 为空）。此前本文件记的"须人工完成"已不再成立。旁证：两助手的 CAPABILITIES 探询（JSON 信封通道）能正常返回空 `EV_RESULT`，报告因此稳定显示 `operation-scoped` 而不是 `absent`。
2. **部署后重钉** `src/sci-v2.ts` 的 `SCI_V2_FINGERPRINT`／`SCI_E2_FINGERPRINT`——**未完成，且已构成现行缺陷**，见下。

**现行缺陷：SCI V2／E2 的接口指纹钉已失效（2026-09-20 只读实测确认）**

`src/tools.ts:6213-6217` 把 `SCI_V2_FINGERPRINT`／`SCI_E2_FINGERPRINT` 作为 `expectedInterfaceFingerprint` 传给 `testRemoteFunctionModule`，后者在**任何 SAP 调用之前**（`src/tools.ts:1719-1727`）比对接口身份，不一致即抛错。**0.47.29 起该闸门接受 `read_function_module_interface` 三个指纹中的任意一个**（`fingerprint` 整个定义 / `interfaceFingerprint` 仅接口 / `sourceFingerprint` 仅正文），0.47.29 之前只接受 `fingerprint`。下表"失效"结论按当时的单值判据成立，**按三值判据需重新核实**：钉住的值若等于该助手的 `interfaceFingerprint` 或 `sourceFingerprint`，现在会通过。实测值（0.47.29 之前读取的 `fingerprint`）：

| 助手                          | 钉住的值        | w200 线上 `fingerprint` | 结论             |
| ----------------------------- | --------------- | ----------------------- | ---------------- |
| `Z_ORVANTA_MCP_SCI_API`（E1） | `83f8f0a6a588…` | `83f8f0a6a588…`         | 一致，旧路线正常 |
| `Z_ORVANTA_MCP_SCI_V2`        | `4d38c0988ac0…` | `0f534e3fcca3…`         | **失效**         |
| `Z_ORVANTA_MCP_SCI_E2`        | `9f0c1e64d4fb…` | `48bf0016d50e…`         | **失效**         |

因此**带显式目标（V2）或 `syntax_critical_sql` profile（E2）的 `run_sci_analysis` 目前会在本地被守卫拦下**（`Function interface fingerprint changed`），E1 路线不受影响。证据链：`read_function_module_interface` 返回体即 `functionModuleResult(...)` 的展开（`src/tools.ts:1626-1640`），与守卫比较的 `definition.fingerprint` 是同一函数产物，故上表的线上值就是守卫实际比较的值。属**代码路径级证明**；未端到端调用 `run_sci_analysis`，因为需要 `acknowledgePotentialSideEffects: true`，本轮未获该授权。

处置：**已于 2026-09-20 按用户裁定执行方案②**——两个常量先重钉到当前线上值，立即恢复 V2／E2 可用；载体**体部**部署后必须再重钉一次（届时指纹随体部变化），该要求已写入 `src/sci-v2.ts` 的注释。重钉后三个钉（含 E1）与线上值全部一致。**注意：运行中的服务需重启才会载入新钉**，否则守卫仍用旧值。

**R6 未决问题的处置（2026-09-20 收口）**

原四项"未决"中有两项其实**已由生成器实现并写明理由**，只是本文件未同步；另两项按工程判断结案。逐项结论如下（部署前用户仍可否决，部署后即为对外契约）：

| #   | 原问题                                                             | 结论                                | 依据                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `since` 取 `1.0` 还是对齐 SCI 规则档案版本（`_V2` 2.0／`_E2` 3.0） | **已定：取 `1.0`**                  | `scripts/sci-carrier-source.mjs:105-111` 已写明：`ev_version` 是该助手的 SCI **规则档案**版本，取它正是本协议要消除的"助手版本 ≠ 协议版本"混淆；两个操作码都从引入本载体的修订 `1.0` 起算。已由 `test/sci-carrier-source.test.ts` 冻结                                       |
| 2   | SCI `RUN` 按只读发布是否正确，是否需加 `SCOPE\|SCI_RUN`            | **已定：按只读发布，不加 SCOPE 行** | `scripts/sci-carrier-source.mjs:113-115` 已写明：`PRECHECK` 在规则适用性判定后即停止；`RUN` 执行的是匿名 SCI 检查，**不保存变体、对象集或结果**。信封内的 `readOnly:true` 描述的是 CAPABILITIES 应答本身（无副作用的自述），业务操作的读写语义由 `OPERATION\|…\|R\|W` 行表达 |
| 3   | 是否补齐 `RUNTIME\|TIME` 行                                        | **已定：不补齐**                    | 该行不影响解析（`parseHelperCapabilitiesPayload` 对未知行前向兼容）；批准清单只要求 `RUNTIME\|HOST`；补齐会使两个已冻结的载体摘要失效，收益仅为时间戳可追溯性，不值得在部署前重置基线                                                                                        |
| 4   | 只部署 `_V2` 时 `_E2` 停在 `operation-scoped` 怎么办               | **已定：两者一并部署**              | 报告对**每个助手独立**判定（§6「新旧助手混布」缓解措施），部分部署不会产生错误结论，只会让 `_E2` 停在 `operation-scoped`。D2-3 按两者一并部署执行；若因故只部署一个，报告中 `_E2` 显示 `operation-scoped` 即为正确、非缺陷，禁止据此改判定逻辑                               |

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
- **R6 扩展（2026-09-18）**：并非所有老助手都用 `OPERATION_NOT_SUPPORTED` 拒绝未知操作码。`Z_ORVANTA_MCP_SCI_V2`／`_E2` 在任何业务校验之前就设置 `ev_code = 'INVALID_ACTION'` 并 `RETURN`，`Z_ORVANTA_LOG_READ` 的老版本同理返回 `READ_ONLY_UNSUPPORTED`。因此「老助手拒绝未知操作码」的降级规则必须覆盖 `OPERATION_NOT_SUPPORTED`、`INVALID_ACTION`、`READ_ONLY_UNSUPPORTED` 三类码：
  - JSON 信封路径已自然覆盖——老助手不写 `EV_RESULT`，空值即 `operation-scoped`；
  - XML／`EV_*` 路径与 `src/sci-v2.ts` 的 `formatScopedSciResult` 必须把 `INVALID_ACTION` 归入「未实现该操作码」，而不是当作执行失败抛出；
  - `src/adt-backend.ts` 的 `decodeJsonHelperCapabilitiesReply` 与 JSON 助手的 SOAP 故障分支**已接线**（2026-09-20）：两者共用 `UNIMPLEMENTED_OPCODE_CODE`，同时识别 `OPERATION_NOT_SUPPORTED`／`NOT_SUPPORTED`／`UNSUPPORTED`／`UNKNOWN_OPERATION`／`INVALID_ACTION`，统一降级为 `operation-scoped`。此前 `INVALID_ACTION` 在故障分支会被判成 `absent`（把"已部署但未实现该操作码"误报为"未部署"）；
  - **仍未接线**：`src/sci-v2.ts` 的 `formatScopedSciResult` 目前对 `EV_STATUS === 'E'` 一律 `throw`（`SCI V2 helper failed: <code>`）。这是 `run_sci_analysis` 的**业务执行**路径而非能力探询路径，回执文案尚不能区分"操作码未实现"与"执行失败"，属已知待办（不阻塞 D1）。

### 4.2 能力判定

`src/capabilities.ts` 的 `helperCapability(route, helper)` 优先使用 `maxProtocol`；当助手**同时**自述了操作码清单时，还要用清单核对工具真正会派发的操作码：

| 情况                                                        | availability                   | 报告文案要点                                                                              |
| ----------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------- |
| 助手调用失败/不存在                                         | `unsupported` 或 `unavailable` | 明确「未部署或不可达」，附原始错误码                                                      |
| 可调用但无自述能力                                          | `unknown`                      | 「已部署但无法自述版本；按操作码 1.2 判定，不足以证明 ≥1.3」                              |
| 自述 `maxProtocol >= minimumVersion` 且清单含全部所需操作码 | `available`                    | `evidence.source = version-and-operation-check`，附 `sourceHash`、清单条数                |
| 自述 `maxProtocol >= minimumVersion`，清单缺部分所需操作码  | `partial`                      | 逐工具给出 `toolObservations`，指明缺哪几个操作码、受影响工具会 `OPERATION_NOT_SUPPORTED` |
| 自述 `maxProtocol >= minimumVersion`，清单缺全部所需操作码  | `unsupported`                  | 「自述版本满足，但清单不含该能力所需的任何操作码」                                        |
| 自述 `maxProtocol < minimumVersion`                         | `unsupported`                  | 「已部署版本 X.Y，低于所需 Z」（`evidence.source = version-check`）                       |

- 需要核对的操作码来自工具注册表：`src/tool-registry.ts` 的每行第 8 个元素（如 `read_lock_object` → `READ_LOCK_OBJECT`、`delete_ddic_object` → 7 个 `DELETE_*`）。协议版本只声明"实现了哪个版本"，不声明"实现过哪些操作码"，因此**仅比版本会把只可能失败的工具报成 available**（0.46.6 实测：助手自述 1.10 却无 `UPSERT_LOCK_OBJECT`）。
- 两条**保持仅按版本判定**的路径，且都会在 `evidence.detail` 里如实说明，不假装做过核对：助手未发布操作码清单（空清单/老接口）；注册表尚未登记所需操作码（此时 `detail` 写明 verdict 仅基于协议版本）。
- `npm run matrix:check` 强制 `Z_ORVANTA_MCP_DDIC_API` 的每个工具都登记所需操作码（`helperOperationRequirementGaps`），新增工具不能悄悄跳过核对。

`get_capability_report` 新增/扩展的顶层字段：

```json
"helperAttestation": [
  { "helper": "Z_ORVANTA_MCP_DYNPRO_API", "maxProtocol": "2.6", "sourceHash": "…",
    "packageName": "ZABAP", "transport": "GR2K923472", "attestation": "self-described" }
],
"summary": { "available": 24, "partial": 2, "unsupported": 1, "platform_unsupported": 3, "unknown": 30 },
"capabilities": [
  { "id": "ddic-helper-lock-object",
    "observation": {
      "availability": "partial",
      "evidence": { "source": "version-and-operation-check", "detail": "…; missing: upsert_lock_object needs UPSERT_LOCK_OBJECT" },
      "toolObservations": {
        "read_lock_object": { "availability": "available", "requiredOperations": ["READ_LOCK_OBJECT"], "missingOperations": [] },
        "upsert_lock_object": { "availability": "unsupported", "requiredOperations": ["UPSERT_LOCK_OBJECT"], "missingOperations": ["UPSERT_LOCK_OBJECT"] }
      }
    } }
],
"verification": {
  "registryLoaded": true, "registryPath": "contracts/verification-registry.json", "updatedAt": "2026-09-25",
  "totals": { "verified": 21, "unverified": 115, "failed": 5, "blocked": 0, "platformUnsupported": 2, "total": 143 },
  "availabilityWithoutEvidence": "<按本次报告实时统计，随连接与 profile 变化>",
  "protocolOnlyToolCount": 44, "protocolOnlyTools": ["…"],
  "note": "…; verification never changes an availability verdict."
},
"opsCapability": {
  "vocabulary": { "toolRole": "read-only | action | platform-blocked", "familyState": "absent | blocked | partial | read-only | read-and-act", "endToEndRule": "…", "exemptionRule": "…" },
  "families": [
    { "id": "transport", "state": "partial", "actionRequired": true, "exempt": false, "exemptReason": "",
      "toolNames": ["…"], "missingToolNames": ["…"], "readTools": ["…"], "actionTools": ["…"], "platformBlockedTools": [],
      "verification": { "verified": ["…"], "unverified": ["…"], "failing": ["…"],
                        "closed": true, "blockingTools": [] },
      "gap": "Release and import are absent: …" }
  ],
  "summary": { "familyCount": 15, "stateCounts": { "absent": 5, "blocked": 1, "partial": 7, "read-only": 2, "read-and-act": 0 },
               "endToEndFamilyCount": 2, "endToEndPercent": 13, "endToEndFamilies": ["logs", "dumps"],
               "requiredEndToEndFamilyCount": 14, "requiredEndToEndPercent": 95, "endToEndPercentOfRequired": 14,
               "remainingRequiredFamilyCount": 12, "outstandingRequiredFamilies": ["…"], "exemptFamilies": ["traces"],
               "registryLoaded": true, "criterionBasis": "gap empty + every tool verified (verification registry loaded)",
               "evidenceClosedFamilyCount": 2, "evidenceClosedFamilies": ["logs", "dumps"],
               "stateClosedRequiredFamilyCount": 2, "closedRequiredFamilyCount": 2,
               "evidenceUnregisteredFamilies": [],
               "stateCriterionMet": false, "criterionMet": false,
               "actionToolCount": 3, "platformBlockedToolCount": 1, "classifiedToolCount": 20,
               "missingPlannedToolCount": 23, "missingPlannedTools": ["…"] },
  "note": "…; it never changes an availability or verification verdict."
}
```

（`totals` 与 `protocolOnlyToolCount` 是 `contracts/verification-registry.json` 的当前实测值（2026-09-25：`verified 21 / unverified 115 / failed 5 / platformUnsupported 2 / total 143`，其中 21 条 verified 与 2 条 platform-unsupported 均逐条指向 `.doc` 记录，见 §4A）；`availabilityWithoutEvidence` 由本次报告交叉统计得出，不是常量。`opsCapability` 的数例为 0.50.11 的实测值，随工具面变化，不是常量；证据维度的升级不改变任何族状态，它只改变各族 `verification` 名单。）

### 4A-0. 上面 `verification.totals` 的来源：OP0-2 证据补登（2026-09-25，0.50.11）

`verified` 从 9 条升到 21 条、`platformUnsupported` 从 1 条升到 2 条，全部是**本工作区早已存在、但从未登记进验收表的真实调用记录**，不是新探针：

| 证据来源（`.doc`）                        | 版本 / 日期          | 登记的工具                                                                                                               |
| ----------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `log-joint-acceptance-20260908-121025.md` | 0.36.12 / 2026-09-08 | `search_application_logs`、`search_background_jobs`                                                                      |
| `code-update-20260908-163230.md`          | 0.36.15 / 2026-09-08 | `discover_application_logs`、`read_application_log`、`read_background_job_log`、`read_system_logs`、`correlate_sap_logs` |
| `code-update-20260908-091820.md`          | 0.36.8 / 2026-09-08  | `diagnose_sap_failure`                                                                                                   |
| `code-update-20260909-084306.md`          | 0.36.17 / 2026-09-09 | `get_sap_system_info`                                                                                                    |
| `code-update-20260827-173838.md`          | 0.3.x / 2026-08-27   | `analyze_abap_traces`（→ `platform-unsupported`）                                                                        |
| `code-update-20260924-125930.md`          | 0.47.6 / 2026-09-24  | `search_sap_locks`                                                                                                       |
| `code-update-20260924-165500.md`          | 0.47.12 / 2026-09-24 | `manage_transport_requests`                                                                                              |
| `code-update-20260925-142324.md`          | 0.50.4 / 2026-09-25  | `analyze_abap_dumps`                                                                                                     |

两条必须分清的事实：①这些是**历史运行**（最早 2026-08-27、最新 2026-09-25），每条登记都写明它是在哪个版本上观察到的，**不代表当前构建已被重新探测**；②**计划不是证据**——`code-update-20260911-140842.md`、`code-update-20260910-173827.md`、`code-update-20260911-110723.md` 里写的是实施与人工验收步骤，且各自明说本轮未发起 SAP 调用，所以 `read_background_job_details`、`read_background_job_spool`、`search_failed_updates`、`read_failed_update` 仍然保持 `unverified`（`evidence` 与 `lastAttemptAt` 均为 `null`，不编造尝试时间）。

**运维证据维度的当前standing（20 个 ops 工具）**：`verified 14` / `platform-unsupported 1`（`analyze_abap_traces`，入口不可用，对应族豁免）/ `failed 1`（`cleanup_transport_entries`）/ `unverified 4`（上表列出的四个）。机器可读的按族名单来自报告的 `opsCapability.families[].verification`；此处的 4 个未登记项就是 OP0-2 剩余工作，每一项需要的输入类型写在 `docs/ops-coverage.md` §7。

一个值得保留的教训：`manage_transport_requests` 的历史记录里，2026-09-24 上午的 D9 验收曾观察到 `get_user_transports` 对 `WYS` 返回 **0 条**，而同一份记录里 `GR2K923488` 刚从 `E070` 读回 `AS4USER=WYS`——**空清单当时真的是假阴性**，随后由 CTS 表后备修掉。登记这条证据时如果把"有记录"直接写成 `verified` 而不写这段历史，读者就会以为"0 条"从来不是问题；因此该条 `notes` 保留了整个前因后果，并附上 500 行读取上限的告诫。

### 4A. 证据维度（`verification`）与可用性维度正交

0.47.1 起，能力报告在 `capabilities[]`、`helpers[]` 与顶层各带一个 `verification` 汇总，数据源是 `contracts/verification-registry.json`（S4/R-8 设计）。三个层次的分工必须分清：

| 字段                                       | 回答的问题                           | 数据来源                                  |
| ------------------------------------------ | ------------------------------------ | ----------------------------------------- |
| `observation.availability`                 | 在当前连接上**能不能调用**           | 助手协议版本 + 操作码清单 + ADT discovery |
| `verification.status`                      | 这个工具**被真实调用过吗、结果如何** | 验收登记表的人工/SAP 证据记录             |
| `verification.availabilityWithoutEvidence` | 有多少工具"可用但从未被验证过"       | 两者的交叉统计                            |

三条不变量：

1. **验收状态永不反向影响可用性判定**：`available + unverified` 是正常状态，不是缺陷，也不得被改写为 `unsupported`。反之亦然——把某个工具标成 `verified` 不会让它在未部署助手的系统上变得可用。
2. **读不到登记表时一律降级为 `unverified`**（`registryLoaded: false` + `reason`），而不是沿用上一次结果或声称已验证。健康度指标永远偏保守。
3. **`verification.status` 取最差项**（`failed` > `platform-unsupported` > `blocked` > `unverified` > `verified`），并把每个工具的逐项状态放在 `tools` 里，避免用"平均分"掩盖单个失败。

`protocolOnlyToolCount`/`protocolOnlyTools` 暴露的是 R-20c 的残余面：这些工具的判定**仅凭协议版本**、没有操作码清单可核对，属于已知的弱证据，必须能一眼数出来，而不是藏在汇总里。

### 4B. 运维覆盖维度（`opsCapability`）：工具清单不是覆盖结论

0.50.7 起，能力报告顶层新增 `opsCapability`，把运维（`ops`）面按**场景族**表述，而不是按工具条数表述。单一事实源是 `src/ops-coverage.ts`；报告里的族状态由工具登记表加"声明缺口"**推导**，不手写，因此数字只在工具面真的变化时才动。

- 工具角色（`read-only` / `action` / `platform-blocked`）与 `src/tool-registry.ts` 的注解互相校验：角色与注解矛盾、`ops` 组工具未分档、工具未归入任何族，都会让 `opsClassificationProblems()` 非空，而 `opsCapabilityBlock()` 拒绝在这种状态下发布报告——一个悄悄漏掉工具或族的块比没有块更糟，因为它看起来像个答案。
- 族状态（`absent` / `blocked` / `partial` / `read-only` / `read-and-act`）由"是否存在工具、是否全被平台挡住、声明的缺口是否为空"推导。**只有缺口为空的族才算端到端**；"读得到"永不顶替"处置得了"——作业族不会因为能读作业明细与 Spool 就变成 `read-and-act`，它停在 `partial` 并写明缺的是作业控制。
- `blocked` 与"尚未实现"是两句话：前者是平台（本版本不提供该端点）挡住，后者是没做。
- **完成判据在块里，不在散文里**：`requiredEndToEndFamilyCount` 只排除「全部工具都被平台挡住**且**带有书面豁免理由」的族，`criterionMet` = **同时满足两点**的必需族 ≥ `ceil(必需族 × 0.95)`（**向上取整**，向下取整会允许"仍有必需族未闭合"时宣称达标）。两点是：① 该族声明的缺口为空（结构上闭合）；② 该族**每个**工具在验收登记表里都是 `verified`。只满足 ① 不算——"工具存在"是关于计划的话，不是关于系统的话。`outstandingRequiredFamilies` 就是判据仍在等的工单清单；`closedRequiredFamilyCount` 是判据的分子，`stateClosedRequiredFamilyCount` 是只按 ① 算的弱读数，两者之差就是 `evidenceUnregisteredFamilies`（缺口已空、但工具还没被证明跑过）。豁免只对 `blocked` 族成立，守卫拒绝给未建或未完成的族开豁免——否则把族声明成豁免就能自己调低目标。
- **读不到登记表时判据不给通过**：`registryLoaded: false`（打包产物不含 `contracts/`）时分子为 0、`criterionBasis` 明说"只按缺口算、无族可被认证"，而不是退回只按 ① 的宽松读数。`criterionMet` 这一处刻意**不**沿用其它 `verification` 字段"降级为 unverified 但仍照常判定"的体例，因为判据是一句"这件事完成了"的断言——证据读不到时它只能说"不能认证"。
- 该块与 `verification` 一样，**永不改变可用性判定**；族的逐工具证据状态来自验收登记表的交叉统计。运维面的判定规则、授权模型与完成判据见 `docs/ops-coverage.md`。

  0.50.13 实测：15 个场景族（= 评估矩阵的 14 族 + 平台挡住的运行追踪族，后者即那份书面豁免），结构上 2 族端到端（`logs`、`dumps`，占全部 13%），且**这 2 族的全部工具都有登记证据**，故判据分子同为 2（占**必需 14 族** 14%）、`evidenceUnregisteredFamilies: []`；`partial` 7、`absent` 5、`blocked` 1，`criterionMet: false`，`remainingRequiredFamilyCount: 12`，还有 23 个计划内工具未建（0.50.7 首版为 25：`read_patch_level` 与 `read_client_settings` 已从计划中撤下——这两项的数据要么已由 `get_sap_system_info` 报告，要么其语义被项目刻意不换算，见 `docs/system-info.md`）。

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
