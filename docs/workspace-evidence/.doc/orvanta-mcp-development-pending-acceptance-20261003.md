# ORVANTA MCP · 开发面待人工验收清单（2026-10-03 修订版）

- 生成时间：2026-10-03（Asia/Shanghai）；本文件**取代** `orvanta-mcp-development-pending-acceptance-20261002.md`（后者保留作 R2 历史交付物，不删）
- 数据来源：**已提交的** `contracts/verification-registry.json`（修订点 `8ebd347`，172 条：verified 133 / unverified 30 / platform-unsupported 8 / failed 1）与 `contracts/tool-index.json`（172 工具 / 105 只读）；本文件由脚本生成，**工具列表不会与登记表漂移**
- 系统 / 客户端：w200 / 200（GR2，SAP_BASIS 7.31 SP04，非生产）
- 传输：`GR2K923472` / 任务 `GR2K923492`（状态 `D`，**未释放**）

## 0. 这份清单是什么、不是什么

- R2 的目标是「把工作区里**已经有真实调用记录**却从未登记的工具补进验收登记表」，该批已完成；此后 R7-B / R7-D 两轮真机只读验收又把 21 条升为 `verified`（20 + `read_report_parameters`），并把 3 条读侧调试工具改判 `platform-unsupported`。
- 本文件列出**仍然没有成功真实调用记录**的 30 个工具（其中 27 个是写入类），以及 1 个**到达 SAP 但失败**的工具，按分组给出可执行的验收路径。

**它不是**「已实现待验证」的清单，也**不是**缺口清单本身：其中一部分缺的是人工一次调用，另一部分缺的是对象级写授权或 SAP 侧 API。

**判定规则**（来自 `.doc/s4-verification-registry-design.md`，本清单遵守它）：

- `verified` 必须指向一份**不可变证据**并带日期；合格形式包括 `.doc/code-update-*.md`、**事故日志**、`.doc/*-forensics-*.json`、`.doc/orvanta-<tool>-<ISO>.json`。
- **本地单元测试通过不构成 SAP 侧验收**；「代码写完了」「测试绿了」「协议版本够」都不得记为 verified。
- `failed` 的定义是「**已确定不可能成功**」，与「真实调用过且成功」是分开的两类；**到达 SAP 但失败不得记为 verified**。
- `method: none` 的纯本地工具（`get_abap_object_url`、`list_write_recovery_operations`、`release_write_operation_lock`）按登记表不变量必须保持 `unverified` + `evidence: null`，**不要安排 SAP 验收**。

## 1. 待验收工具（按分组）

### 1.1 `source` · 1 个

| 工具 | 方法 | 助手 / 路由 | 需要的 SAP 授权与最小步骤 | 预期结果 | 需回传的证据形式 |
| --- | --- | --- | --- | --- | --- |
| `create_test_include` | controlled-write | 原生 ADT / 本地 | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |

### 1.2 `ddic` · 5 个

| 工具 | 方法 | 助手 / 路由 | 需要的 SAP 授权与最小步骤 | 预期结果 | 需回传的证据形式 |
| --- | --- | --- | --- | --- | --- |
| `append_ddic_transparent_table_fields` | controlled-write | `Z_ORVANTA_MCP_DDIC_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `patch_ddic_transparent_table_settings` | controlled-write | `Z_ORVANTA_MCP_DDIC_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `recover_ddic_table_conversion` | controlled-write | `Z_ORVANTA_MCP_DDIC_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `upsert_append_structure_fields` | controlled-write | `Z_ORVANTA_MCP_DDIC_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `upsert_lock_object` | controlled-write | `Z_ORVANTA_MCP_DDIC_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |

### 1.3 `ui` · 8 个

| 工具 | 方法 | 助手 / 路由 | 需要的 SAP 授权与最小步骤 | 预期结果 | 需回传的证据形式 |
| --- | --- | --- | --- | --- | --- |
| `create_module_pool` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `create_report_transaction` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `create_transaction_code` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `delete_module_pool` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `delete_transaction_code` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `patch_abap_gui_definition` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `patch_abap_screen` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `upsert_abap_screen` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |

### 1.4 `message` · 3 个

| 工具 | 方法 | 助手 / 路由 | 需要的 SAP 授权与最小步骤 | 预期结果 | 需回传的证据形式 |
| --- | --- | --- | --- | --- | --- |
| `create_abap_message_class` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `delete_abap_message_class` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `update_abap_message_class` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |

### 1.5 `enhancement` · 5 个

| 工具 | 方法 | 助手 / 路由 | 需要的 SAP 授权与最小步骤 | 预期结果 | 需回传的证据形式 |
| --- | --- | --- | --- | --- | --- |
| `create_enhancement_hook_implementation` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `create_new_badi_implementation` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `delete_enhancement_implementation` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `update_enhancement_hook_implementation` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `update_new_badi_implementation` | controlled-write | `Z_ORVANTA_MCP_DYNPRO_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |

### 1.6 `form` · 1 个

| 工具 | 方法 | 助手 / 路由 | 需要的 SAP 授权与最小步骤 | 预期结果 | 需回传的证据形式 |
| --- | --- | --- | --- | --- | --- |
| `create_smartform` | controlled-write | `Z_ORVANTA_SMARTFORM_API` | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |

### 1.7 `quality` · 1 个

| 工具 | 方法 | 助手 / 路由 | 需要的 SAP 授权与最小步骤 | 预期结果 | 需回传的证据形式 |
| --- | --- | --- | --- | --- | --- |
| `run_atc_analysis` | controlled-write | 原生 ADT / 本地 | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |

### 1.8 `debug` · 3 个

| 工具 | 方法 | 助手 / 路由 | 需要的 SAP 授权与最小步骤 | 预期结果 | 需回传的证据形式 |
| --- | --- | --- | --- | --- | --- |
| `abap_debug_breakpoint` | controlled-write | 原生 ADT / 本地 | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `abap_debug_session` | controlled-write | 原生 ADT / 本地 | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `abap_debug_step` | controlled-write | 原生 ADT / 本地 | 写入类：需要**对象级授权**，并取「创建 → 回读 → 拒绝路径 → 清理」四段证据。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |

### 1.9 `platform` · 3 个

| 工具 | 方法 | 助手 / 路由 | 需要的 SAP 授权与最小步骤 | 预期结果 | 需回传的证据形式 |
| --- | --- | --- | --- | --- | --- |
| `get_abap_object_url` | none | 原生 ADT / 本地 | 本地类：不触碰 SAP，不需要 SAP 授权；按登记表不变量它必须保持 `unverified`。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `list_write_recovery_operations` | none | 原生 ADT / 本地 | 本地类：不触碰 SAP，不需要 SAP 授权；按登记表不变量它必须保持 `unverified`。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |
| `release_write_operation_lock` | none | 原生 ADT / 本地 | 本地类：不触碰 SAP，不需要 SAP 授权；按登记表不变量它必须保持 `unverified`。 最小步骤见 §3。 | 工具回执 `status: ok`（或该工具契约声明的具名成功码）+ 可回读的实测值 | `.doc/orvanta-<domain>-<action>-<ISO>.json`（原始 JSON-RPC 往返）+ 一条 `.doc/code-update-YYYYMMDD-HHmmss.md` |

## 2. 已被真实调用但**失败**的工具 —— 不得记为 verified

这些工具有真实调用记录，但回执是失败；按登记表定义它们不能是 `verified`。**记录在此以免有人据「有回执」误推广**：

| 工具 | 证据 | 观察到的失败（登记表 notes 的摘要，细节见登记表） |
| --- | --- | --- |
| `resume_ddic_table_activation` | `.doc/orvanta-ddic-resume-table-activation-ztpayment-2026-10-01T15-13-56-721Z.json` | 2026-10-03 (R7-D follow-up, read-only): the failing signal is now attributed from SAP's own source instead of staying a guess. A live read of the activation API (`read_function_module_interface` for DDIF_TABL_ACTIVATE on w200, evidence .doc/orvanta-read-function-module-interface-DDIF_TABL_ACTIVATE-2… |

2026-10-02 版曾把 `upsert_lock_object`、`create_smartform`、`create_enhancement_hook_implementation`、`append_ddic_transparent_table_fields`、`preview_source_changes`、`get_version_history`、`abap_debug_status` 列为「有失败回执」；这些工具当前状态请以登记表为准（多数已由 R7-B/R7-D 真机只读验收改判），本修订版不再复制它们的历史失败文本，避免与登记表漂移。

## 3. 分组最小步骤（按机器可判定的现状）

