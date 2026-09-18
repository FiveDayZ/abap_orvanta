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

| 目标                                                                    | 位置                                                                                                                                | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`Z_ORVANTA_MCP_DDIC_API`~~ **已实现（未部署）**                       | `scripts/bootstrap-sap-helper.ps1` 的 `New-DdicFunctionSource`；提交 `d737997`                                                      | 19 个操作码；`since` 按 R4 取契约最低版本；占位符与仓库助手逐字节相同，复用既有哈希替换；另有 5 项漂移测试。部署需先删除再生成（`-ReplaceExisting`），用户 2026-09-17 决定暂不部署                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Z_ORVANTA_MCP_DYNPRO_API`（GUI/屏幕体）                                | 同上文件，非 DDIC 分支（`$repositoryFunctionSource` 之外的 GUI/屏幕体）                                                             | **经复核，原判断有误：不存在独立的 GUI/屏幕体会。** `bootstrap-sap-helper.ps1` 只创建三个函数模块（`New-InstallProgram` 的 `-FunctionName` 取值仅 `Z_ORVANTA_MCP_EXECUTE`（默认）、`Z_ORVANTA_MCP_DYNPRO_API`（行 9030）、`Z_ORVANTA_MCP_DDIC_API`（行 9036）），且 EXECUTE 与 DYNPRO_API 共用同一份 `$repositoryFunctionSource` 体（仅助手指纹行按 `$FunctionName` 插值）。因此该助手的 GUI/屏幕相关操作早已随共享体一起自述：2026-09-18 实测其 `self-described`、协议 1.1–2.6、36 个 `OPERATION` 行。`New-GuiApiInspectionProgram`／`New-GuiObjectInspectionProgram` 只由 `InspectGuiApis`／`InspectGuiObject` 模式调用，生成的是临时 SE80 式巡检程序，不是助手，不适用本协议 |
| ~~`Z_ORVANTA_MAINT_READ`~~ **已实现；含 `CAPABILITIES` 的版本未部署**   | `scripts/maintenance-diagnostic-source.mjs`；提交 `c988648`                                                                         | 3 个操作码；按 R3 走 JSON `payload`；按 R5 豁免 `CAPABILITIES` 的前置校验。助手**本身已部署**在 w200（FUGR/FF、函数组 `ZORVANTA_MAINT`、包 `ZABAP`、请求/任务 `GR2K923421`/`GR2K923422`，依据 `.doc/code-update-20260910-172621.md`，2026-09-18 以 `get_abap_object_info` 复核存在）。生成器原先发布空的 `SOURCE\|PACKAGE`/`SOURCE\|TRANSPORT` 行，已按该证据修正                                                                                                                                                                                                                                                                                                               |
| ~~`Z_ORVANTA_OPS_READ`~~ **已实现；含 `CAPABILITIES` 的版本未部署**     | `scripts/operational-log-source.mjs`；提交 `c988648`                                                                                | 6 个操作码（按生成特性门控）；同样适用 R3／R5。助手本身已部署（包 `ZABAP`、请求/任务 `GR2K923421`/`GR2K923422`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Z_ORVANTA_LOG_READ` / `Z_ORVANTA_SCI_API*` / `Z_ORVANTA_SMARTFORM_API` | `application-log-read-source.mjs`、`job-spool-source.mjs`、`sci-v2-source.mjs`、`sci-e2-source.mjs`、`report-parameters-source.mjs` | 这些生成器**当前没有 `CASE iv_operation` 分派**（`WHEN` 计数为 0），需先确认其操作码分派形态再决定是否适用本协议                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `scripts/deploy-*.mjs`                                                  | 各部署脚本                                                                                                                          | 部署前后各调用一次 `CAPABILITIES`，把 `SOURCE\|HASH` 写进部署证据文件（实现中）。**升级请求：复用 `GR2K923472`**（2026-09-18 用户决定；实测状态 `D`、任务 `GR2K923473` 可修改、含 `ZORVANTA_MCP_CORE`＋`ZCL_ORVANTA_MCP_CORE`）。`GR2K923421`/`GR2K923422` 实测已为 `R`（已释放），只能作为历史依据；`GR2K923472` **不得释放**                                                                                                                                                                                                                                                                                                                                                  |

**已部署版本核对（2026-09-18，只读）**：把 w200 上两个助手的当前源码取出，与生成器在 `c882b9f`（引入 `CAPABILITIES` 之前）的渲染结果逐行比对，两者**逐字一致**：

| 助手         | 部署总行数 | 构成                                                  | 比对结果           |
| ------------ | ---------- | ----------------------------------------------------- | ------------------ |
| `MAINT_READ` | 321        | 17 行接口 + 303 行 `maintenanceDiagnosticSource` 体   | 303/303 完全一致   |
| `OPS_READ`   | 1070       | 23 行接口 + 1047 行 `operationalLogReportSource` 变体 | 1047/1047 完全一致 |

结论：仓库生成器仍是这两个助手的唯一事实来源，没有手工漂移，因此本轮升级是**干净重生成**（MAINT 体 303 → 356 行，OPS report 变体 1047 → 1099 行），升级后 `SOURCE|HASH` 可直接作为部署证据使用。

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
