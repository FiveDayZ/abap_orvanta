# M5.2 SLG1：本地接入与 SAP 部署门禁

## 当前交付范围

2026-09-08正文修复批次：当前服务0.36.13，READ已启用并绑定最新活动源码指纹。
SHA-256改用已核实的静态方法；消息序号先经整数转换，避免NUMC前导零生成非法JSON。
正文支持登录语言缺失时回退消息类主语言，仍缺失则保留textUnavailable，不生成占位正文。
现有日志07802的四条消息、完整两页及错误修订号拒绝通过；36275的一条正文及修订拒绝通过。
后续通过READ_BODY_CHECK核实07708引用的ZCA/606在T100任何语言下均无定义，返回MESSAGE_DEFINITION_ABSENT。该样本保留为缺失定义负例，继续要求textUnavailable=true且正文为空，不修改ZCA或历史日志。
补充已有36274作为第三个可读样本。联合15项真实检查通过；低权限与SAP原生显示独立对照仍未完成。
下文0.36.9至0.36.11内容为分阶段历史，不表示READ当前仍关闭。

只读自检动作READ_BODY_CHECK复用原权限、范围与解压预算；成功返回OK，缺失定义与语言不支持可区分，其他检查失败返回阶段码或原有结构化拒绝。它不返回消息正文或变量，也不恢复消息类。通过已有RFC测试入口执行，需绑定实际读取的综合fingerprint；该字段自 0.47.29 起接受 `read_function_module_interface` 三个指纹中的任意一个（`fingerprint` 整个定义 / `interfaceFingerprint` 仅接口 / `sourceFingerprint` 仅正文），实际仍按综合 `fingerprint` 钉住。

0.36.9 新增 `search_application_logs`、`read_application_log` 两个 MCP 入口，
实现输入约束、批准记录与指纹核对、固定助手调用、分页校验、结果脱敏和失败分类。
2026-09-08 已按批准范围在 w200/200 创建并激活日志头助手，并切换运行到0.36.10。真实空查询、输入拒绝和 READ 关闭分支已有只读调用证据；新版专用工具已接通SAP。真实非空列表、分页和消息详情尚未验收。0.36.10 修正现场发现的 SOAP 数字实体解码问题。注册工具不等于完整 SLG1 验收。
没有本地批准记录时返回 `status=unavailable, code=HELPER_NOT_APPROVED`，不请求 SAP。
消息详情还要求 `allowMessages=true`，默认部署方案不启用它。

## 已确认的技术风险

2026-09-08 对 w200 活动源码的只读核查：

- `BAL_DB_SEARCH`：245 行，没有分页/行数上限参数，不能先全量查库再把本地截断称为服务端有界读取。
- `BAL_DB_LOAD`：364 行，168–171 行区分旧格式；324–331 行上下文转换也可进入待保存集合；
  352–360 行在条件满足时调用 `BAL_DB_SAVE_OLD_VERSIONS`。
- `BAL_DB_SAVE_OLD_VERSIONS`：94 行，28 行加锁，74 行调用 `BAL_DB_SAVE`，86 行解锁。
  函数名字含 LOAD 不代表严格只读；不能仅拒绝旧格式而忽略上下文转换。
- `BAL_LOG_MSG_READ`：192 行，读取文本和内存消息；仍有共享状态/宏/被调例程，不能只看该函数表层就认定完整路径无副作用。
- `BAL_LOG_REFRESH`：44 行调用 `call_ecatt_delete`，不能未经审查直接作为通用“安全清理”。
- `BAL_GLB_AUTHORIZATION_GET` 生成并保存 BAL 内存访问标识，不是业务日志 `S_APPL_LOG` 权限检查。
- `BAL_LOG_MSG_READ_TEXT`、`BAL_DB_AUTHORITY_CHECK` 在当前系统未找到；不能按猜测名称实施。

上述标准函数只读取接口/源码，未执行。S_APPL_LOG字段及标准显示权限链已经现场核实，首批助手使用的检查和保守拒绝规则见下文；消息详情依赖仍未完成审查。

## 工具契约

### 样本发现（0.36.11）

