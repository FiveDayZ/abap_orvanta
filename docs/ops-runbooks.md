# 运维剧本（OP4-2）

本文件是**运维剧本**：把"某个运维问题出现时，按什么顺序调用哪些工具、看到什么算正常、什么时候必须停下、结论不能推出什么"写成可照着执行的步骤。持续文档（非时间戳记录），改动随每次交付更新。

计划出处：`.doc/orvanta-mcp-ops-coverage-assessment-and-next-phase-plan-20260925.md` OP4-2「运维 profile 与 E3 运维剧本的技能化（每套剧本只启用对应 profile）」，验收判据「运维剧本可在 `ops` 档内独立运行」。

## 1. 为什么剧本必须能被机器核对

散文式剧本会腐烂：工具改名、移出 profile、加上写语义，读者都不会知道。因此本文件的剧本集合是一份**可核对清单**：

- 下方「§2 剧本清单」是一个机器读取的 JSON 块，`test/ops-runbooks.test.ts` 直接解析它，并在每次闸门时断言：
  1. **profile 充分性**：每套剧本用到的每个工具都必须属于 `ABAP_MCP_TOOL_PROFILE=ops` 档（用 `resolveToolProfile({ABAP_MCP_TOOL_PROFILE:"ops"})` 实际解析，而不是查表推断）——这就是 OP4-2 验收判据的代码化；
  2. **只读**：每个工具在工具登记表里必须是 `readOnlyHint: true`。剧本不得包含任何写动作，因此不需要确认串，也不可能"顺手"改掉 SAP 状态；
  3. **双向同步**：剧本清单里列的工具必须真的出现在该剧本正文里，正文里出现的工具也必须列进清单——任一侧漏掉都会失败；
  4. **族覆盖无遗漏**：15 个运维场景族必须**要么**由至少一套剧本覆盖、**要么**在 §4 里逐族写明未覆盖理由；两集合不相交且并集等于全部 15 族。
- 与逐工具契约的关系：参数的完整语义、边界与错误码仍在各工具自己的文档里（`docs/diagnostic-suite.md`、`docs/application-logs.md`、`docs/runtime-diagnostics.md`、`docs/maintenance-diagnostics.md`、`docs/transport-delivery.md`、`docs/system-info.md`、`docs/table-query.md`）。剧本不复制这些细节，只规定**顺序、判读与边界**。
- 证据状态以 `contracts/verification-registry.json` 为准（2026-09-25 / 0.50.11：ops 组 20 个工具中 `verified` 14、`platform-unsupported` 1、`failed` 1、`unverified` 4）。下面的步骤表逐行标注证据状态；**未登记证据的工具不代表不可用**，而是"这个工具的成功结果尚未被任何记录证明过"，读到它的结果时应把这点一起报出去。

## 2. 剧本清单（机器核对）

<!-- ops-runbooks:manifest:start -->

