# MCP 能力缺口、错误与异常日志

## 事件信息

- 时间：2026-09-26T09:15:00+08:00；序号：7；分类：`INVALID_RESPONSE` / **原结论不可复现**（`NOT_REPRODUCED`）+ `DOCUMENTATION_GAP`（参数语义未文档化，默认值导致常规用法硬失败）。
- 任务目标：复核本轮归档过程中一次"已归档快照被覆盖"的**根因**，将其作为独立缺陷记录，供服务侧修复。
- MCP 服务与版本：abap-mcp-standalone（服务名 `orvanta`）**`0.50.18`**。`get_runtime_info` 观测：`startedAt = 2026-09-26T00:48:03.203Z`（北京时间 08:48:03）；`startupArtifact` 与 `currentDiskArtifact` 指纹同为 `32acf4edc97253d3c78e668e1a74b71d9b9164f82a389f82256739324caf713f`，`fileCount 67`，`diskSinceStartup = match`，`moduleAndPackageVersion = match`，`restartRequired = false`，`toolProfile.profile = full`（151 启用 / 0 禁用）。探测发生在启动后约 23 分钟，**不是旧进程残留**。
- 已核实服务根目录：`C:\My\Workplace\Coding\vscode-abap\abap-mcp-standalone`。
- 根目录核实依据：该目录存在 `package.json` 与 `src`，且其 `.logs` 下已存有本服务六份历史事故文件（`-004127-000`、`-005300-002`、`-065100-003`、`-081800-004`、`-085000-005`、`-085500-006`）。
- MCP 工具或所需能力：`abap_download`（含 `overwrite` 参数）。辅助：`get_runtime_info`、`get_abap_object_workspace_uri`。
- 目标系统/客户端：`w200` / `200`（SAP ECC / SAP_BASIS 7.31 SP04）。
- 目标对象：`ZPMC_TP_SPLIT`、`ZPMC_TP_MERGE`（`PROG/P`）、`ZPMC_TP_API`（`FUGR/F`）——**全部为只读下载**，未修改 SAP。
- 操作性质：只读（对 SAP）+ 可写（仅本地探测目录）。
- 探测目录：`C:\Users\WU\AppData\Local\Temp\mcp-dl-probe-20260926\`（`p1`、`p2`），探测完毕已清理。
- 结果状态：**原结论不可复现**；另确立一条先前未知、真实可复现的默认值缺陷。

## 背景：本次复核的动因

本次会话归档三入口重构的活动源快照时，观察到"**已归档的 `ZPMC_TP_SPLIT` 快照文件消失**"，当时归因为 `abap_download` 的 `overwrite: true` 会清空目标目录，并据此：

1. 写入 skill `abap-orvanta-adt-playbook` §24.2，作为**通用规避规则**（"每个对象一个独立子目录"）；
2. 写入批次记录 `.doc/code-update-20260926-090900.md` 的"注意"段，作为事实陈述。

上述两处均为**未经受控复现的观察**。按项目规则（结论必须有可核验实证、不得以推测代事实），本文件对该结论做受控复现复核。

## 能力缺口分析

### 结论一：原"清空目标目录"结论**不可复现**（`NOT_REPRODUCED`）

对同一版本、同一会话、同一工具，穷举了 4 种可能触发"目录被清空"的形态，**全部未重现**：

| # | 形态 | 目标目录初始状态 | 调用 | 结果 |
| --- | --- | --- | --- | --- |
| **A** | 单对象、同目标连续两次 | `p1/` 空，另放一个人工文件 `SENTINEL_NOT_FROM_SAP.txt` | `ZPMC_TP_SPLIT`（`overwrite: true`）→ 再 `ZPMC_TP_MERGE`（`overwrite: true`） | `PROG_P/ZPMC_TP_SPLIT.abap` 与 `PROG_P/ZPMC_TP_MERGE.abap` **两者共存**；`SENTINEL` **未被删除** ⇒ 无清除 |
| **B** | **递归**文件夹型对象（最接近"清空根目录"的猜测） | `p1/` 已含 A 的 2 个 `.abap` + `SENTINEL` | `ZPMC_TP_API`（`FUGR/F`，`overwrite: true`），回执 `Files: 25, Folders: 3` | 仅**新增** `ZPMC_TP_API/{FUGR_FF,FUGR_I}/...`；原有 3 个文件**全部保留** ⇒ 无清除 |
| **C** | **失败**的下载 + `overwrite: true`（猜测"先清空、后失败"） | 同 B | 不存在的对象 `ZPMC_TP_NOSUCHOBJ_XYZ`（`overwrite: true`） | 报 `not found`；目标目录**逐文件完全未动**（28 文件仍在） ⇒ 失败不清空 |
| **D** | 同名文件覆盖语义（正向确认） | `p1/PROG_P/ZPMC_TP_SPLIT.abap` 被人为写坏（`550ae71ab52f43885d70804fad96b38c1f8702744070c94797e4ea663ce93502`） | 重下 `ZPMC_TP_SPLIT`（`overwrite: true`） | 文件恢复为 `8abea32e42f6e63054c07d6896d255495ff8f4344684dd3ab7c0f08f86540095`，与 SAP 活动源**逐字节相同** ⇒ 行为是"**按相对路径覆盖同名文件**" |

要点：

1. **实际语义是"覆盖同名 + 其余保留（含人工文件）"**，不是"清空目录"。因此原 §24.2 描述的"多对象归档时会静默丢文件"**未被证实**，其建议的规避手段（每对象一个临时子目录再搬移）**非必需**。
2. **下载失败不会破坏目标目录**（形态 C），因此"先清空、后失败导致丢文件"这一猜测同样不成立。
3. 形态 D 附带产生一个**独立的有用结论**：`abap_download` + `overwrite: true` 是可靠的"字节精确回读"通道——覆盖后的 SHA-256 与 SAP 活动源指纹一致，再次独立印证了本项目归档快照的 `8abea32e…0095`。
4. ⇒ **原始观察的成因仍未查明。** 现有证据不支持"`overwrite` 清空目录"这一定性。该结论应从 skill 与批次记录中**撤回或降级为未复现**（本次已同步更正，见文末）。同时提示：若今后再出现同类现象，应**先留存调用入参与目标目录前后清单**再下结论——本次原始调用未留存这些证据，是本条无法定性的直接原因。

### 结论二：`overwrite` 参数**未文档化**，默认值导致常规用法硬失败（真实可复现）

这是本轮**唯一可稳定复现**的缺陷，且此前未被记录。

| # | 形态 | 输入 | 结果 |
| --- | --- | --- | --- |
| **E** | 目标目录**存在但为空** | 省略 `overwrite`（即默认 `false`） | ❌ 硬报错：`Error: Target already exists: C:\...\p2. Set overwrite=true to replace matching files.` |
| **A'** | 目标目录存在且有内容 | 省略 `overwrite` | ❌ 同一报错 |

三条具体问题：

1. **参数无语义文档。** `abap_download` 的 schema 中 `overwrite` 仅声明为 `boolean`，**无 `description`**，也**未说明默认值**。默认值 `false` 系本次由实测反推（E、A'）。
2. **默认判据是"目标路径是否存在"，而非"目标是否非空"。** 因此最常规的用法——

   ```text
   mkdir <archive-dir>            # 先建目录
   abap_download {target: <archive-dir>, ...}   # 再下载
   ```

   ——**必然失败**，除非额外知道要传 `overwrite: true`。这个"必须先知道秘密参数"的形态，正是本次归档过程中反复绕路的来源。
3. **错误文案与实际行为不符。** 文案只说 `Set overwrite=true to replace matching files`（暗示会**替换**），但未说明：① 判据是"目标存在"而非"有同名文件"；② `overwrite: true` 同时会**新增**文件、并**保留**不相关文件；③ 连**空的**已存在目录也需要 `true`。

### 与既有记录的关系

- 本文件**不推翻** `-085000-005` 的 `INCLUDE_MAIN_PROGRAM_UNRESOLVED`、也不推翻 `-085500-006` 的 `CREATE_SOURCE_NOT_WRITTEN`；三者互相独立。
- 本文件**取代**此前仅在 skill §24.2 与批次记录中存在的"`overwrite` 清空目录"表述。

## 上下文与前置步骤

1. `get_runtime_info` → `0.50.18`，启动 08:48:03，产物指纹一致，`restartRequired: false`。
2. 建立探测目录 `...\mcp-dl-probe-20260926\{p1,p2}`；`p1` 内写入人工文件 `SENTINEL_NOT_FROM_SAP.txt`（用于判定"是否删除非本工具创建的文件"）。
3. **形态 A**：`ZPMC_TP_SPLIT`（`overwrite: true`）→ `Files: 1, Folders: 1`；列目录得 `p1/PROG_P/ZPMC_TP_SPLIT.abap` + `SENTINEL`。
4. 续 **形态 A**：`ZPMC_TP_MERGE`（同 `target`、`overwrite: true`）→ `Files: 1, Folders: 1`；列目录得**两个** `.abap` 共存（SPLIT 未消失）。
5. **形态 B**：`ZPMC_TP_API`（`FUGR/F`，`overwrite: true`）→ `Files: 25, Folders: 3`；列目录得原有 3 个文件全在。
6. **形态 C**：`ZPMC_TP_NOSUCHOBJ_XYZ`（`overwrite: true`）→ 报 `not found`；列目录得 28 文件**未动**。
7. **形态 D**：把 `p1/PROG_P/ZPMC_TP_SPLIT.abap` 写坏 → `sha256sum` 得 `550ae71a…3502`；重下（`overwrite: true`）→ `sha256sum` 得 `8abea32e…0095`。
8. **形态 E**：`ZPMC_TP_SPLIT` → `p2`（存在且为空，省略 `overwrite`）→ 硬报错 `Target already exists`。
9. 清理探测目录。

## 调用入参（已脱敏）

```json
{ "connectionId": "w200", "source": "ZPMC_TP_SPLIT", "objectType": "PROG/P",
  "target": "C:\\Users\\WU\\AppData\\Local\\Temp\\mcp-dl-probe-20260926\\p1", "overwrite": true }