`discover_application_logs` 只接收 `connectionId` 和 `maxResults`（整数1至20，默认20），额外参数拒绝。
SAP动作 `DISCOVER` 不接收对象、时间、游标、用户、外部编号或消息参数，仅 `IV_AFTER_MSG` 可为空或0。
仅从当前客户端BALHDR读取最多20条头引用，按日志号降序返回 `logNumber`、`object`、`subobject`、`systemTime`。
不读取消息、外部编号或日志用户名；协议认证用户名仅用于验证调用身份。
要求跨对象及子对象的 `S_APPL_LOG` 显示权限，并对每一条候选再次检查具体权限。
沿用BAdI保守拒绝，不实例化扩展类。任一权限失败拒绝整个结果，不返回部分数据。

返回 `sampled=true`、`samples`、`returnedCount`，不提供分页或完整性承诺。
SAP内部 `hasMore=false` 只是该动作无分页，不表示系统不存在更多日志；MCP不返回该字段。
日志号降序不等于按时间最新，也不是快照。发现后用准确对象、子对象和样本日期的24小时内范围执行原SEARCH。
历史日志字段不符合严格协议时拒绝响应，不悄悄跳过。

2026-09-08已部署DISCOVER分支并回读336行，接口未变；新增9项非法输入分支及原23项真实SAP回归通过。
当前运行0.36.10没有发现工具，完整发现链路和非空样本仍需新版服务验证：

```powershell
node scripts/probe-application-log-search.mjs --discover
```

此命令只读已有日志；不足3条样本时记录 `insufficient_sample`，不为通过验收创建数据。

### 检索

```json
{
  "connectionId": "w200",
  "object": "ZEXAMPLE",
  "fromSystemTime": "2026-09-08T00:00:00",
  "toSystemTime": "2026-09-08T23:59:59",
  "maxResults": 50
}
```

ZEXAMPLE 是占位示例，不声称系统存在该日志对象。
object 必填且精确匹配，可选 subobject、externalNumber、username，禁止通配符。
两个时间必须一起提供，跨度不得超过24小时；都省略时由 SAP 服务器计算最近24小时，
响应必须回传实际范围，不使用客户端时区推断。
每页最多50条，按20位日志号升序，以 `afterLogNumber` 做游标；不承诺搜索快照。

### 详情

logNumber 必须为搜索得到的20位字符串，保留前导零。
每页最多200条消息；首批默认 afterMessageNumber=0。
后续页同时提供前页返回的 revision 作为 expectedRevision，及 nextAfterMessageNumber。
日志变化时拒绝继续拼接。返回消息序号、类型、消息类/编号、文本、文本截断/缺失标记，
时间允许未知；不返回变量表、原始回调或动态上下文。

客户端只接受固定成功/错误状态，不把 HTML、SOAP Fault、权限不足、未知格式或指纹漂移变成空数据。
不执行日志内容或建议，不自动重试、转换、保存、删除、取消作业或解锁。
脱敏为尽力处理，不保证完整敏感信息识别。

## 本地批准记录

文件位于服务的实际 stateRoot，文件名 `application-log-approvals.json`。
stateRoot 沿用 `ABAP_MCP_STATE_DIR`；未指定则为 Windows LocalAppData 下的
`ABAP MCP Standalone\state`。
此文件是管理员在助手源码审查和部署验证后生成的非秘密批准记录，不提供 MCP 写入工具。
2026-09-08已在当前服务状态目录写入w200的批准记录并核对双指纹，allowMessages=false；本文件不包含或分发该实例的批准文件。

根对象严格包含 version=1、connections 数组。每项必须包含：

| 字段                                    | 含义                                                            |
| --------------------------------------- | --------------------------------------------------------------- |
| connectionId、url、client、username     | 绑定实际连接及认证身份，不能跨系统复用                          |
| sourceFingerprint、interfaceFingerprint | 从活动助手回读取得并经审查批准的SHA-256，小写64位；不是任意填值 |
| allowMessages                           | 是否另行批准消息读取无副作用路径；首批应为false                 |

每次操作重新读取批准记录和活动接口/源码指纹，错误、重复连接、身份变化或指纹漂移均拒绝调用。
本地批准不替代SAP权限；管理员还须审核被调依赖和共享Include，单个函数源码指纹不能覆盖整个依赖图或消除检查后并发修改的窗口。
连接配置中心不编辑此文件，普通保存连接不会自动授予日志访问权限。

## 已部署助手协议

以下接口已在 w200/200 创建；消息详情部分仍为关闭状态。