```json
{
  "profile": "ops",
  "runbooks": [
    {
      "id": "job-failure-triage",
      "families": ["jobs", "spool-output"],
      "tools": [
        "search_background_jobs",
        "read_background_job_details",
        "read_background_job_log",
        "read_background_job_spool"
      ]
    },
    {
      "id": "dump-triage",
      "families": ["dumps"],
      "tools": ["analyze_abap_dumps", "diagnose_sap_failure"]
    },
    {
      "id": "application-log-lookup",
      "families": ["logs"],
      "tools": [
        "discover_application_logs",
        "search_application_logs",
        "read_application_log",
        "correlate_sap_logs"
      ]
    },
    {
      "id": "system-log-window",
      "families": ["logs"],
      "tools": ["read_system_logs", "correlate_sap_logs"]
    },
    {
      "id": "lock-and-update-check",
      "families": ["locks", "updates"],
      "tools": ["search_sap_locks", "search_failed_updates", "read_failed_update"]
    },
    {
      "id": "transport-state-check",
      "families": ["transport"],
      "tools": ["manage_transport_requests"]
    },
    {
      "id": "system-baseline-snapshot",
      "families": ["system-info"],
      "tools": ["get_sap_system_info"]
    },
    {
      "id": "table-query-lookup",
      "families": ["query"],
      "tools": ["read_abap_table", "execute_data_query"]
    }
  ],
  "uncoveredFamilies": [
    {
      "id": "traces",
      "reason": "平台挡住：analyze_abap_traces 在 w200 的 ADT 端点返回 HTTP 404，没有可编排的读路径，该族带书面豁免（证据 .doc/code-update-20260827-173838.md）。"
    },
    {
      "id": "runtime-resources",
      "reason": "该族 5 个计划工具全部未建（SM50/SM66、SM04、ST03/STAD、DB02、AL11），没有工具可以编排成剧本。"
    },
    {
      "id": "interfaces",
      "reason": "该族 3 个计划工具全部未建（SMQ1/SMQ2/SM58、WE02/WE05/BD87、SOST），且重处理属于写动作、不在只读剧本范围内。"
    },
    {
      "id": "authorizations",
      "reason": "该族 2 个计划工具全部未建（SUIM 只读检索、SU53/ST01 解析）；权限判定需要新的 SAP 侧助手能力，尚未交付。"
    },
    {
      "id": "archive-alerts",
      "reason": "该族 2 个计划工具全部未建（SARA 归档状态、RZ20 CCMS 告警），属计划内的低优先项。"
    },
    {
      "id": "landscape",
      "reason": "该族 2 个计划工具全部未建（compare_systems、promote_object），且前提是用户先确认是否存在 QAS/PRD 连接（单 landscape 时长下换环境等于部署变更）。"
    }
  ]
}
```

<!-- ops-runbooks:manifest:end -->

## 3. 剧本

所有剧本共用三条前置：① profile 设为 `ops`（`ABAP_MCP_TOOL_PROFILE=ops`，默认 `full` 会让别的档的工具也可见，剧本本身不依赖它们）；② 一切时间为 **SAP 本地时间**（`fromSystemTime`/`toSystemTime`），不是调用方机器时间；③ 所有步骤只读，**不取消、不释放、不重跑、不创建样本**。

### job-failure-triage

**触发**：用户报「某个后台作业没跑 / 跑失败了 / 像是卡住了」。

**目标**：回答四个问题——作业在不在、状态是什么、日志说了什么、有没有 Spool 输出。全部只读。

| #   | 调用                          | 关键输入（全部只读）                                                                                   | 判读                                                                |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 1   | `search_background_jobs`      | `fromSystemTime`/`toSystemTime`、`jobName`、`username`、`status`、`maxResults`；翻页用 `afterJobCount` | 返回真实作业清单；`hasMore=true` 说明还有下一页，不能把当前页当全集 |
| 2   | `read_background_job_details` | `jobName` + `jobCount`（取自步骤 1）                                                                   | 作业头：状态、计划/实际开始结束时间、发起用户                       |
| 3   | `read_background_job_log`     | `jobName` + `jobCount`、`maxMessages`；翻页用 `afterMessageNumber`                                     | 作业日志正文；`hasMore=true` 表示正文被截断而非"日志到此为止"       |
| 4   | `read_background_job_spool`   | `jobName` + `jobCount`、`stepNumber`（或 `spoolId`）、`page`/`maxLines`                                | 报表/打印输出；同一作业可能有多个 step，逐个读                      |

**停止条件**：步骤 1–4 都做完就停。任何"重跑作业、改作业、取消作业、删 Spool"的要求都**不在本剧本内**——把它们交回用户（SE37/SM37 或另立 OP2 受权动作），不要在诊断过程中顺手动状态。