**A. 原生 ADT 只读类**（`source` 的多数、`ddic` 的读取、`function` 的读取、`data`、`platform`）：

1. 用 `search_abap_objects` 或 `get_abap_object_workspace_uri` 取得目标对象；
2. 调用该工具一次；
3. 把工具的原始回执落成 `.doc/orvanta-<tool>-<ISO>.json`；
4. 在 `.doc` 写一条开发记录，登记表即可据此提升为 `verified`。

**B. 仓库族助手类**（`helper = Z_ORVANTA_MCP_DYNPRO_API` 或 `Z_ORVANTA_MCP_EXECUTE`）：

这些工具经助手操作码执行。先读 `get_capability_report` 确认 `helperAttestation[<helper>].operations` 里**确实包含**该工具所需操作码 —— 版本够不代表操作码在（R-20 的教训）。

**C. 写入类**：

先确认对象级授权与传输号，再取四段证据：**创建 → 回读 → 拒绝路径 → 清理**。计划外对象一律用 `Z*` 一次性对象，并**保留**（本项目规则：不删除任何对象）。

**D. 调试类（`abap_debug_*`）**：
❌ 不要安排验收。能力报告已实测 `debuggerCapability = platform_unsupported`（ADT discovery 未广告任何 debugger collection），这 6 个工具已据 G1-7 从 `dev`/`config`/`ops` 三档 profile **默认隐藏**并带原因；`full` 档仍可调用，但该端点在 w200 上不存在，验收不会有正面结果。**若要翻案，前提是 Basis 先启用 `/sap/bc/adt/debugger`**，届时须重测并提升该条目。

## 4. 与能力缺口的关系（避免把两件事混为一谈）

本清单是**证据**问题；`B4/B5/B7/D-9` 是**能力**问题，另见 `.doc/orvanta-mcp-capability-gap-assessment-20261001.md` §2：

- **D-9 三项能力现已全部有实现并有归属**：`format_abap_source` = verified；`get_quick_fix_proposals` = verified（R7-A 真机 8/8 位置各 2 条提案）；`evaluate_refactoring` = platform-unsupported（rename 恒 HTTP 200 空文档、extract-method 对合法选择 HTTP 500，翻案条件是平台侧修好这两个端点）。三者的只读半都只调「求值」端点，不调编辑/预览/执行半。
- **B4 TMG**：只读实测的**唯一命中**是 `VIEW_MAINTENANCE_GENERATE`（函数组 `SVGN`），其函数体是 `CALL TRANSACTION 'SE55'/'SE56'/'SE57'` 的**对话包装器**且 `remote=false` ⇒ **无 headless 路径**；翻案需 Basis 提供**非对话**且可远程调用的生成器 API。
- **B5 SAPscript 创建侧**：`SSF_WRITE_FORM`/`SSF_CREATE_FORM` 不存在、真实 `SSF_*` FM 全部 `remote=false` ⇒ **平台边界**，建议不作开发项；创建侧的真实载体是已存在的 Smart Form。
- **B7**：备份与回滚说明**已在服务侧补齐**（写入前用 `READ_STRUCTURE` 读一次并把该读取作为 `backup` + 可执行 `rollback` 随回执返回，同时充当门禁）；Include 分量半经实测**能力已在**（`upsert_ddic_structure` 写为 `INTTAB`）。`read_ddic_table_conversion_status` 已真机验收；`recover_ddic_table_conversion` 按用户 2026-10-03 00:34 裁定**收口为「已实测不可达」的记录性边界**（保持 `unverified`，notes 内 `RULING 2026-10-03`，不再重试）；`patch_ddic_transparent_table_fields` = verified，其 **dataElement 改指类**仍缺一次真机复测（键/可空/改名类已验收）。

## 5. 未做的事（如实声明）

- 本文件**没有**为每个工具伪造「已准备好」的具体命令：多数工具的调用需要目标对象名，而给出具体对象名就要替验收人做选型决定。§3 给的是**按分组的机械步骤**，验收人只需补一个对象名。
- 本文件**没有**把任何工具标为 `verified`；所有状态改动都在 `contracts/verification-registry.json` 里，且每条都指名了被打开过的记录。
- 本修订版只重生成 §0/§1/§2/§4 中与登记表读数相关的部分；§3 与 §5 的机械步骤与声明未变。

