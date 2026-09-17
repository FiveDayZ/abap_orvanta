# SLG1 / SM37 / SM21 / 跨日志关联整批实施

## 当前状态

截至2026-09-10：**主功能已交付，本轮实施结束；证据状态仍为Partially Verified**。特殊样本按用户决定延期，受限身份测试已移出本轮门禁，既有身份和安全校验保留。M5不阻塞独立M6实施。

限定英文原生正文对照7组、SM21程序过滤2组已通过，后续修正的15项真实回归也已通过；不能再将这三项列为待实施。长中文、CHAR128极值、其他模板和真实环绕样本仍缺，不因文档更新变为通过；跨实例读取不在已交付范围，关联仍不证明因果。

源码和现有包为0.36.28；09月10日已有85工具的在线记录，本次10:28+08:00访问4847被拒绝，不能保证当前在线。完整状态与延期恢复条件见工作区[全局实施基线](../../.doc/global-implementation-baseline.md)；此链接不随便携包交付。

证据：[同语言对照](../../.doc/m5-same-language-check-20260908-152149.md)、[程序过滤](../../.doc/m5-program-filter-check-20260908-153101.md)、[M5最终汇总](../../.doc/code-update-20260908-163959.md)。原生ATC按[M6决定](../../.doc/m6-current-status.md)延期，不把SCI替代为ATC通过。

### 0.36.13 正文修复历史

以下为2026-09-08正文修复时的快照，当时运行0.36.13 / 84工具，不代表当前服务。
两只助手已保存、激活、诊断及完整回读，接口指纹不变，批准文件同步活动源码指纹。
本地 `npm run verify` 223项测试通过，扩展的15项真实SAP检查全部通过：

- SLG1：07802完整两页四条正文及错误修订号拒绝通过；36275一条正文及错误修订号拒绝通过。
- SLG1：补充36274可读样本；不存在键和非法键拒绝通过。07708的ZCA/606经有界跨语言存在性检查确认为消息定义缺失，转为明确缺失负例，不伪造正文。
- SM37：自检确认真实记录第5至8槽非空。改为八槽、每槽最多128字符的有界渲染，保留原生参数长度防截断检查；两作业正文、分页、错误revision拒绝通过。
- SM21：合法参数缓存的空尾槽不再使整条正文丢失；缓存完全为空、格式或身份不合格仍拒绝。D01已有样本和RSWWDHEX过滤样本均返回非空正文。
- 关联：SM37/SM21/ST22调用正常；当前窗口生成9条时间线事件、4组仅时间相近候选，因SM21有界尾部仍返回partial，qualityGate保持not_evaluated，不声称因果成立。
- ATC对象分析返回HTTP404；转储列表仅看到三个历史SYNTAX_ERROR，不等于已证明所有运行路径无转储。

运行 `node scripts/probe-log-body-acceptance.mjs` 可重现15项有界只读验收，失败时退出1，证据不保存原始正文。原九项失败记录仍保留，不追溯改为通过。
该时点原生显示、低权限及长中文尚缺，WebGUI曾停在登录页；后续同语言对照、程序过滤和门禁调整见上方当前状态。历史HTTP页面的传输风险没有因复用登录状态消失。本节不作为“M6-M8尚未实施”的当前结论。

### 只读正文自检

JOB_BODY_CHECK与SYSTEM_BODY_CHECK分别复用JOB_LOG和SYSTEM_READ的输入、权限、来源及大小约束，只返回固定自检码，不返回正文、参数、内部路径或异常文本。不新增RFC接口参数或普通MCP工具，不放开通用RFC白名单。自检使用已有test_remote_function_module并绑定综合fingerprint；失败回执的outcomeMayBeUnknown须结合实际输出与只读源码判断，不能自动重复。

### 0.36.12 历史基线

以下为0.36.12阶段记录；当时服务仍为0.36.10 / 79工具，不能代表当前状态。

2026-09-08已在批准的w200/200、ZABAP、GR2K923421/GR2K923422中，
完成两只SAP助手的受限读取实现、激活及完整源码回读，开始整批验收。
激活和源码一致不代表非空日志、独立事务对照或跨日志业务验收通过。

本地`npm run verify`通过：220项测试全部成功，无头检查通过。
`npm run verify:release`通过：包内62个文件指纹匹配，受控配置界面启动/停止及84工具注册通过。
真实SAP只读验收已通过SLG1不存在日志、SM37超24小时时间窗拒绝、
精确作业名空检索及不存在作业日志；均不代表非空正文读取成功。
新进程尚未取得SAP密码，仍缺0.36.12真实客户端的非空、分页、权限拒绝和跨来源验收。