**结论边界**：本剧本能证明"作业存在、状态如何、日志与输出是什么"。它**不能**证明：作业为什么失败（日志里没有的原因不要推）、作业是否还会再跑（要看 SM36 计划，本服务没有该工具）、以及**空结果的含义**——2026-09-08 的验收里两次猜测的作业名都返回空，而 `SWWDHEX`/`SWWERRE` 实际有作业，所以"某个名字查不到"只说明**这个名字**没查到，不说明系统里没有作业。证据状态：`search_background_jobs`、`read_background_job_log` 已登记真实调用；`read_background_job_details`、`read_background_job_spool` 尚无证据登记（见 `docs/ops-coverage.md` §7.1），报结论时应一并说明。

### dump-triage

**触发**：用户报「程序崩了 / 有短转储」，或某次调用返回了异常。

**目标**：找到转储、读出结构化诊断、把结论落到具体语句或对象。

| #   | 调用                   | 关键输入（全部只读）                                                     | 判读                                                                  |
| --- | ---------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 1   | `analyze_abap_dumps`   | `action: "list_dumps"`、`maxResults`                                     | 找候选转储；`dumpId` 取这里的值，不要手写                             |
| 2   | `analyze_abap_dumps`   | `action: "analyze_dump"`、`dumpId`、`includeFullContent`（长正文才需要） | 结构化诊断：程序、行号、异常类型、关联对象                            |
| 3   | `diagnose_sap_failure` | `dumpId`（或 `program`/`username`/`errorType`/时间窗）                   | 聚合诊断视图；与步骤 2 的正文互补，两者不一致时以能读到原文的一侧为准 |

**停止条件**：读到转储正文即止。修复程序属于开发轨道，不在运维剧本内；不要用"再触发一次"来复现（复现要用户授权）。

**结论边界**：能证明转储内容与出错位置。**不能**证明根因归属（跨来源关联的候选一律 `causalRelationship=not_proven`，本服务不替调用方断言因果）、也不能把"某个时间段没有转储"解释为"程序没出错"（转储有保留期，且 `list_dumps` 是分页读）。证据状态：两个工具在 2026-09-08 与 2026-09-25 都有真实读取记录。

### application-log-lookup

**触发**：用户报「业务日志里有报错」，或需要按对象/外部编号定位应用日志。

**目标**：从发现日志、按条件检索、到读正文并与其他来源对齐，全程只读。

| #   | 调用                        | 关键输入（全部只读）                                                                                                        | 判读                                                                                 |
| --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `discover_application_logs` | `maxResults`                                                                                                                | 列出系统里真实存在的日志（对象/子对象），作为后续检索的输入，而不是凭印象填 object   |
| 2   | `search_application_logs`   | `object`、`subobject`、`externalNumber`、`username`、`fromSystemTime`/`toSystemTime`、`maxResults`；翻页用 `afterLogNumber` | 命中日志抬头；`hasMore=true` 时必须继续用 `afterLogNumber` 翻页，否则会漏            |
| 3   | `read_application_log`      | `logNumber`（取自步骤 2）、`maxMessages`、`afterMessageNumber`、`expectedRevision`                                          | 消息正文；正文为空/不可用是**显式字段**，不要把它读成"日志没有内容"                  |
| 4   | `correlate_sap_logs`        | `applicationLog`（对象/子对象/时间窗）、`includeDumps`、`maxPerSource`、`correlationWindowSeconds`                          | 与作业/系统日志/锁/更新失败并排看时间线；`partial` 与 `time_only` 是它的正常诚实输出 |

**停止条件**：定位到具体消息即止。清理日志（SLG2 删除）是 SAP 侧人工动作，不在剧本内。

**结论边界**：能证明"日志存在、正文内容、时间上与哪些事件相邻"。**不能**证明因果——2026-09-08 的验收里 5 个关联候选**全部**是 `evidenceLevel=time_only`、`matchingFields=[]`、`causalRelationship=not_proven`，也就是说它们只是"时间上挨着"；同一批次还暴露出质量门仍是 `qualityGate=not_evaluated`，且时间线会丢逐条正文质量标志，因此**不要把时间线当成正文可信度的替代**。证据状态：步骤 1–3 与 `correlate_sap_logs` 均已登记真实调用（0.36.12 与 0.36.15）。

