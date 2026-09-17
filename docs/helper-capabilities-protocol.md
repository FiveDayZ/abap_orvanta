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

| 文件                                                          | 改动                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| `scripts/bootstrap-sap-helper.ps1`                            | 在每个助手的 `CASE iv_operation.` 顶部增加 `WHEN 'CAPABILITIES'.` 分支，输出上述载荷；`SOURCE | HASH` 由脚本在生成时替换占位符 |
| `scripts/*-source.mjs`（log / ops / maint / sci / smartform） | 同上，各自补 `CAPABILITIES` 分支                                                              |
| `scripts/deploy-*.mjs`                                        | 部署前后各调用一次 `CAPABILITIES`，把 `SOURCE                                                 | HASH` 写进部署证据文件         |

### 3.4 设计修订（2026-09-17 实施期确定）

| #   | 修订                                                                                                                                       | 依据与影响                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **取消 `iv_expected_version` 与 `CHECK\|EXPECTED` 行。** 所需最低协议版本由服务侧本地比较（服务本来就知道每项能力所需的 minimumVersion）。 | 该参数名**已被并发控制语义占用**：`bootstrap-sap-helper.ps1` 中 `iv_expected_version` 在 DDIC_API（约 1498、1597–1609 行）与 DYNPRO_API（约 7168、7192、7280、7353 行）里表示“调用方期望的对象版本”，用于乐观并发校验。复用它做协议协商会造成同名字段双重语义。取消后首个助手 `Z_ORVANTA_MCP_EXECUTE` 的函数接口**完全不变**，满足 G4 零破坏。 |
| R2  | 首个落地范围仅 `Z_ORVANTA_MCP_EXECUTE`。                                                                                                   | 其背后的 10 项 `repository-helper-*` 能力（minimumVersion 1.1–2.6）当前全部为 unknown，价值最高。                                                                                                                                                                                                                                              |

### 3.5 后续补齐清单（同一协议，逐文件落地）

| 目标                                                                                           | 位置                                                                                                                                | 说明                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `Z_ORVANTA_MCP_DDIC_API`                                                                       | `scripts/bootstrap-sap-helper.ps1` 约 846 行起的 `CASE iv_operation.`（`New-DdicFunctionSource`）                                   | 该助手已有 `iv_expected_version`（并发控制），故仍按 R1 不用于协议协商                                           |
| `Z_ORVANTA_MCP_DYNPRO_API`                                                                     | 同上文件，非 DDIC 分支（`$repositoryFunctionSource` 之外的 GUI/屏幕体）                                                             | 同上                                                                                                             |
| `Z_ORVANTA_MAINT_READ`                                                                         | `scripts/maintenance-diagnostic-source.mjs`（3 个 WHEN）                                                                            |                                                                                                                  |
| 运维日志读取助手                                                                               | `scripts/operational-log-source.mjs`（5 个 WHEN）                                                                                   |                                                                                                                  |
| `Z_ORVANTA_LOG_READ` / `Z_ORVANTA_OPS_READ` / `Z_ORVANTA_SCI_API*` / `Z_ORVANTA_SMARTFORM_API` | `application-log-read-source.mjs`、`job-spool-source.mjs`、`sci-v2-source.mjs`、`sci-e2-source.mjs`、`report-parameters-source.mjs` | 这些生成器**当前没有 `CASE iv_operation` 分派**（`WHEN` 计数为 0），需先确认其操作码分派形态再决定是否适用本协议 |

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

| #    | 步骤                                    | 期望                                                                                   |
| ---- | --------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------ |
| A4-1 | 在 `w200` 对每个助手调用 `CAPABILITIES` | `ev_status='S'`，`ev_version` 为该助手最高协议，载荷含 `PROTOCOL                       | MAX`与全部`OPERATION` 行 |
| A4-2 | 对照打包清单校验 `SOURCE                | HASH`                                                                                  | 与部署证据中的指纹一致   |
| A4-3 | 重新运行 `get_capability_report(w200)`  | 原 10 项 `repository-helper-*` unknown 归零；`helperAttestation` 出现全部已部署助手    |
| A4-4 | 在未升级的助手/端点调用 `CAPABILITIES`  | 返回 `OPERATION_NOT_SUPPORTED`，无副作用，报告标注 `operation-scoped`                  |
| A4-5 | 回归既有只读工具                        | `search_abap_objects`、`read_abap_table`、`read_background_job_log` 等仍返回原结果结构 |

**未完成上述验收前，不得在文档或能力报告中宣称「助手版本可自证」。**

---

## 6. 风险与缓解

| 风险                                    | 缓解                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------ |
| 助手升级需要新的 Workbench 传输与激活   | 复用 0.43.4 确立的「显式请求号 + 写后回读」流程；升级前先跑 `CAPABILITIES` 记录旧版本 |
| 生成期哈希注入错误                      | 部署脚本在部署后立即调用 `CAPABILITIES` 并把返回的 `SOURCE                            | HASH` 与本地计算值比对，不一致即失败 |
| 新旧助手混布                            | 判定表按「每个助手」独立报告，不做整体结论                                            |
| `ev_version` 语义变更被误用到其它操作码 | 仅在 `CAPABILITIES` 分支使用新语义；在生成器中加注释与断言，其余分支保持原值          |