| 工作项        | 本地实现                                        | SAP端                              | 统一验收                                |
| ------------- | ----------------------------------------------- | ---------------------------------- | --------------------------------------- |
| SLG1发现/检索 | 既有实现保留                                    | 已有DISCOVER/SEARCH                | 待非空、分页和独立SLG1对照              |
| SLG1消息详情  | 既有协议/门禁保留，关联层已支持                 | READ已激活，允许消息批准已更新     | 真实不存在日志返回NOT_FOUND；非空待验证 |
| SM37作业检索  | 新增search_background_jobs及严格校验            | JOB_SEARCH已激活                   | 新服务集成待验证                        |
| SM37作业日志  | 新增read_background_job_log、修订校验及有界分页 | JOB_LOG已激活，有格式/物理大小限制 | 新服务非空集成待验证                    |
| SM21系统日志  | 新增read_system_logs及范围/身份校验             | SYSTEM_READ已激活，支持自包含文本  | 新服务非空集成待验证                    |
| 跨日志关联    | 新增correlate_sap_logs，包含ST22                | 依赖上述真实来源可用               | 未运行                                  |

## 工具契约

### search_background_jobs

- connectionId、jobName、fromSystemTime、toSystemTime必填；jobName精确匹配，禁止通配符。
- 时间为SAP本地计划开始时间，范围最多24小时；不声称是实际执行时间查询。
- 可选username、status、afterJobCount；jobCount为保留前导零的8位字符串。
- maxResults为1至50，默认20；按精确作业名内jobCount升序分页。
- 返回计划、实际开始/结束时间、调度用户、执行用户、状态和执行服务器，不返回作业变式内容。
- SAP端必须显式按AUTHCKMAN约束客户端：已确认TBTCO不是以MANDT为首字段的客户端表，不能依赖隐式客户端处理。

### read_background_job_log

- connectionId、jobName、jobCount必填；不接受任意TemSe对象名。
- 本地协议要求SAP最多读取1000条完整日志，不能先不受限地读完再截断。
- maxMessages为1至200，默认100；afterMessageNumber最多1000，后续页必须提供expectedRevision。
- 对同一有界完整结果计算SHA-256修订，日志变化返回LOG_CHANGED；文本脱敏后返回。
- 不执行作业取消、释放、启动、重试、删除或更新状态。

### read_system_logs

- connectionId及成对SAP本地时间必填，范围最多1小时。
- 可选精确username、program；maxResults为1至200，默认50。
- 不接受主机、文件路径、RFC目的地或任意服务器选择。
- 约定最多扫描2000条记录，只返回本机有界尾部，不承诺全系统、所有实例或完整历史。
- 每条记录必须匹配当前客户端及同一个返回实例；重复键、范围外数据和不一致文本标记拒绝。
- textUnavailable=true时文本必须为空，不能用占位文本伪装解码成功。
- SAP端仅支持当前本机320字符记录格式；通过本机文件信息取得固定路径，最多读取2000条。
- 文本按TSL1T当前语言/英文回退解析自包含的`&A`至`&P`、数字定长及`$`替换。
  依赖其他记录的参数或不支持的替换返回textUnavailable，不泄露原始变量/Passport。
- 暂不扫描环绕点后的旧区段、旧文件和其他实例，truncated固定为true，不能当作完整历史。

### correlate_sap_logs

- 使用显式时间窗，最多24小时；包括SM21时最多1小时。
- 可选择applicationLog、job、systemLog及includeDumps（默认true）。
- applicationLog指定精确对象，可加子对象/外部编号；提供logNumber时读取消息首批，不能同时指定externalNumber。
- job指定精确作业名；提供jobCount时读取该作业日志，否则检索计划时间范围内作业。
- maxPerSource为1至20，默认10；最多4次固定只读来源调用。
- 时间线保留原来源及定位引用；未知消息时间不以日志头时间替代。
- 仅比较时间接近、结构化用户名/程序/服务器相等，不分析日志文本中的指令，不擅自提取业务键建立关联。
- 候选边最多返回200条，记录实际候选总数和截断；每条都标记causalRelationship=not_proven。
- 来源失败、未批准、不支持分别保留；全部来源不可用时总状态unavailable，不能伪装为成功空时间线。
- ST22结果若混入其他客户端，拒绝整个ST22来源，不混合关联。

## 新SAP助手部署契约

已新增 `Z_ORVANTA_OPS_READ`，所属既有函数组 `ZORVANTA_LOG`，包ZABAP。
生成的LZORVANTA_LOGU02及UXX引用已回读；没有重建已存在的对象。

动作：JOB_SEARCH / JOB_LOG / SYSTEM_READ。
使用STRINGVAL标量参数：
IV_ACTION、IV_FROM、IV_TO、IV_JOBNAME、IV_JOBCOUNT、IV_USER、IV_PROGRAM、
IV_STATUS、IV_AFTER_JOB、IV_LIMIT；唯一EXPORT EV_RESULT为JSON。
实际接口、活动源码及函数组诊断已核对；不代表运行时结果通过。

本地 `operational-log-approvals.json` 位于实际stateRoot。
每条批准记录包含connectionId、url、client、username、sourceFingerprint、
interfaceFingerprint及enabledSources（SM37 / SM21）。
已在活动源码完整回读后更新批准文件，绑定本轮源码及接口指纹。
只允许固定助手和函数组；每次读取绑定身份和双指纹，漂移即拒绝。

## 已完成的只读依赖核查