### system-log-window

**触发**：用户报「系统这段时间有异常」，或要核对某个后台程序在 SM21 里说了什么。

**目标**：在有界时间窗内读系统日志，并把边界条件说清楚。

| #   | 调用                 | 关键输入（全部只读）                                                                  | 判读                                                                             |
| --- | -------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | `read_system_logs`   | `fromSystemTime`/`toSystemTime`（**≤ 3600 秒**）、`username`、`program`、`maxResults` | 记录数、`scannedRecords`、`truncated`；`truncated=true` 是有界尾巴，不是完整日志 |
| 2   | `correlate_sap_logs` | `systemLog`（`program` + 时间窗）                                                     | 需要与其他来源并排时才做；单独看日志时跳过这一步                                 |

**停止条件**：读完窗口即止。窗口超过 3600 秒会被**拒绝**（`Diagnostic range must be between 0 and 3600 seconds`）——正确做法是切成多个小窗依次读，**不要**改成"反正返回了就用"。

**结论边界**：能证明"这个窗口内 SM21 有哪些记录"。**不能**证明三件事：① `truncated=true` 时窗口内还有未读记录；② 逐条正文的质量——2026-09-08 12:10 的验收里 5 条记录有 3 条是 `type=p` 的参数型记录却被当作正文渲染（`textUnavailable=false`），该缺陷的记录在案，0.50.x 未复测，遇到疑似参数行要显式标注；③ 空窗口等于"没事"（保留期与客户端范围都会影响结果）。证据状态：`read_system_logs` 与 `correlate_sap_logs` 均已登记真实调用。

### lock-and-update-check

**触发**：用户报「保存时报被锁 / 更新终止（SM13）」。

**目标**：判定"是不是真锁着、够不够格解锁"、以及"更新失败的原因是什么"，**只读**。

| #   | 调用                    | 关键输入（全部只读）                                                                    | 判读                                                                            |
| --- | ----------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | `search_sap_locks`      | `username`（也可加 `tableName`、`lockObject`、`argument`、`operationId`）、`maxResults` | 列出当前锁条目；`entries: []` 是真实结论（"此刻没有匹配的锁"），不是工具失败    |
| 2   | `search_failed_updates` | `username`、`operationId`、`fromSystemTime`/`toSystemTime`、`maxResults`                | 列出失败的更新记录（VBLOG/SM13 语义）；空窗口只证明这个窗口没有，不证明从未失败 |
| 3   | `read_failed_update`    | `username`、`updateKey`（取自步骤 2）、`expectedRevision`                               | 失败更新的明细与原因                                                            |

**停止条件**：三项读完即止。**删锁、重处理更新、删 Spool 都是写动作，本剧本一律不做**（OP2-2 需要逐项独立授权）。锁通常会随会话结束自行消失；请用户确认会话状态，不要在诊断流程里替 SAP 解锁。

**结论边界**：能证明"此刻有哪些锁、某窗口内有哪些更新失败、失败的具体条目"。**不能**证明锁归谁持有（本服务只报快照，不判断 SAP 侧锁的会话归属）、也不能证明"没有锁 = 不会再被锁"。证据状态：`search_sap_locks` 已登记真实调用（2026-09-24，`entries: []`）；`search_failed_updates`、`read_failed_update` 尚无证据登记——它们的验收入口需要一个**真实的失败更新样本**，而为了凑样本去制造失败更新是不允许的。

### transport-state-check

**触发**：用户问「某个请求里到底有哪些对象 / 我的请求现在是什么状态」。

**目标**：只读核对传输请求的归属、状态、对象清单与交付范围。