```

```json
{ "connectionId": "w200", "source": "ZPMC_TP_MERGE", "objectType": "PROG/P",
  "target": "C:\\Users\\WU\\AppData\\Local\\Temp\\mcp-dl-probe-20260926\\p1", "overwrite": true }
```

```json
{ "connectionId": "w200", "source": "ZPMC_TP_API", "objectType": "FUGR/F",
  "target": "C:\\Users\\WU\\AppData\\Local\\Temp\\mcp-dl-probe-20260926\\p1", "overwrite": true }
```

```json
{ "connectionId": "w200", "source": "ZPMC_TP_NOSUCHOBJ_XYZ", "objectType": "PROG/P",
  "target": "C:\\Users\\WU\\AppData\\Local\\Temp\\mcp-dl-probe-20260926\\p1", "overwrite": true }
```

```json
{ "connectionId": "w200", "source": "ZPMC_TP_SPLIT", "objectType": "PROG/P",
  "target": "C:\\Users\\WU\\AppData\\Local\\Temp\\mcp-dl-probe-20260926\\p2" }
```

## 原始返回或异常（已脱敏，未改写）

### 形态 A / B / D（成功的下载）

```text
Downloaded ZPMC_TP_SPLIT to C:\Users\WU\AppData\Local\Temp\mcp-dl-probe-20260926\p1
Files: 1, Folders: 1, Skipped: 0, Failed: 0
```

```text
Downloaded ZPMC_TP_API to C:\Users\WU\AppData\Local\Temp\mcp-dl-probe-20260926\p1
Files: 25, Folders: 3, Skipped: 0, Failed: 0
```

> 注意：成功回执**不含**任何"已覆盖 / 已删除"的明细，调用方无法从中得知本次是否覆盖了既有文件。

### 形态 C（失败的下载，目标目录未被破坏）

```text
Error invoking abap_download: Error: Object ZPMC_TP_NOSUCHOBJ_XYZ (PROG/P) not found by
repository search; a search miss is not proof that the object does not exist
```

### 形态 E（本文件的核心可复现缺陷）

```text
Error invoking abap_download: Error: Target already exists:
C:\Users\WU\AppData\Local\Temp\mcp-dl-probe-20260926\p2. Set overwrite=true to replace matching files.
```

### 形态 D 的字节级证据

```text
# 写坏后
550ae71ab52f43885d70804fad96b38c1f8702744070c94797e4ea663ce93502  p1/PROG_P/ZPMC_TP_SPLIT.abap