- BP_JOBLOG_READ存在，非远程；具有LINES和DIRECTION，并调用COMMON_LOG_READ_T100。
- COMMON_LOG_READ_T100对JOBLGX前缀进入read_common_log_plain；不能假定旧格式也执行相同有界路径，须继续核查。
- TBTCO字段已读取，包含JOBNAME/JOBCOUNT键、AUTHCKMAN、AUTHCKNAM、SDLUNAME、JOBGROUP、JOBLOG、计划和实际时间。
- 标准LBTCHFXX的check_job_show_privilege使用S_BTCH_JOB / JOBGROUP / JOBACTION=SHOW；消息读取权限链需继续完整核查。
- SAPMSM21的INIT_MODULE_POOL使用S_ADMI_FCD=SM21。
- RSLG_READ_FILE/ALV存在；RSLGSEL虽有LINES，但已读SEL_CHECK实现不能证明它是后端读取上限。
- RSLG_FILEINFO_INIT_ALV可获取本机记录长度、位置、环绕及文件信息；不会向Agent开放任意文件路径。
- RSLG_ITSAM_READ_SYSLOG_ALV依赖SAPMSM21的界面FORM，不作为已确认安全的无头接口。
- SXMI_XMB_SYSLOG_READ包含SXMI_LOGMSG_ENTER_INT等日志写入链路，不直接标记为无副作用只读助手。
- SLG1的BAL_DB_LOAD仍有转换及保存链路；log_decompress也可能在不一致时调用BAL_LOG_MSG_ADD。
  不通过动态更改标准函数组全局变量或关闭检查来绕过风险。

上述均为活动SAP接口/源码核查，不是函数运行测试或业务验收。

## 支持边界

### 0.36.13 验收修正

- SM21 不再把类型 p 的参数辅助记录作为正文返回；服务层也拒绝意外返回的参数记录。
- 联合时间线保留消息来源的 `textUnavailable` 和 `textTruncated`，未提供状态的来源不填造默认值。
- 新版内部使用 `READ_DIAGNOSTIC` / `JOB_LOG_DIAGNOSTIC`，响应动作仍为 `READ` / `JOB_LOG`。
  受限返回增加白名单 `reason`，表示拒绝或异常发生的检查阶段，不包含原始异常、路径或日志变量。
  例如 `DATABASE_VERSION`、`BLOCK_LAYOUT`、`TEMSE_CODEPAGE`；阶段不是未经验证的最终根因。
- 原 `READ` / `JOB_LOG` 动作响应保持兼容。两只 SAP 助手更新并回读后须同步批准指纹；
  新版客户端不得针对旧助手放宽指纹检查。SLG1 部署时同时将入口的 `READ_DIAGNOSTIC`
  响应动作映射为 `READ`，不能仅替换 READ 分支。
- 0.36.12 验收中的 SLG1 / SM37 非空正文仍未通过；本次增加诊断能力不等于消除了格式限制。

- SLG1只解压当前0001且与本机字符大小相同的BALDAT消息块；不调用BAL_DB_LOAD、
  上下文转换、保存或日志回调。最多512个数据库行、1000条消息，每块最多150条。
- SLG1使用非公开标准分块解压例程；标准代码升级必须重新核查。
  目前消息时间返回null，不把头时间伪装成消息发生时间。
- SM37绕开BP_JOBLOG_READ以及COMMON_LOG_READ_T100的写元数据路径，
  直接读取获准作业对应的文件型JOBLGX日志，并在内存中解码。
  物理读取不超过30000个本机字符；超限明确拒绝，不截断后声称complete。
  仅接受本机代码页、F格式；标准最多8槽，每槽原始声明长度不得超过DDIC的128字符。按原生DECODE_T100_MSG的编号/顺序占位符与转义规则，在本地变量中渲染，不访问SAPLSTLG共享T100状态。
  其他格式、跨代码页、较长消息参数不支持，不能宣称完整替代SM37。
- SM21读取不包含中央/远程日志；有界同身份参数缓存及标准ALV内存解码已在已有D01样本上返回正文，不推广为所有消息格式均已验收。
- 两只助手采用非公开标准例程/内核读取接口，需目标系统验证和升级复核。
- 当前ATC对象分析仍返回HTTP404，是未完成检查，不是质量通过。

## 已批准的部署范围

用户已一次性批准的具体扩展范围，无需重复确认：

1. 在w200/200、包ZABAP、请求GR2K923421 / 任务GR2K923422中，扩展Z_ORVANTA_LOG_READ的只读READ消息路径。
2. 在同一函数组新增Z_ORVANTA_OPS_READ，实现SM37和SM21受限只读动作，包含创建产生的函数Include及UXX引用。
3. 仅在完整依赖核查通过后保存/激活，回读审查后更新非秘密批准记录；跨日志关联不创建额外SAP对象。
4. 不修改标准对象、不释放传输、不创建日志或业务数据、不取消/启动/重试作业、不运行回调。
5. 全部实现后集中运行本地回归、打包、真实SAP只读正常/拒绝/非空样本及跨来源验收。

本轮授权仅包含上述客户对象及非秘密批准记录；没有修改标准对象、
释放传输、创建日志/业务数据、操作作业状态或执行日志回调。