| #   | 调用                        | 关键输入（全部只读）                                                                  | 判读                                                                                                 |
| --- | --------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | `manage_transport_requests` | `action: "get_user_transports"`、`user`                                               | 用户请求清单；**`Source:` 行说明是 ADT organizer 还是 CTS 表（E070/E07T）作答**，两者空结果含义不同  |
| 2   | `manage_transport_requests` | `action: "get_transport_details"`、`transportNumber`                                  | 请求头：所有者、描述、状态、任务数                                                                   |
| 3   | `manage_transport_requests` | `action: "get_transport_objects"`、`transportNumber`                                  | 对象清单（与 E071 对齐）                                                                             |
| 4   | `manage_transport_requests` | `action: "prepare_delivery"`、`transportNumber`、`expectedObjects`、`inactiveTargets` | 交付前的范围核对：期望对象 vs 请求内实际对象、重复项、未激活目标；**只比对，不释放、不导入、不部署** |

**停止条件**：步骤 3 或 4 之后即止。**释放请求、导入队列、删除条目一律不做**（释放与导入属 OP2-3，需要独立授权；清理传输条目目前在 w200 上呈 `failed`，见 `docs/ops-coverage.md` §7.1）。

**结论边界**：能证明"请求存在、状态、对象清单、交付范围是否吻合"。**不能**证明"没有别的请求"：`get_user_transports` 落到 E070 时读取上限是 **500 行**，清单答到 500 条必须当成"可能被截断"。另外这段里有真实的历史教训：2026-09-24 上午同一动作曾对 `WYS` 返回 **0 条**，而 `GR2K923488` 刚从 E070 读回 `AS4USER=WYS`——那个 0 是假阴性，由 CTS 表后备修复。所以**空清单必须配合 `Source:` 行与第二来源核对再下结论**。证据状态：`manage_transport_requests` 已登记真实调用（0.47.12，500/500 带描述）。

### system-baseline-snapshot

**触发**：用户问「这套系统是什么版本 / 有哪些组件 / 客户端是什么角色」，或要在诊断前记录基线。

**目标**：一次只读调用拿到可核对的系统基线。

| #   | 调用                  | 关键输入（全部只读）          | 判读                                                                              |
| --- | --------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| 1   | `get_sap_system_info` | `includeComponents`（默认含） | 版本、组件清单（`componentsComplete` 表示是否读全）、客户端角色与跨客户端变更保护 |

**停止条件**：一次调用即止。需要更细的表级事实时改走 `table-query-lookup`，不要把基线剧本扩成任意查询。

**结论边界**：能证明"读到的组件/版本/客户端类别"。**不能**证明：① 内核与数据库版本（本工具不读 RFC_SYSTEM_INFO，属 OP1-4 未交付部分）；② `EXTRELEASE` 对应的支持包级别——项目刻意**不换算**该字段（`docs/system-info.md` 输出契约第 12 条），所以不要把它读成 "SPxx"；③ 客户端角色不等于账户权限。证据状态：已登记真实调用（0.36.17 探针，两种组件模式 `Passed`、114 个组件完整读取）。

### table-query-lookup

**触发**：用户问「SE16 里这张表这几行是什么」等需要看具体数据的运维排查。

**目标**：在**允许列表 + 行数上限**内读表，或走降级查询路径，全程只读。

| #   | 调用                 | 关键输入（全部只读）                                                      | 判读                                                                                                                                                        |
| --- | -------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `read_abap_table`    | `tableName`、`columns`、`filters`（最多 8 项 AND）、`maxRows`（上限 500） | 首选路径：单表读，宽行按主键分块拼接；`filters` 支持 `=`、`<>`、`<`、`<=`、`>`、`>=`                                                                        |
| 2   | `execute_data_query` | `sql`（白名单表 + 单表 SELECT）                                           | 仅当需要 `SELECT` 语义时使用；运算符集合与 `read_abap_table` 一致，另支持 `OR`（≤8 分支）、`COUNT/SUM/MIN/MAX` 配 `GROUP BY`（≤8 键）与 `ORDER BY`（≤8 键） |