# overwrite:true 重下后
8abea32e42f6e63054c07d6896d255495ff8f4344684dd3ab7c0f08f86540095  p1/PROG_P/ZPMC_TP_SPLIT.abap
# 与 SAP 活动源一致（= 本项目 .doc/source-backup/repack-ui-refactor-20260926-090300 的归档指纹）
```

### 目标目录清单（形态 B/C 之后，28 文件，无丢失）

```text
p1/PROG_P/ZPMC_TP_MERGE.abap
p1/PROG_P/ZPMC_TP_SPLIT.abap
p1/SENTINEL_NOT_FROM_SAP.txt          <-- 人工创建，全程未被删除
p1/ZPMC_TP_API/FUGR_FF/ZPMC_FM_*.abap   (23 个)
p1/ZPMC_TP_API/FUGR_I/LZPMC_TP_APITOP.abap
p1/ZPMC_TP_API/FUGR_I/LZPMC_TP_APIUXX.abap
```

## 影响、结果确定性与受阻工作

### 影响

- **本次归档流程被不必要地复杂化。** 依原（错误的）结论，归档改为"每对象一个临时子目录 + 手工搬移 + 事后 `sha256sum` 全量复核"。按本文件结论，直接 `overwrite: true` 落到最终目录即可，且**不会**误删他人文件。
- **能力面结论：`abap_download` + `overwrite: true` 是安全的。** 它是加法式写入（覆盖同名、保留其余、失败不破坏），也是本项目核验 SAP 源码指纹的**首选字节精确通道**。
- **残留风险（仍建议修复）**：`overwrite: true` 会**静默覆盖**同名文件。若目标目录中的同名文件含人工注释或本地修正，将被无踪覆盖，回执也不给出被覆盖清单。
- **`overwrite` 默认值构成新手上路陷阱**：不了解该参数者，遇到 `Target already exists` 时最自然的反应是换目录，从而产生多份散落的重复快照（本项目本轮即发生）。这不是数据损坏，但会污染归档目录。

### 结果确定性

- **已知不成立（经受控复现）**：`overwrite: true` 清空目标目录（形态 A / B / C 三重否定）。
- **已知成立（已复现）**：默认 `overwrite: false` 在目标**存在**（即使为空）时硬报错（形态 E、A'）；`overwrite: true` 覆盖同名文件并可字节级还原（形态 D）；`overwrite: true` 保留非同名文件与人工文件（形态 A、B）。
- **仍不确定**：原始"已归档快照消失"现象的成因。**未留存原始调用入参与目标目录前后清单**，无法追认。本文件不作推测性定性。
- 残留：无。探测目录已清理；SAP 侧未做任何写操作。

## 已考虑的安全替代方案

1. **归档一律显式传 `overwrite: true`**，目标直接指向最终归档目录（取代原 §24.2 的临时子目录法）。依据：形态 A/B 证明不会误删；形态 D 证明同名文件被正确刷新。
2. **归档前后各列一次目录清单并 `sha256sum`**（成本极低），作为"本次新增/变更了哪些文件"的独立证据——这比依赖回执更重要，因为**成功回执不报告覆盖明细**。
3. **不要依赖 `overwrite: false` 做"防误覆盖"保护**：它的判据是"目标存在"，对任何既有目录一律拒付，既拦不住误覆盖（因为必须开 `true`），又拦住正常用法。保护应靠第 2 条的自证清单。
4. **不采用**：为绕开该报错而不断新建目录（会产生重复快照）；或在未留存前后清单的情况下再次归因（会重演本次的证据缺口）。

## 后续核对与开发者复现提示

### 修复建议（按优先级）

1. **补齐 `overwrite` 的文档**：在 tool schema 中为 `overwrite` 增加 `description`，明确"默认 `false`；`true` = 覆盖同名文件、保留其余文件、不删除目标目录"。三行说明即可消除本类误解。
2. **修正默认值的判据**：把"目标路径存在即拒付"改为"**存在同名文件**时才拒付"（或把"已存在的空目录"直接放行）。当前形态使 `mkdir && download` 这一最常规用法必然失败。
3. **改写错误文案**：`Target already exists: <path>. Set overwrite=true to replace matching files.` → 建议点明"目标目录已存在即需 `overwrite=true`；该模式会覆盖同名文件并保留其他文件"。
4. **回执补充覆盖清单**：成功回执目前只有 `Files/Folders/Skipped/Failed`；建议增加 `Overwritten: <n>` 与被覆盖文件列表，使"静默覆盖"可被审计。
5. **可选**：增加 `backupExisting: true`，覆盖前把同名旧文件另存为 `<name>.bak`，把"加法式写入"的残留风险也消除。

### 5 步验收清单（修复后按此复测）

| # | 步骤 | 判据 |
| --- | --- | --- |
| 1 | 建空目录 → 下载（**省略** `overwrite`） | **不得**再报 `Target already exists`；下载成功 |
| 2 | 目录内放入人工文件 → 下载（`overwrite: true`） | 人工文件保留；回执列出被覆盖文件（若有） |
| 3 | 目标目录已含 A 的产物 → 下载 B（`overwrite: true`） | A 的产物保留；B 新增 |
| 4 | 源对象不存在 → 下载（`overwrite: true`） | 报 `not found`；目标目录**逐文件不变**（现行行为，应保持） |
| 5 | 目标内同名文件写坏 → 下载（`overwrite: true`） | 文件字节级还原；`Overwritten` 计数为 1 |

### 复现命令等价序列

```text
1) mkdir <probe>\p1 && echo sentinel > <probe>\p1\SENTINEL.txt
2) abap_download {source: ZPMC_TP_SPLIT, objectType: PROG/P, target: <probe>\p1, overwrite: true}
3) abap_download {source: ZPMC_TP_MERGE, objectType: PROG/P, target: <probe>\p1, overwrite: true}
   → 观察：两个 .abap 共存，SENTINEL 未删（否定"清空目录"）
