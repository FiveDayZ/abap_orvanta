# SM12 / SM13 只读诊断

第二批范围：MVP-05、MVP-06。状态为本地候选，测试待人工执行；未部署新助手，未读取实际锁列表或失败更新样本，未执行测试或业务数据操作。产品版本暂留 0.36.31，运行中的原包不包含本批代码。

## 工具与边界

| 工具                    | 输入                                                                                        | 结果与限制                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `search_sap_locks`      | connectionId、准确 username；可选 tableName、lockObject、argument；maxResults 1-100，默认20 | 当前客户端锁条目；持有用户、表、锁对象、模式、锁参数、主机、事务及可取得的所有者时间。锁参数按字面匹配，星号不是查询通配符 |
| `search_failed_updates` | connectionId、准确 username、fromSystemTime、toSystemTime；maxResults 1-100，默认20         | 不超过一小时的 SAP 本地时间窗口，按 VBHDR-VBDATE 降序、VBKEY 升序返回失败更新头                                            |
| `read_failed_update`    | connectionId、准确 username、updateKey；可选 expectedRevision                               | 一个保留的失败更新，最多200个模块及200条错误；错误只含模块、消息类/号、程序及行号，不读取业务参数载荷，不解释编码消息参数  |

三工具可附 operationId，仅关联现有本地 MCP 操作状态。输出明确 `provesSapLockOwnership=false`，不把本地互斥锁或恢复凭证当成 SM12 锁。更新详情提供 ST22 / SM37 查询线索，不自动执行查询；线索缺少时间窗或作业名时不构造可执行参数，也不推断因果关系。

- 成功零行：`status=ok`、`entries=[]`。
- 助手未批准：`status=unavailable`，数据为 null，不访问 SAP 助手。
- 权限不足：`forbidden/NO_AUTHORITY`，不携带数据。
- 超限、读取失败或观察到数据变化：`unsupported`，不返回残缺详情。
- 精确键未在已授权客户端/用户范围找到：`not_found`；不泄漏其他范围是否存在该键。
- 不提供解锁、更新重处理、删除、取消、重试或 SAP 恢复命令。

### 未批准回执的判别字段（R-17；自携带该改动的版本 `0.46.9` 起）

门禁失败发生在**访问 SAP 之前**，因此回执**不能**用来推断"助手未部署"。为免调用方把本地门禁读成 SAP 侧能力缺失（2026-09-21 15:34 事件即此误判），每个 `unavailable` 回执在稳定 `code` 之外附带判别字段：