**停止条件**：拿到行即止。越界语句（JOIN、表达式、子查询、非白名单表、无法静态枚举的表名）在**触碰 SAP 之前**就被拒绝——这是正确行为，**不要**为了让它通过而改写语义或换近似查询后把结果当同一结论。`OR`、聚合与 `ORDER BY` **在方言内**：`OR` 每个分支各读一次并在合并时按整行身份去重；`ORDER BY` 是"对整个匹配集"的断言，任一分支触及行上界即整体拒绝（`TABLE_QUERY_ORDER_BY_INCOMPLETE`）；聚合同样是"对整个匹配集"的断言，任一分支被截断即拒绝（`TABLE_QUERY_AGGREGATE_INCOMPLETE`）——**此时不要拿样本的计数当答案，也不要手工把返回页加起来**，正确做法是收窄 `WHERE` 再问一次。

**结论边界**：能证明"允许列表内这张表的这些行/这些组的计数"。**不能**证明：① 结果的完整性——`maxRows` 达到上限、或 `querySource.incompleteBranches` 非空（某分支只取到一页）即视为截断；聚合在截断时**不给数**，`querySource.aggregated`/`groupCount` 才是"这是聚合结果、共几组"的依据；② 原生数据预览可用——w200 上原生 preview 返回 HTTP 200 但**零字节 HTML**，所以 `execute_data_query` 实际总是走降级路径，遇到"未翻译的语法"报错时应按降级方言改写，或改用步骤 1；③ 行数等于匹配行数——部分字段投影下 `querySource.repeatedProjectedRows` 只表示"逐列相同的行出现了几次"，不表示去重后的业务计数；④ 计数等于业务条数——行身份是"行的取值"，无唯一键的表里两条内容完全相同的行会被当成同一行，且 `MAX`/`MIN` 按读取器文本序（不是 SAP 类型序）取极值；⑤ 表数据等于业务真相（很多状态由程序派生）。证据状态：`read_abap_table` 已登记真实调用；`execute_data_query` 尚无证据登记。

## 4. 未被剧本覆盖的族

| 族                  | 未覆盖理由（见 §2 机器清单，两处必须一致）                            |
| ------------------- | --------------------------------------------------------------------- |
| `traces`            | 平台挡住 + 书面豁免（w200 的 ADT trace 端点 404），无读路径可编排     |
| `runtime-resources` | SM50/SM66/SM04/ST03/STAD/DB02/AL11 共 5 个计划工具全部未建            |
| `interfaces`        | SMQ1/2、SM58、WE02/05/BD87、SOST 共 3 个计划工具全部未建              |
| `authorizations`    | SUIM、SU53/ST01 共 2 个计划工具全部未建                               |
| `archive-alerts`    | SARA、RZ20 共 2 个计划工具全部未建（计划内低优先）                    |
| `landscape`         | compare_systems、promote_object 未建，且需先确认是否存在 QAS/PRD 连接 |

一个族只有在工具存在时才可能被剧本覆盖，所以**剧本覆盖率的上限就是工具覆盖率**——它不制造覆盖，只把已经能做的事固化成可重复流程。族的端到端判据仍在 `docs/ops-coverage.md` §6，由 `opsCapability` 块计算。

## 5. 本文件不做的事

- 不写入 SAP：全部 18 个被引用的工具在工具登记表里都是 `readOnlyHint: true`，`test/ops-runbooks.test.ts` 会拒绝任何非只读工具进入剧本。
- 不创建数据来服务剧本：没有真实失败更新就不做"制造一个失败更新"来验收 `search_failed_updates`；没有真锁就不造锁。
- 不代替逐工具契约文档：参数取值范围、错误码、字段含义以 §1 列出的各工具文档为准。
- 不声明覆盖率：剧本存在 ≠ 能力达标；达标与否只能由 `opsCapability.summary.criterionMet` 回答。