4) abap_download {source: ZPMC_TP_API, objectType: FUGR/F, target: <probe>\p1, overwrite: true}
   → 观察：Files: 25, Folders: 3；原有文件全在
5) abap_download {source: ZPMC_TP_NOSUCHOBJ_XYZ, target: <probe>\p1, overwrite: true}
   → 观察：not found；目录未动
6) mkdir <probe>\p2
   abap_download {source: ZPMC_TP_SPLIT, objectType: PROG/P, target: <probe>\p2}   # 省略 overwrite
   → 观察：Target already exists（本文件主题缺陷）
```

### 未验证项（如实标注）

- 原始快照消失事件的成因——**未查明**，且因原始证据未留存而**不可追认**。
- `overwrite` 在**非空目录 + 同名文件位于更深层嵌套**时的匹配规则——未单独测试（形态 D 已覆盖一层嵌套）。
- 目标路径指向的是一个**文件**（而非目录）时的行为——未测。
- 跨客户端 / 其他 release 的行为一致性——未测。

## 脱敏记录

- 无凭据、口令、令牌、Cookie、锁句柄或密钥出现在本次调用入参与回执中，未执行任何脱敏替换。
- 未截断任何暴露字段。本次探测**全部为只读下载**，SAP 侧无写入、无锁、无传输请求变更。

## 文件信息

- 文件路径：`C:\My\Workplace\Coding\vscode-abap\abap-mcp-standalone\.logs\mcp-incident-20260926-091500-007-abap-download-overwrite.md`
- 字节数：写入后外部回执
- SHA-256：写入后外部回执