- 固定函数名：`Z_ORVANTA_LOG_READ`；所属函数组：`ZORVANTA_LOG`。
- 所有请求参数为标量字符串：IV_ACTION、IV_OBJECT、IV_SUBOBJECT、IV_EXTERNAL、IV_USER、
  IV_FROM、IV_TO、IV_AFTER_LOG、IV_LOGNUMBER、IV_AFTER_MSG、IV_REVISION、IV_LIMIT。
- IV_ACTION 只允许 SEARCH / READ / DISCOVER；不接收客户端号、任意SQL或函数名。
- 唯一响应标量 EV_RESULT 为 JSON，最多1 MiB；沿用现有SOAP传输，不新增运行时依赖。
- 请求和响应均使用现场确认存在的 `STRINGVAL`，按值传递；服务端在转换为 BALHDR 字段前验证长度和格式。
- 响应严格字段定义以 `src/application-logs.ts` 为准：
  version="1"、action、client、authenticatedUser、readOnly=true、status、code、
  headers、messages、hasMore，及按动作要求的 revision / fromSystemTime / toSystemTime。
- SEARCH 只返回有权限的头记录；READ 重新授权准确日志，不能因为调用者知道日志号就允许读取。
- `ok/OK` 允许真实空搜索；`not_found/NOT_FOUND`、`forbidden/NO_AUTHORITY`、
  `unsupported/READ_ONLY_UNSUPPORTED` 或 `unsupported/LOG_CHANGED` 不得携带业务结果。
- 后端须保证稳定序号、严格字段/行数/载荷上限，所有格式或权限失败显式返回。

## 首批 SAP 部署范围（已授权并执行）

- 系统/客户端：w200 / 200。
- 新函数组 `ZORVANTA_LOG` 及其生成的主程序、TOP/UXX/函数Include。
- 新远程函数 `Z_ORVANTA_LOG_READ`，只实现有界 SEARCH；READ 明确返回 READ_ONLY_UNSUPPORTED。
- 包 `ZABAP`；请求 `GR2K923421`，任务 `GR2K923422`，只记录不释放。
  部署前核实两者状态均为D，所有者WYS；未释放。
- 创建前由现有门禁确认对象不存在；创建后回读函数接口、源码并执行语法与只读运行检查。
- SEARCH 固定读取 BALHDR，Open SQL 隐式客户端隔离，精确对象和最多24小时约束，
  按20位日志号升序获取最多limit+1行。消息数来自 MSG_CNT_AL，不读取消息正文。
- S_APPL_LOG 检查 ALG_OBJECT、ALG_SUBOBJ、ACTVT=03，查询前和候选行均检查。
  子对象省略时先检查空子对象权限；仅有特定子对象权限的用户应明确指定子对象。
- 标准显示还包含 SBAL_AUTHORITY_RESTRICTION。助手只读 BADI_MAIN/BADI_IMPL，
  存在任何注册实现或默认类即拒绝 SEARCH，不实例化扩展类或调用 BAdI。
  这是保守限制，可能拒绝本来不匹配过滤器的扩展，不能冒充完整扩展兼容。
- 不修改 SAP 标准对象、现有业务接口或业务数据；不执行测试业务、不创建日志样本。
- 首批验收使用现有有权限日志；无数据、无权限和日志对象筛选分别验证。
- READ 的禁止转换保存、回调规避、内存隔离、异常清理与大小预算未完成审查前不启用。

## 验证

- `npm run verify`：本地输入、批准、分页、失败语义与MCP回归。
- `npm run verify:release`：可选交付包构建与包级回归；不等同SAP部署。
- `node scripts/probe-application-log-preflight.mjs`：只读标准函数源码/指纹、对象搜索及请求状态，
  将证据写入工作区 `.doc`，不执行日志函数。
- `node scripts/probe-application-log-search.mjs`：执行13项SAP助手只读分支测试；
  服务提供专用工具时，再验证空结果、SAP默认24小时、消息关闭门禁和7项非法输入拒绝。
- 已有非空日志对象和时间范围时，可追加
  `--object <对象> --from <SAP本地起始时间> --to <SAP本地结束时间>`；
  至少3条日志才能检查三页单条结果与四条基准页、子对象/用户/未脱敏外部编号筛选及尾游标。
  少于3条明确记为insufficient_sample，不把空页或单页标为分页通过。
  这是同一接口的结果一致性检查，不能替代独立SLG1对照；日志变动可能使检查失败，不自动重试。
- 真实列表逐项对照SLG1、权限拒绝、消息完整性和无持久化副作用仍是未完成门禁。