| 字段                                  | 取值 / 含义                                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reason`                              | `APPROVAL_FILE_MISSING`（状态目录下没有批准文件）；`CONNECTION_NOT_APPROVED`（有文件但没有本 `connectionId` 条目）；`SOURCE_NOT_ENABLED`（条目存在但 `enabledSources` 未启用本次读取所需的来源）                                            |
| `expectedApprovalFile`                | 服务**实际读取**的批准文件绝对路径（`<状态目录>/maintenance-diagnostic-approvals.json`；状态目录由 `ABAP_MCP_STATE_DIR` 决定，否则为 `%LOCALAPPDATA%\ABAP MCP Standalone\state`）。三种 `reason` 均返回，便于管理员定位要创建或修改哪个文件 |
| `requestedSource` / `approvedSources` | 仅 `SOURCE_NOT_APPROVED` 返回：本次读取所需的来源（`SM12`/`SM13`）与该条目**已批准**的来源清单                                                                                                                                              |

对应关系：`code=HELPER_NOT_APPROVED` + `reason=APPROVAL_FILE_MISSING|CONNECTION_NOT_APPROVED`；`code=SOURCE_NOT_APPROVED` + `reason=SOURCE_NOT_ENABLED`。指纹不匹配、重复条目、批准文件非法仍为**抛出的稳定错误**（`MAINTENANCE_HELPER_FINGERPRINT_MISMATCH`、`MAINTENANCE_APPROVAL_DUPLICATE`、`MAINTENANCE_APPROVAL_INVALID`），不降级为 `unavailable`；连接绑定不一致为 `MAINTENANCE_APPROVAL_CONNECTION_MISMATCH`。

**边界**：这些字段只解释**本地**门禁状态，不构成助手已部署、指纹正确或 SAP 侧存在该能力的证据；要确认助手部署与协议版本，请读能力报告（维护族为 `operation-scoped`，报告不探测其读取）。

## SAP 实现候选

候选函数组 `ZORVANTA_MAINT`，远程函数 `Z_ORVANTA_MAINT_READ`。它们仅是本地部署提案，不代表对象创建或修改授权。

源码与接口由 `scripts/maintenance-diagnostic-source.mjs` 导出：

- `maintenanceHelperDefinition`：9个可选、按值传递的 STRING 输入，以及 STRING 输出 EV_RESULT。
- `maintenanceDiagnosticSource`：ECC 7.31 兼容风格的函数体候选。模块仅导出数据，不连接或部署 SAP。
- action 固定为 LOCK_SEARCH / UPDATE_SEARCH / UPDATE_DETAIL，不允许任意函数、表名、SQL、RFC destination 或文件路径。
- SM12：固定调用 ENQUEUE_READ，显式当前客户端、准确用户、GARGNOWC=X，不调用 DEQUEUE。跨用户显示检查 `S_ENQUE/S_ENQ_ACT=DPFU`。
- SM13：本批保守要求 `S_ADMI_FCD=UADM`，即便查询自己的更新也要求；这是更严格的本批策略，不是声称等同 SM13 全部原生显示权限。
- SM13 仅 SELECT VBHDR/VBMOD/VBERROR，限定 VBMANDT 与用户；不读取 VBDATA、不返回 VARMSGVAL，不调用 RSM13000 的屏幕或重处理例程。
- 失败谓词为 `VBSTATE=253 OR VBRC between 2 and 201`，保留原始状态/返回码，不把所有非零返回码都视为错误。
- 详情对有界模块/错误表及抬头复读，观察到漂移则拒绝；没有 SAP 锁，不保证数据库事务快照。

## 资源与完整性

ENQUEUE_READ 的实际接口没有最大行数参数。仅允许准确用户查询，可进一步按表/参数缩小原生选择；取回的选择结果超过2000条即拒绝，不做客户端全系统无限扫描或继续取页。但该限制发生在原生读取之后，不是 SAP 内存、执行时间上限。仅按锁对象的过滤发生在准确用户选择之后。

更新检索最多读取 maxResults+1 个抬头；详情每次最多读取201个模块/错误，超过200就拒绝。行数限制不是数据库扫描工作量保证，应在批准前评估 VBHDR 的索引与选定用户/时间范围。

锁的 GTDATE/GTTIME 来自所有者标识，不称为准确“取得锁的时间”或事务超时依据。空时间保留 null。更新 VBDATE 按 SAP 本地时间原样解释，不默认其为 UTC。

详情 revision 覆盖返回的头、模块和结构化错误，不覆盖被排除的业务载荷。输出错误正文明确不可用，不把消息模板当作已渲染错误。显示层应把所有文本视为不可信数据。

## 启用门禁

默认没有批准文件，不提供通用标准 RFC 调用替代或直接表查询绕过。

管理员在准确对象、包、请求、部署及人工验收获批后，才可在现有状态目录维护 `maintenance-diagnostic-approvals.json`：

```json
{
  "version": 1,
  "connections": [
    {
      "connectionId": "w200",
      "url": "准确现有连接地址",
      "client": "200",
      "username": "准确连接用户",
      "sourceFingerprint": "部署后实际读取的64位小写SHA256",
      "interfaceFingerprint": "部署后实际读取的64位小写SHA256",
      "enabledSources": ["SM12", "SM13"]
    }
  ]
}
```

此示意文档不是可直接启用的批准文件，本轮未生成真实批准配置。每次调用均检查连接绑定、重复条目、启用来源、实际助手身份及双指纹；任何读失败都不能解释为对象缺失或零记录。修改助手后需重新审查和更新批准指纹。

### 生成批准文件（2026-09-21 16:25 事件后的固定流程）

`code=HELPER_NOT_APPROVED` 只说明本机批准门禁未放行，**不是** SAP 侧能力缺失；2026-09-21 的两次事件（15:34 与 16:25）都因此误判。判据：

| 返回                                                             | 含义                                                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `status=unavailable`、`code=HELPER_NOT_APPROVED`、`entries=null` | 本地批准文件缺失或未含该连接（R-17 起另带 `reason` 与 `expectedApprovalFile`） |
| `status=unavailable`、`code=SOURCE_NOT_APPROVED`                 | 连接已批准，但该来源未启用（R-17 起带 `requestedSource`/`approvedSources`）    |
| `status=ok`、`code=OK`、`entries` 为**数组**                     | 门禁已放行；空数组表示"无匹配锁"，不是"状态未知"                               |

收集与写入批准文件（**只读**读取现状，`--write` 才落盘）：

```powershell
# 1) 先看会写什么：连接身份取自服务实际使用的 connections 文件，指纹取自现网助手
node scripts/prepare-maintenance-approval.mjs
# 2) 写入状态目录（默认 %LOCALAPPDATA%\ABAP MCP Standalone\state），并立即用同一入参验证
node scripts/prepare-maintenance-approval.mjs --write --verify --username <SAP用户>
```

要点：

- `sourceFingerprint`/`interfaceFingerprint` 由 `read_function_module_interface` 读取 `Z_ORVANTA_MAINT_READ` 得到，与门禁内部比对的是同一 reader、同一算法；脚本在助手不在 `ZORVANTA_MAINT`、未启用远程、是 update-task 模块或指纹非 sha256 时直接拒绝。
- 文件**每次调用都会重新读取**，写入后无需重启服务；已存在文件时会保留其它连接的条目。
- 撤销方式：删除该文件，或从 `connections[]` 移除该连接。`enabledSources` 只写实际批准的子集（如仅 `["SM12"]`）。
- 本脚本不绕过任何检查，也不在 SAP 侧写入；它只提供门禁要求的既有事实。

版本、包部署、助手部署、客户端接入、真实非空/空/权限样本和业务流程验收是不同门禁。本地 mock 通过也不证明 ABAP 语法、授权对象行为、SAP 原生读取或样本等价。
