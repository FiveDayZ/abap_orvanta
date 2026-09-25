# 工具兼容矩阵

> 当前口径（2026-09-25，`0.50.13`）：工具注册表静态注册 **143 个工具（只读 82 个，能力组 12 个）**，由 `npm run matrix:check` 与能力规格做一致性校验（实测输出：`tool index consistent: 143 tools, 82 read-only, 12 groups`；`helper capabilities consistent: 28 capabilities over 60 tools`）。下方按时间倒序保留各轮增量，其中"91 个工具""0.41.0 候选"等陈述均为各自时点的历史记录，不代表当前工具数；`0.47.4`–`0.50.6` 各轮增量的细节记录在 `.doc/code-update-*.md`，本表未逐轮补登。

2026-09-25 增量（`0.50.13`，运维轨道 OP4-1 收口：判据并入证据点）：`opsCapability` 的完成判据由「缺口为空」单点改为**两点合取**——必需族进入判据分子（`closedRequiredFamilyCount`）必须同时满足 ① 声明的缺口为空、② 族内**每个**工具在验收登记表里都是 `verified`。此前判据只按 ① 计算，意味着日后一旦靠"加工具"把某族缺口填成空，该族就会在工具从未被真实调用过的前提下被计入端到端，而目标原文要求的恰恰是「端到端覆盖 ≥95% **并通过验收登记**」。新增字段：`registryLoaded`、`criterionBasis`、`closedRequiredFamilyCount`、`stateClosedRequiredFamilyCount`（只按 ① 的弱读数）、`evidenceClosedFamilyCount`/`evidenceClosedFamilies`、`evidenceUnregisteredFamilies`（缺口已空但证据不全的族）、`stateCriterionMet`；每族 `verification` 增加 `closed` 与 `blockingTools`（空族永不算闭合，避免 `[].every()` 把"没有工具"判成"已闭合"）。**读不到登记表时判据不给通过**（打包产物不含 `contracts/`）：`registryLoaded: false`、分子为 0、`criterionBasis` 明说只按缺口算——这一处刻意比 `verification` 其余字段更严，因为判据是一句"已完成"的断言。实测值不变（结构上仍 2/14，且这 2 族工具全部有证据 ⇒ 分子同为 2、`evidenceUnregisteredFamilies: []`、`criterionMet: false`、`remainingRequiredFamilyCount: 12`、未建计划工具 23），差别的意义在于**今后不可能靠加工具刷高这个数字**。新增证伪测试：把 `logs` 族一个工具标成 `failed`，断言族状态不动（仍 `read-only`）而分子从 2 降到 1、该族进入 `evidenceUnregisteredFamilies` 与未闭合清单。文档同步：`docs/ops-coverage.md` §6/§7、`docs/helper-capabilities-protocol.md` §4B 样例块与判据条目。**未修改任何 SAP 对象，未执行 SAP 运行时验证。**

2026-09-25 增量（`0.50.12`，运维轨道 OP4-2：运维剧本）：新增 `docs/ops-runbooks.md`——8 套只读剧本（作业失败排查、转储排查、应用日志定位、系统日志窗口、锁与更新失败核查、传输状态核对、系统基线快照、表查询），覆盖 9 个场景族（`jobs`、`spool-output`、`dumps`、`logs`、`locks`、`updates`、`transport`、`system-info`、`query`），其余 6 族逐族写明未覆盖理由。**验收判据被代码化**：新增 `test/ops-runbooks.test.ts`，解析文档内的剧本清单并断言 ① 每个被引用的工具都能在 `ABAP_MCP_TOOL_PROFILE=ops` 下解析出来（走真实 profile 解析器）、② 每个工具在工具登记表里都是 `readOnlyHint: true`（剧本不得改 SAP 状态）、③ 清单与正文**双向**一致、④ 15 族恰好被「已覆盖 ∪ 带理由未覆盖」划分。该测试首次运行即抓到一处真实缺陷（最后一节剧本的范围切分越界到收尾章节，导致把别处提到的工具算进本剧本），并在修正后保留一条"这两条规则不是空断言"的自检（ops 档确实含写工具、登记表确实含档外工具）。工具面与族状态**未变**（143/82/12/28；15 族中仍 2 族端到端，`criterionMet` 仍 false）——剧本不制造覆盖，只把已能做的事固化成可重复流程，并逐行标注尚未登记证据的工具。**未修改任何 SAP 对象，未执行 SAP 运行时验证。**

2026-09-25 增量（`0.50.11`，运维轨道 OP0-2：证据补登）：`contracts/verification-registry.json` 的 `verified` 从 9 条升到 **21** 条、`platformUnsupported` 从 1 条升到 **2** 条，`ops` 组的 20 个工具由「verified 2 / failed 1 / unverified 17」变为「**verified 14 / platform-unsupported 1 / failed 1 / unverified 4**」。这一批**没有任何新探针**：全部来自本工作区 `.doc` 里早已存在、却从未登记进验收表的真实 w200 调用记录（2026-08-27 至 2026-09-25，版本 0.3.x 至 0.50.4），每条登记都写明证据文件、观察版本与观察时间，并显式区分「计划」与「证据」——`code-update-20260911-140842.md`、`code-update-20260910-173827.md`、`code-update-20260911-110723.md` 描述的是实施与人工验收步骤且自述未发起 SAP 调用，因此 `read_background_job_details`、`read_background_job_spool`、`search_failed_updates`、`read_failed_update` 仍保持 `unverified`（`evidence` 与 `lastAttemptAt` 均为 `null`，不编造尝试时间）。`analyze_abap_traces` 由 `unverified` 改为 `platform-unsupported`：2026-08-27 的实测调用在 w200 上得到 HTTP 404，同一次运行还完成了「403 vs 404」的判别（where-used 由 403 变 404 证明是端点缺失而非权限），这就是运维覆盖块对该族书面豁免所依据的证据。同时 `test/verification-registry.test.ts` 的 verified 上限绊线由 9 抬到 21，并在注释里逐条列出本轮引用的记录——绊线抬高的条件与该批证据一样，必须逐条可引用。两处文档同步：`docs/helper-capabilities-protocol.md` §4A-0（数例来源与「计划不是证据」的判别）与 `docs/ops-coverage.md` §7.1（剩余 4 个未登记工具的输入类型，以及 `cleanup_transport_entries` 的平台限制需要一次用户裁定）。工具面与族状态**未变**（143/82/12/28；15 族中仍 2 族端到端，`criterionMet` 仍 false）——证据维度的升级从不改变可用性判定。**未修改任何 SAP 对象，未执行 SAP 运行时验证。**

2026-09-25 增量（`0.50.10`，运维轨道 OP1-7 之一：排障查询的比较运算符）：`execute_data_query` 在 w200 上始终走降级路径（原生 data preview 端点在本版本返回 200 + 零字节 HTML），而降级路径的有限语法此前**只翻 `=`**，比它所调用的读取器 `read_abap_table` 更严——后者本就支持 `EQ/NE/LT/LE/GT/GE` 六个运算符。本轮把 `src/table-query.ts` 的 `parseSimpleTableSelect` 扩到 `=`、`<>`、`<`、`<=`、`>`、`>=`，值接受单引号字面量（双写转义）或裸数字（含负号与小数），仍限最多 8 项 AND 连接；运算符集合从 `read_abap_table` 的 zod schema 派生（`SelectFilter`），因此解析器与读取器不会再漂移。值超过读取器 40 字符上界或运算符不属于该方言（C 式 `!=`）时**不予翻译**，仍返回原生 ADT 错误，避免把"没翻译"说成"没有数据"。`ABAP_SQL_GUIDE`、`docs/table-query.md` 与 `query` 族缺口文本同步。仍未翻译：JOIN、OR、表达式、子查询、ORDER BY、聚合与函数——族状态仍为 `partial`。测试新增六运算符、裸数字/负数、转义、8 项上界与 9 项拒绝、`!=` 与超长值拒绝。静态检查与 `npm run verify` 全绿。**未修改任何 SAP 标准对象，未执行 SAP 运行时验证。**

2026-09-25 增量（`0.50.9`，运维轨道 OP4-1 校正 + 判据入码）：`opsCapability` 块此前只报"15 族中 2 族端到端（13%）"，**没有说明 95% 判据是对谁算的**；而评估的冻结矩阵（`.doc/orvanta-mcp-ops-coverage-assessment-and-next-phase-plan-20260925.md` §3.1）定义的是 **14 族**、并允许 **1 族**书面豁免（§6）——即目标是「14 族中 13 族 ≥95%」。差在 `traces` 族：它是服务侧为 `analyze_abap_traces`（`platform-blocked`，本版本无 ADT 追踪端点）单列的族，矩阵里没有这一行。本轮把这个差异**写进块本身**而不是抹平：族定义新增 `exemptReason`（仅对"全部工具都被平台挡住"的族成立，且理由不得为空，守卫据此拒绝给未建/未完成的族开豁免），`traces` 带书面豁免；摘要新增 `exemptFamilies`、`requiredEndToEndFamilyCount`(14)、`requiredEndToEndPercent`(95)、`endToEndPercentOfRequired`(14)、`remainingRequiredFamilyCount`(12)、`outstandingRequiredFamilies`（判据仍在等的族清单）、`criterionMet`（`已闭合必需族 ≥ ceil(必需族×0.95)`，**向上取整**：14 族需 14 族闭合，不允许 13.3 舍成 13）。族汇总新增 `exempt`/`exemptReason`。0.50.9 实测：仍 2 族端到端、`criterionMet: false`、23 个计划内工具未建；工具面不变（143 / 只读 82 / 12 组 / 能力项 28）。静态检查与 `npm run verify` 全绿。**未修改任何 SAP 标准对象，未执行 SAP 运行时验证。**

2026-09-25 增量（`0.50.8`，运维轨道 OP1-4 之一：系统基线的可见性与覆盖口径校正）：`get_sap_system_info` 的**摘要**新增客户端角色与变更保护行（`- Client role: Test (T); change protection: … (代码或 blank)`）——这两项（SCC4 语义）此前只在 JSON 载荷里；契约描述同步写明客户端角色/跨客户端变更保护与「`CVERS.EXTRELEASE` 逐组件原样输出、**刻意不换算成支持包级别**」。**覆盖口径校正（本轮真正的改动）**：`src/ops-coverage.ts` 的 system-info 族原把「补丁级（SPAM/SAINT）、客户端设置（SCC4）」列为缺失，实为**高估**——`collectSystemInfo` 早已读 `T000.CCCATEGORY/CCNOCLIIND` 与 `CVERS.EXTRELEASE`，`docs/system-info.md` §输出契约第 12 条更早已确立「不将 `EXTRELEASE` 自动解释为 SP」；故从计划中撤下 `read_patch_level`、`read_client_settings` 两个幻影承诺，族缺口改述为「仍缺内核/数据库版本与 RZ10/RZ11 参数配置（本工具只读六张固定表，从不读 `RFC_SYSTEM_INFO`）」，计划内未建工具数 25 → **23**。工具面不变（143 / 只读 82 / 12 组 / 能力项 28）；静态检查与 `npm run verify` 全绿。**未修改任何 SAP 标准对象，未执行 SAP 运行时验证。**

2026-09-25 增量（`0.50.7`，运维轨道 OP0：覆盖度可核对 + 文档）：**`get_capability_report` 顶层新增 `opsCapability` 块**（单一事实源 `src/ops-coverage.ts`），把 20 个 `ops` 工具逐一分档——`read-only` 16 / `action` 3 / `platform-blocked` 1——并归入 **15 个运维场景族**；族状态由"工具登记表 + 声明缺口"**推导**而非手写，**只有缺口为空的族算端到端**，实测 **2/15 = 13%**（`logs`、`dumps`），`partial` 7、`absent` 5、`blocked` 1，计划内未建工具 25 个。两条不变量写进块内词汇：①"读得到"永不顶替"处置得了"（作业族不会因为能读明细与 Spool 就变成 `read-and-act`，它停在 `partial` 并写明缺作业控制）；②`blocked`（本版本平台挡住该端点）与"尚未实现"是两句不同的话。**防漂移**：`opsClassificationProblems()` 校验"每个 `ops` 工具恰好一档、档位与注册表注解一致（`R`/`RI` 只读、`W`/`D` 动作）、每个 `ops` 工具至少归入一族、缺计划工具必须声明缺口"，非空时 `opsCapabilityBlock()` **拒绝发布**报告——悄悄漏掉工具或族的块比没有块更糟，因为它看起来像个答案；`test/ops-coverage.test.ts` 另行**证伪该守卫本身**（构造"漏声明缺口的族"与"与注解矛盾的档"，断言守卫报错），避免守卫永远为真。新文档 `docs/ops-coverage.md` 记录族/档词汇、端到端判定、授权模型（只读档 / 动作档 / 平台档；确认串 `CREATE_TRANSPORT_REQUEST`、`ADD_OBJECTS_TO_TRANSPORT`、`RUN_ABAP_PROGRAM`、`SAP_STATE_VERIFIED`；维护、运维日志、应用日志三族各需本地审批文件 `*-approvals.json`，且部署、指纹批准、本地审批文件是三道独立闸门；传输不自动释放、读工具不删除）与 95% 完成判据；`docs/helper-capabilities-protocol.md` 增 §4B 与报告样例字段。**工具面不变**（143 / 只读 82 / 12 组 / 能力项 28）；静态检查 `format:check`、`lint`、`typecheck`、`matrix:check` 全绿；**测试与 `npm run verify` 尚未执行（AGENTS.md §1.1 人工优先门槛），故本轮状态为 `Partially Verified`**。**未修改任何 SAP 标准对象，未创建/分配/释放传输，未执行 SAP 运行时验证。**

2026-09-23 增量（`0.47.3`，D7-1 SAPscript 表单读取 + `unsupported` 误读防复发）：新增工具 `read_sapscript_form`（组 `form`，只读，路由 `sap-helper-fallback`，助手 `Z_ORVANTA_MCP_DYNPRO_API`，`minHelperProtocol` `2.8`，钉操作码 `READ_SAPSCRIPT_FORM`）。助手侧在共享 repository 正文新增 `WHEN 'READ_SAPSCRIPT_FORM'`：进程内调 `READ_FORM`（组 `STXS`，`remoteEnabled=false`）读 `ITCTA`/`THEAD` 抬头与 `FORM_LINES`/`PAGES`/`PAGE_WINDOWS`/`WINDOWS`/`PARAGRAPHS`/`STRINGS`/`TABS`，`FOUND=''` **显式翻成 `NOT_FOUND`**——`READ_FORM` 在 `STXH` 定义行缺失时会先预填 `FORM_HEADER`（`COURIER`/`120`/`DINA4`/`P`），把预填值当成功返回就是凭空造出一个空表单；`includeSource` 经 `READ_TEXT`（组 `STXD`，`OBJECT='FORM'`、`ID='DEF'`、`NAME=`表单名+状态）读原始布局定义源，与 `FORM_LINES`（`ID_TXT` 文本片段）严格区分，并以 `SOURCE_STATUS`（`NOT_REQUESTED`/`OK`/`FAILED`）区分"未请求/成功/读取失败"，避免空数组被当成"该表单没有定义源"。新增 OPTIONAL `IV_INCLUDE_SOURCE`（`TDCHAR1`）——N2-1 已声明的 6 个参数无一表达"附带原始定义源"，复用 `IV_STYLE_MODE`（SmartStyle 存储族选择器）会一词两义；新增宏 `emit_d7_rows` 用 `cl_abap_typedescr=>describe_by_data` + `get_components` 枚举行类型全部组件（该生成体内已有 RTTI 先例），payload 携带真实 DDIC 字段名且 `.INCLUDE` 组成行自动解析。服务侧 `buildSapRepositoryEnvelope` 对 4 个新选择器**按需发送**（缺省不发送任何元素），否则 2.7 助手会在 `READ_SCREEN` 等无关操作上收到接口未声明的元素；解码器独立于 `repositoryPayload`（后者只接受 `M`/`F`/`T` 三种 kind，遇到表单 kind 会抛错）；契约 `version` 入参**刻意不收**（助手对非空 version 回 `FORM_VERSION_UNSUPPORTED`，schema 不得宣告助手会拒绝的入参）。**防复发**：能力报告的版本类判定新增 `remedy` 字段——安装/重打包/重启 MCP 服务不能改变 SAP 侧助手协议，`unsupported` 现直接给出 SE38 载体程序名（`Z_ORVANTA_MCP_DDIC_LOCK_DEPLOY`），载体名由 `src/helper-carriers.ts` 记录并被 `test/helper-carriers.test.ts` 回读生成器核对。**工具面** 138 / 只读 80 / 12 组 / 能力项 22；`npm run verify` exit 0、810 项测试通过。**助手仍待 repository `2.8` 载体部署，故该工具当前正确显示 `unsupported`；未修改任何 SAP 标准对象，未创建/分配/释放传输，未执行 SAP 运行时验证。**

2026-09-23 增量（`0.47.2` 修复 15:20 恢复激活事件，DDIC 助手 `1.12 → 1.13`，**待 F8 部署**）：`resume_ddic_table_activation` 对已保存未激活的完整新表返回 `WORKLIST_REQUIRED`，而 `read_ddic_table_conversion_status` 报 `pending=false`/`entries=[]`、能力报告报 `available`——**"能派发但从不执行"的整条链**。四项根因：①`WHEN 'RESUME_TABLE_ACTIVATION'` 误置 `lv_recover='X'`，使该操作进入 TBATG 转换恢复块（无工作清单回 `WORKLIST_REQUIRED`，**有工作清单则执行一次转换恢复**并在调用方传输重新记录对象），自身 `lv_resume` → `DD_TABL_ACT` 分支成死代码；②修正派发后仍被共享写路径**四道更早闸门**拦住，其中 `lv_gotstate <> 'A'` 分支（"只有非活动版本"= 正是恢复场景）会在无版本令牌时执行 `DDIF_OBJECT_DELETE` **删除待激活定义**，其余为 `DDIC_OBJECT_EXISTS`／`EXPECTED_VERSION_REQUIRED`／`VERSION_CONFLICT`；③注册表 `minHelperProtocol` 钉在 `1.11`，而 1.11/1.12 助手能派发却从不执行该操作——**版本存在被当成能力可用**；④服务端把 64 位内容指纹当作助手的 `expectedVersion`（该形参语义是活动版本时间戳令牌 `AS4DATE`+`AS4TIME`，14 位）传入，永不相等，该错配一直被①掩盖。**修复**：派发只置 `lv_write`+`lv_resume`；新增保留臂使恢复绝不进入删除重置；三道写闸门与写输入守卫各加 `lv_resume` 豁免；能力表行与分支 `ev_version` 抬到 `1.13`，注册表 `minHelperProtocol` 同步 `1.11 → 1.13`；恢复调用不再传 `expectedVersion`，陈旧读保护留在服务端 `expectedInactiveFingerprint` 门。**部署前该能力会正确显示 `unsupported`（version-check）——预期的诚实状态，不是回归。** 新增 3 项回归（均演示过"改回缺陷即失败"）；生成正文 5,145 行离线块结构检查 BALANCED（检查器以"删掉一个 ENDIF"副本证伪）。**工具面不变**（137 / 只读 79 / 12 组 / 能力项 21）；`npm run verify` exit 0、806 项测试通过。**未修改任何 SAP 标准对象，未释放传输 `GR2K923472`，未执行 SAP 运行时验证。**

2026-09-23 增量（`0.47.1` 进度版本，收口 D6-5 + 治理）：**这是进度版本，不是覆盖率里程碑，不含任何「95% 日常开发场景已覆盖」声明。** **D6-5 追加结构**：只读 `read_append_structure` 发布**基表**（不再只给字段列表），写入 `upsert_append_structure_fields` 追加/删除字段（DDIC 助手 `1.12`，**33 个操作码** dispatched over 33 declared）。随本项修复 5 个缺陷：N-2（**非活动**版本的结构不返回字段）、`AS4LOCAL`/`AS4VERS` 被误写入 `DD03P` 追加行、追加字段列表前导分隔符、每次 search-help 写入前先清空行、`$TMP` 包写入被传输要求挡下（现按 `$TMP` 跳过传输登记）。另修「契约未声明的入参被静默丢弃」——未声明的参数现在**拒绝**而不是忽略。**治理**：`get_capability_report` 新增**证据维度**——顶层 `verification` 块（`registryLoaded`/`totals`/`availabilityWithoutEvidence`/`protocolOnlyToolCount`/`protocolOnlyTools`）与每个能力、每个版本化助手族的 `verification` 汇总，数据源为 `contracts/verification-registry.json`；**验收状态永不反向影响可用性判定**，`available + unverified` 是正常状态而非缺陷，注册表读不到时全部降级为 `unverified` 而不是声称已验证（S4/R-8 落地）。`release/` 保留窗口由「只警告」改为调用 `scripts/quarantine-release-artifacts.ps1` **移动**超窗产物到 `release/quarantine/`（可逆、不删除）。R-14 两个偶发失败测试定位到根因：测试用 `listen(0)` 取端口，而本机动态端口范围 `1024–15000` 与 Node/undici 的保留端口表重叠，`fetch` 会拒绝该端口——现统一经 `test/loopback-port.ts` 取端口。R-10 客户常量集中到 `src/customer-scope.ts` 并标注「换客户是部署变更，不是配置开关」。`docs/release-process.md` 补 §7：SAP 侧助手的**人工 F8 部署步骤**、两条协议刻度（DDIC `1.x` / repository `2.x`）、载体顺序不变量与指纹重钉规则。**助手 `1.12` 已部署**（DDIC 侧）；**repository 助手回执字段（R-15/F-4）尚未交付**，仍属下一批。**D6-1 缺陷②、D7、D8、D9 未开工**；P0-3（调试器端点）与 P0-4（ADT RIS 配置）依赖 Basis 决策，**在两者给出结论前不得讨论 95% 覆盖**。

2026-09-23 增量（`0.46.15` 发布 D6-3 + D6-4，DDIC 助手 `1.11` **已部署**）：**D6-4 维护视图**新增只读 `read_maintenance_view` 与写入 `upsert_maintenance_view`（协议 `1.11`），`delete_ddic_object` 的 `objectType` 增 `VIEW`。视图语义的权威来源是 `DD_VIEW_GET` 返回的 `DD25V`/`DD26V`/`DD27P`/`DD28V`——`DD02V` 本身就是一个视图，服务侧此前没有任何视图读取路径，故 N-1"`DD02V` 读不到字段"**不是**助手丢字段，随本项交付关闭。**DDIC 助手 `1.11` 已在 `w200` 部署并自述**（正文 sha256 `8d47fd23…`，载体 r24，`PROTOCOL|MAX` 由能力表推导，32 个操作码）。**运行时闭环**：`ZORVMCPNR1`（号码范围）与 `ZORV_MCP_V01`（维护视图）均完成"创建 → 删除 → 读回不存在"。**下一段"助手 `1.11` 未部署"的表述已由本段取代。** **已知平台限制**：客户锁对象（`ENQU`）的 `TADIR` 注册被标准包检查拒绝（`TADIR_ENTRY_FAILED`；`IV_NO_PAK_CHECK` 亦不能绕过），`upsert_lock_object` 因此不可用，需人工在 SE11 创建——见 `docs/ddic-lock-object-limitation.md`。**D6-1 缺陷②仍未收口**：`HIDEFLAG`/长描述下 `DD31S`/`DD33S` 行被写入侧丢弃（工具报失败但对象已写入）。**缺陷①「描述截断」已于 2026-09-20 16:14 修复**（人工 SE37：`IV_DESCRIPTION` 的引用类型 `TSTCT-TTEXT` → `DD04T-DDTEXT`，即 `AS4TEXT` CHAR 60；`interfaceFingerprint` 由 `06b08763…` 变为 `70662f30…`）。**D6-5、D7、D8、D9 未开工。**

2026-09-22 增量（D6-3 编号范围对象**定义**，工作树未发布、助手未部署）：新增只读 `read_number_range_object` 与写入 `upsert_number_range_object`，`delete_ddic_object` 的 `objectType` 增 `NROB`（协议 `1.11`）。范围仅 `TNRO` + `TNROT`：**区间值 `NRIV` 不在范围内**，三个工具都不创建/修改/删除区间。并发令牌是 40 字符 SHA-1 **定义摘要**（语种无关，覆盖规范 `TNRO` 行与**全部** `TNROT` 行），**不是** 14 位 DDIC 时间戳，也不能当数字用；`upsert` 对 `TNRO` 属性是**部分补丁**语义（未提交的字段保持原值，绝不删除未提交的文本行），新对象从空 `TNRO` 行开始并由 SAP 自己的 `check_object` 报告缺项。写入是**一个原子 LUW**：定义写入 → `R3TR`/`NROB` 传输登记 → 单次 `COMMIT WORK AND WAIT`；登记失败以稳定码 `NUMBER_RANGE_TADIR_FAILED` / `NUMBER_RANGE_TRANSPORT_RECORD_FAILED` **失败关闭**，不留"未登记却已存在"的对象。删除失败以 `NUMBER_RANGE_DELETE_NOT_ALLOWED` 稳定拒绝（区间仍被引用等）。同批 R-20c：`repository-helper-enhancement-lifecycle` 组 8 行补 `requiredOperations`，该组能力判定不再"仅凭协议版本"。**本文件下方逐工具表未逐行登记本轮工具**——该表最后一次维护早于 D6-1/D6-2（`read_search_help`/`upsert_search_help`/`read_lock_object`/`upsert_lock_object` 均未登记），故本轮只更新"当前口径"与本增量段，不制造只覆盖一轮的逐行登记。**助手 `1.11` 未部署，本轮无 SAP 运行时证据，工具状态为 `Partially Verified`。**

2026-09-22 增量（`0.46.12`，工具面不变，只读工具回执与 URI 解析）：**`get_version_history` 对 DDIC 表报 HTTP 500**——搜索/对象信息对 DDIC 对象给出的是仓库导航 URL（`/sap/bc/adt/vit/wb/object_type/...`），它不是结构资源，向它请求 objectstructure 得到无根响应体，库随即在 `attr["adtcore:changedAt"]` 上抛 TypeError，而包装又把它显示成 `request-failed (HTTP 500)`。线上只读对照证明**所有 DDIC 表**受影响（`DD02L`、活动表 `ZTPMC_BZWL` 均失败，类对象正常），与"非活动"无关。修复：`structureUriFor()` 按类型规范创建路径改写为 `/sap/bc/adt/ddic/tables/<NAME>` 等；无根/非 XML/缺 metadata/缺版本 feed 分别转为稳定码 `VERSION_HISTORY_STRUCTURE_EMPTY`／`_NOT_XML`／`_UNPARSEABLE`／`_INCOMPLETE`／`VERSION_HISTORY_UNSUPPORTED_FOR_TYPE`，回执为 JSON `status=unavailable` + 原始 `adt` 事实 + `substitutes`（"不可读"≠"没有版本"）；`capabilityFailure` 不再给本地解析崩溃标注 HTTP 状态。

2026-09-21 增量（`0.46.11`，工具面不变，恢复激活契约变化）：**非活动读取的技术设置不可信**——助手只在活动路径上报 DD09V（`TABKAT/TABART/BUFALLOW/PUFFERUNG`），非活动路径一条不发，服务侧因此把空值当存储值；非活动回执新增 `technicalSettingsReported` 与 `warnings`。**`resume_ddic_table_activation` 拒绝不安全的激活**：无法确认可用技术设置时以 `INACTIVE_TECHNICAL_SETTINGS_NOT_REPORTED`／`INACTIVE_TECHNICAL_SETTINGS_INCOMPLETE` 失败，不再调用 `DD_TABL_ACT`；新增可选 `settingsRepair`（指纹保护 + 显式确认）先用已部署的 `PATCH_TRANSPARENT_TABLE_SETTINGS` 写批准设置，再重读、以新指纹激活，并读回活动定义逐项比对（`technicalSettingsVerified`，不一致为 `ACTIVATED_TECHNICAL_SETTINGS_MISMATCH`）。源头侧规范正文已在非活动分支补报 DD09V 四项，载体 #2 重生成（载荷 2265 行、摘要 `3c61cea7e59992f2`、基线 2119、26 操作码，**未部署**）。

2026-09-21 增量（`0.46.10`，工具面不变，服务侧解析与回执）：**非活动 DDIC 读取属性丢失**——助手在非活动描述路径把对象属性发在 `M` 组、活动路径发在 `H` 组，解析器只把 `H` 当 `header`，导致 `read_ddic_transparent_table` 的非活动回执 `description`/`tableClass` 等为空（实测 `DD02L` 同对象行 `TABCLASS=TRANSP`）；现在 `M` 作为 `H` 的回退来源（同名键 `H` 优先），非活动回执另附 `inactiveVersionAttributes`。**投影被拒回执可诊断**——`TABLE_QUERY_FIELD_INVALID` 附 `invalidColumns`/`validColumns`/`validColumnCount`；字典侧不可用（无字段／>1024／重名）改用新码 `TABLE_QUERY_DEFINITION_INCOMPLETE` 附 `definitionFieldCount`。实例：`DD02L` 无 `DDLANGUAGE`（在 `DD02V`）。

2026-09-21 增量（`0.46.9`，工具面不变）：**R-16 遗留半程收口**——能力行拆分使真实状态正文最宽 71 列（原 74 列致 `New-InstallProgram` 抛错），`test:bootstrap` 改为先物化脚本顶层 `$ddic*` 版本变量，消除"测试通过但真实路径不可用"的盲区。**R-17**——维护诊断族"未批准"回执新增 `reason`（`APPROVAL_FILE_MISSING`／`CONNECTION_NOT_APPROVED`／`SOURCE_NOT_ENABLED`）、`expectedApprovalFile`，来源未启用时另带 `requestedSource`／`approvedSources`；既有 `code` 取值不变。**门禁解封脚本**——新增 `scripts/prepare-maintenance-approval.mjs`（只读取指纹 + 默认 dry-run 写批准文件 + `--verify` 复测），`docs/maintenance-diagnostics.md` 记录两种回执形态与流程；成功口径为 `status=ok` + `entries` 数组。**DDIC 正文回移**——非活动表头改读 `ls_current_dd02v-*`、锁对象补 `ENQMODE`，生成器新增 token 级回归守卫（线上代码会被吞掉即拒绝生成）。**载体 #2 产物已生成但未部署**（载荷 2261 行、摘要 `e80a1fba7a061d09`、基线锁定 2119 行），线上助手仍自述 24 个操作码。

2026-09-21 增量（`0.46.8`，工具面不变，仅工具链与闸门）：`test:bootstrap` 与生成器自守卫恢复通过（R-16，详见 `README.md`），`npm run verify` 自 0.46.2 以来首次 exit 0；`matrix:check` 新增第二条闸门——脚本中标记块 `ORVANTA-DDIC-CAPABILITY-TABLE` 声明的操作码必须覆盖注册表为 `Z_ORVANTA_MCP_DDIC_API` 工具钉住的全部 `requiredHelperOperations`（实测 26 over 26；删除 `UPSERT_LOCK_OBJECT` 可复现失败）。该轮的 R-16 结论已被 0.46.9 更正：其"exit 0"源于测试未物化脚本顶层版本变量。线上助手仍自述 24 个操作码，补齐需载体 #2 + 人工 F8，本版本未部署。

2026-09-21 增量（`0.46.7`）：能力判定由"仅核对助手自述协议版本"改为"协议版本 + 助手自述操作码"（`evidence.source = version-and-operation-check`），新增 `partial` 判定与逐工具 `toolObservations`——写侧操作码缺失不再把同组的可用读侧判为不可用；`matrix:check` 对路由到 `Z_ORVANTA_MCP_DDIC_API` 的工具强制要求登记所需操作码。`execute_data_query` 的原生 ADT 路径接入 D5-2 表白名单（默认拒绝，新增稳定码 `TABLE_ALLOWLIST_UNVERIFIABLE`），不再只守 RFC 后备路径。发布溯源：`v0.46.1`–`v0.46.7` 标签齐备，打包闸门要求正式产物的版本标签存在且指向 HEAD。

2026-09-16 CMOD/FIBF/FI配置工作流增量：新增只读`prepare_enhancement_configuration_workflow`，覆盖CMOD项目、FIBF Event/Process处理函数分配、FI Validation/Substitution规则及OB28/OBBH激活。工具复用现有精确CMOD/BTE读回和可选FI出口程序检查，输出缺失输入、当前证据、事务步骤、包/传输控制、保存及激活确认点、停止条件、写后读回和人工运行验收清单；不打开GUI、不保存、不激活、不生成规则、不执行业务事务、不释放传输。`w200`只读核对显示`MOD_KUN_ACTIVATE`仅覆盖CMOD内部状态处理，`BF_FUNCTIONS_READ/FIND`仅覆盖BTE读取，已发现的`G_BOOL_*`/`G_VSR_*`入口不构成GGB0/GGB1与OB28/OBBH完整无屏幕维护API，因此未包装局部内部函数，也不直接更新配置表。当前仅完成源码和Mock用例准备，未执行自动测试、助手部署或真实配置验收。

2026-09-16 增强开发生命周期增量：仓库助手协议提升到2.6，在2.5的ENHO创建/读取/删除及Classic BAdI生命周期之上，新增Hook源码更新、New BAdI实现类/过滤器/默认与活动标志更新、ENHO激活和丢弃非活动版本，并补充活动、非活动、已保存非活动、未保存非活动四类状态。更新要求当前指纹、包和现有传输，遇到已有非活动版本时拒绝覆盖；所有写操作仅限Z/Y对象并使用SAP标准Enhancement Framework或SXO API，不直接更新增强配置表。ECC 7.31没有已确认的公开无界面ENHO停用API；`SXO_IMPL_UPDA`会打开SE19屏幕，因此Classic BAdI过滤器更新仍保留为人工操作。当前为本地候选，助手未部署，自动测试和真实SAP写入验收均未执行。

2026-09-17 ECC 7.31限制说明：`inspect_source_enhancements`的原生增强元数据端点可能返回`unsupported`；这是目标系统未暴露可用ADT端点的已知边界，不等于没有增强。工具继续独立返回源码事实标记，并保持`implementationCount=null`及明确原因。

2026-09-16 New BAdI/Enhancement Framework证据增量：`inspect_source_enhancements`现在保留ADT活动增强端点返回的实现类型与版本、元素ID与完整名、模式、替换标志、行列位置URI及被增强对象；实现数与元素数分开统计。该能力只证明指定基础源码上的活动代码插件元素，不读取New BAdI定义、Filter、Switch或运行时执行，也不用Classic BAdI配置表推断New BAdI。

2026-09-16 Classic BAdI配置闭环增量：新增只读 `read_classic_badi_definition`，按精确名称读取SXS_ATTR/SXS_INTER定义及接口，并关联SXC_EXIT/SXC_ATTR/SXC_CLASS中的实现、过滤值、实现类和原始激活标志。结果保留Multiple Use和激活原值；不读取New BAdI内部定义、开关或运行时执行。该读取依赖尚未部署的SAP仓库助手2.4。

说明：下方同日旧增量中的CMOD、BTE与Classic BAdI配置覆盖限制，以各自最新配置闭环增量为准。

2026-09-16 BTE配置闭环增量：新增只读 `read_bte_configuration`，按明确Event或Process标识符读取定义、SAP应用处理函数分配、客户产品处理函数分配，以及TBE11/TBE24原始激活字段；`search_bte_dispatchers`同时支持数字和字母数字标识符。结果不解释处理顺序，不验证处理函数存在性，不执行处理函数，也不修改FIBF配置。该读取依赖尚未部署的SAP仓库助手2.3。

2026-09-16 Customer Exit配置闭环增量：新增只读 `read_customer_exit_definition`，精确读取SMOD定义及MODSAP组件；新增 `read_customer_exit_project`，精确读取CMOD项目原始MODATTR状态及MODACT增强分配。原始组件类型码和项目状态码均保留，不猜测目标系统状态语义；SAP助手的标准程序屏幕与GUI定义读取改为只要求程序名，所有对应写操作继续受Z/Y保护。两项新读取依赖尚未部署的助手2.2。

2026-09-16 增量：新增只读 `inspect_source_enhancements`，分离原生ADT增强实现元数据与源码事实标记；新增 `search_enhancement_objects`，分别盘点 `ENHC/ENHS/ENHO/BADI/BADII`；新增 `search_customer_exit_objects`，分别盘点 `SMOD/CMOD`；新增 `inspect_customer_function_exits`，从主程序及有界静态include图解析 `CALL CUSTOMER-FUNCTION`，关联精确出口函数并提取可读源码中的 `ZX*` 实现include；新增 `inspect_customer_screen_menu_exits`，从明确屏幕的Flow Logic读取 `CALL CUSTOMER-SUBSCREEN` 区域，并从活动GUI定义读取以 `+` 开头的菜单功能码；新增 `search_bte_dispatchers`，按标准名称分别搜索BTE Event与Process调度函数；新增 `search_badi_objects`，以精确仓库子类型分开Classic BAdI定义/实现、Enhancement Spot容器和New BAdI实现；新增 `inspect_enhancement_framework`，结构化读取显式Point/Section并推导源码及例程首尾的隐式增强候选；新增 `inspect_fico_rule_exit_program`，关联FI校验/替代出口目录声明与FORM实现。各仓库类型保留独立失败状态，端点不支持、无权限、超时或其他错误不再被当作“没有增强”；隐式候选不替代SAP增强编辑器确认。当前仅完成实现和回归用例准备，未执行本地测试或真实SAP检查；CMOD分配/激活、Screen/Menu Exit组件归属与客户实现、GGB0/GGB1规则、OB28/OBBH激活、调用点、前提条件和运行时执行仍不在工具覆盖范围。

2026-09-15 增量：本地候选 `0.41.0` / DDIC助手 `1.7` 增加复杂透明表布局保留、技术设置补丁、TBATG 状态指纹和 SAP 原生转换恢复。当前未执行本地测试、助手部署或真实带数据表转换；所有写路径仍需准确对象、包、传输及显式确认，恢复不等于历史字段值重建。

2026-09-14 增量：`read_smartform`、`create_smartform`、`save_smartform`、`activate_smartform` 已加入本地候选源码。依赖的 `ZCL_ORVANTA_SMARTFORM` / `ZORVANTA_SF` / `Z_ORVANTA_SMARTFORM_API` 已在 w200/200 的 ZABAP 包创建并激活，语法与接口回读通过；请求 GR2K923421、任务 GR2K923422。运行服务0.40.1 BOM修正候选已验证指纹；14项本地测试、两个标准表单6次只读调用、独立XML解析及仓库指纹稳定性通过。ZORVANTA_SF_TEST / ZABAP 的真实创建、保存、激活、草稿隔离、双版本备份、过期指纹及重复创建拒绝已验收；生成函数存在但未执行，ATC与故障恢复边界仍有缺口。见[部署与人工验收](../../.doc/orvanta-smartforms-mcp-20260914.md)。

原工具契约基线：`vscode_abap_remote_fs` 版本 `2.7.0`，提交
`0466e8ceea4e201335d74a7420ac894384f4a0e2`；它不是独立服务当前发布提交。

状态整理日期：2026-09-11。0.36.33第三批候选源码静态注册91个工具，增加固定ZTPMC_TPCFG只读配置预览和Unit结构化结果；第三批人工回归、真实预览及断言执行待完成。新增工具不提供配置保存。下表不是91项当前SAP验收；已有工作树与历史交付证据保留。详见[第三批候选版](mvp-batch3-candidate.md)。

工作区[全局实施基线](../../.doc/global-implementation-baseline.md)统一M1-M8、延期决定与证据索引（不随便携包交付）。M6.4为引用分析，M6.5为真实调试；历史m64-\*调试记录不重命名。

| 工具                                         | 名称/输入契约 | 独立实现                                   | VS Code依赖替代           | 当前结论                                 |
| -------------------------------------------- | ------------- | ------------------------------------------ | ------------------------- | ---------------------------------------- |
| `get_connected_systems`                      | 已冻结        | 已实现                                     | 独立连接配置              | 真实双跑通过                             |
| `get_capability_report`                      | 独立扩展      | 已实现，只读动态能力报告                   | ADT/助手有界只读探测      | w200只读验收通过                         |
| `get_runtime_info`                           | 独立扩展      | 运行版本及启动/当前磁盘指纹对照            | 独立Node文件读取          | 0.36.31候选；测试待人工执行              |
| `preview_source_changes`                     | 独立扩展      | 多对象只读差异、非活动版本和分配预检       | ADT读取及现有仓库助手     | 0.36.31候选；不写入，真实预检待验        |
| `search_sap_locks`                           | 独立扩展      | 精确用户与可选表/锁对象/字面键查询         | 新只读助手候选            | 第二批本地；未部署、未执行测试           |
| `search_failed_updates`                      | 独立扩展      | 当前客户端、一小时内精确用户失败更新检索   | 新只读助手候选            | 第二批本地；非空/空/权限样本待验         |
| `read_failed_update`                         | 独立扩展      | 精确更新键模块、错误标识、修订及关联线索   | 新只读助手候选            | 第二批本地；无参数载荷或完整错误正文     |
| `abap_debug_session`                         | 独立扩展      | 已实现，含只读precheck                     | ADT Debugger API          | 预检已验；未通告，真实调试未验           |
| `abap_debug_breakpoint`                      | 独立扩展      | 已实现，仅Z/Y源码断点                      | ADT Debugger API          | Mock通过                                 |
| `abap_debug_status`                          | 独立扩展      | 已实现，会话状态与清理                     | 服务内会话状态            | idle/零断点已验；真实会话清理未验        |
| `abap_debug_stack`                           | 独立扩展      | 已实现，暂停调用栈                         | ADT Debugger API          | Mock通过                                 |
| `abap_debug_variable`                        | 独立扩展      | 已实现，有界只读变量                       | ADT Debugger API          | Mock通过                                 |
| `abap_debug_step`                            | 独立扩展      | 已实现，单步与继续                         | ADT Debugger API          | Mock通过                                 |
| `sap_helper_status`                          | 独立扩展      | 已实现，只读PING与目标校验                 | SAP SOAP/RFC助手          | w200通过                                 |
| `read_function_module_interface`             | 独立扩展      | 已实现，接口、源码与指纹回读               | SAP仓库助手1.3            | w200通过                                 |
| `test_remote_function_module`                | 独立扩展      | 已实现，客户RFC标量/结构/表断言            | SAP SOAP/RFC              | w200通过                                 |
| `invoke_customer_function_module`            | 独立扩展      | 已实现，白名单客户RFC正式调用              | SAP SOAP/RFC              | w200通过                                 |
| `get_customer_function_call_status`          | 独立扩展      | 已实现，持久化调用凭证只读查询             | Node本地文件系统          | 本地通过                                 |
| `get_write_operation_status`                 | 独立扩展      | 已实现，统一写操作凭证只读查询             | Node本地文件系统          | w200通过                                 |
| `list_write_recovery_operations`             | 独立扩展      | 已实现，中断/陈旧操作只读列表              | Node本地文件系统          | 本地通过                                 |
| `release_write_operation_lock`               | 独立扩展      | 已实现，人工确认后仅解除本地锁             | Node本地文件系统          | 本地通过                                 |
| `create_function_module_with_interface`      | 独立扩展      | 已实现，客户远程函数受控创建               | SAP仓库助手1.3            | w200通过                                 |
| `patch_function_module_interface`            | 独立扩展      | 已实现，函数接口有序安全补丁               | SAP仓库助手2.0            | IMPORTING四操作已验证                    |
| `inspect_repository_assignment`              | 独立扩展      | 已实现，包与开放传输只读检查               | SAP仓库助手1.3            | w200通过                                 |
| `read_abap_screen`                           | 独立扩展      | 已实现，原生结构回读                       | SAP仓库助手1.1            | w200通过                                 |
| `upsert_abap_screen`                         | 独立扩展      | 已实现，客户屏幕受控写入                   | SAP仓库助手1.1            | w200通过                                 |
| `patch_abap_screen`                          | 独立扩展      | 已实现，组件增删改及坐标移动               | SAP仓库助手1.4            | w200通过                                 |
| `validate_dynpro_application`                | 独立扩展      | 已实现，屏幕与PBO/PAI静态校验              | 仓库助手及ADT源码读取     | w200通过                                 |
| `read_abap_gui_definition`                   | 独立扩展      | 已实现，完整原生CUA定义回读                | SAP仓库助手1.5            | w200通过                                 |
| `patch_abap_gui_definition`                  | 独立扩展      | 已实现，原生CUA行级增删改                  | SAP仓库助手1.5            | w200 Titlebar通过                        |
| `create_module_pool`                         | 独立扩展      | 已实现，客户模块池创建                     | SAP仓库助手1.1            | w200通过                                 |
| `delete_module_pool`                         | 独立扩展      | 已实现，客户模块池受控删除                 | SAP仓库助手               | w200临时对象删除及不存在回读通过         |
| `read_transaction_code`                      | 独立扩展      | 已实现，事务与GUI属性回读                  | SAP仓库助手1.1            | w200通过                                 |
| `create_transaction_code`                    | 独立扩展      | 已实现，客户对话事务创建                   | SAP仓库助手1.1            | w200通过                                 |
| `delete_transaction_code`                    | 独立扩展      | 已实现，对话/Report事务受控删除            | SAP仓库助手               | 对话及Report临时对象范围已验             |
| `create_report_transaction`                  | 独立扩展      | 已实现，仅新建客户Report事务               | SAP仓库助手1.2            | w200通过                                 |
| `read_abap_message_class`                    | 独立扩展      | 已实现，活动消息类完整回读                 | ADT或仓库助手1.7          | w200助手通过                             |
| `create_abap_message_class`                  | 独立扩展      | 已实现，仅新建客户消息类                   | ADT或仓库助手1.7          | w200助手通过                             |
| `update_abap_message_class`                  | 独立扩展      | 已实现，版本化消息增量更新                 | SAP仓库助手               | w200增量更新及陈旧版本拒绝已验           |
| `delete_abap_message_class`                  | 独立扩展      | 已实现，版本化客户消息类删除               | SAP仓库助手1.9            | 真实SAP已通过                            |
| `read_ddic_domain`                           | 独立扩展      | 已实现，活动域和固定值回读                 | SAP DDIC助手1.2           | w200通过                                 |
| `upsert_ddic_domain`                         | 独立扩展      | 已实现，客户域完整替换                     | SAP DDIC助手1.2           | w200通过                                 |
| `read_ddic_data_element`                     | 独立扩展      | 已实现，活动数据元素回读                   | SAP DDIC助手1.2           | w200通过                                 |
| `upsert_ddic_data_element`                   | 独立扩展      | 已实现，客户数据元素完整替换               | SAP DDIC助手1.2           | w200通过                                 |
| `read_ddic_structure`                        | 独立扩展      | 已实现，活动平面结构回读                   | SAP DDIC助手1.2           | w200通过                                 |
| `upsert_ddic_structure`                      | 独立扩展      | 已实现，客户平面结构完整替换               | SAP DDIC助手1.2           | w200通过                                 |
| `read_ddic_transparent_table`                | 独立扩展      | 已实现，活动透明表完整定义回读             | SAP DDIC助手1.3           | w200通过                                 |
| `create_ddic_transparent_table`              | 独立扩展      | 已实现，仅新建客户透明表                   | SAP DDIC助手1.3           | w200通过                                 |
| `append_ddic_transparent_table_fields`       | 独立扩展      | 候选支持复杂布局并保留Include/Append       | SAP DDIC助手1.7           | 本地测试及真实复杂表待人工验证           |
| `patch_ddic_transparent_table_fields`        | 独立扩展      | 候选仅修改直接字段并保留复杂组件           | SAP DDIC助手1.7           | 本地测试及真实复杂表待人工验证           |
| `patch_ddic_transparent_table_settings`      | 独立扩展      | 受控修改数据类、大小、缓冲和日志设置       | SAP DDIC助手1.7           | 本地测试及真实SAP待人工验证              |
| `read_ddic_table_conversion_status`          | 独立扩展      | 只读TBATG状态及稳定指纹                    | 有界单表读取              | 源码完成；真实非空状态待人工验证         |
| `recover_ddic_table_conversion`              | 独立扩展      | 精确状态门禁后调用SAP标准转换器            | SAP DDIC助手1.7           | 未执行真实转换；不承诺重建丢失值         |
| `read_ddic_table_type`                       | 独立扩展      | 已实现，活动表类型回读                     | SAP DDIC助手1.2           | w200通过                                 |
| `upsert_ddic_table_type`                     | 独立扩展      | 已实现，STANDARD默认键表类型替换           | SAP DDIC助手1.2           | w200通过                                 |
| `delete_ddic_object`                         | 独立扩展      | 已实现，含透明表受控删除                   | SAP DDIC助手1.6           | w200通过                                 |
| `search_abap_objects`                        | 已冻结        | 已实现                                     | `ADTClient.searchObject`  | 真实双跑通过                             |
| `get_abap_object_info`                       | 已冻结        | 已实现，含DDIC和Enhancement                | ADT源码与DD表查询         | 真实双跑通过                             |
| `get_abap_object_lines`                      | 已冻结        | 已实现，含方法提取和DDIC回退               | ADT源码与DD表查询         | 真实双跑通过                             |
| `get_batch_lines`                            | 已冻结        | 已实现                                     | 独立并行读取              | 真实双跑通过                             |
| `get_object_by_uri`                          | 已冻结        | 已实现                                     | 直接读取ADT URI           | 真实调用通过                             |
| `search_abap_object_lines`                   | 已冻结        | 已实现，含正则和增强搜索                   | 服务端源码搜索            | 真实调用通过                             |
| `inspect_source_enhancements`                | 独立扩展      | 活动实现/元素/位置元数据及源码标记         | ADT增强端点及活动源码     | 已补充Mock用例；尚未执行或真实验收       |
| `search_enhancement_objects`                 | 独立扩展      | 五类增强仓库对象独立搜索及状态             | ADT Repository Search     | 已补充Mock用例；尚未执行或真实验收       |
| `search_customer_exit_objects`               | 独立扩展      | SMOD/CMOD独立仓库搜索及状态                | ADT Repository Search     | 已补充Mock用例；尚未执行或真实验收       |
| `read_customer_exit_definition`              | 独立扩展      | 精确SMOD定义、原始类型及组件成员           | SAP助手2.2 MODSAP         | 已补充Mock用例；助手未部署或真实验收     |
| `read_customer_exit_project`                 | 独立扩展      | 精确CMOD项目、原始状态及增强分配           | SAP助手2.2 MODATTR/MODACT | 已补充Mock用例；助手未部署或真实验收     |
| `inspect_customer_function_exits`            | 独立扩展      | 函数出口调用、精确出口函数及ZX include关联 | 活动源码及仓库搜索        | 已补充Mock用例；尚未执行或真实验收       |
| `inspect_customer_screen_menu_exits`         | 独立扩展      | Customer Subscreen钩子及+菜单功能码检查    | 屏幕Flow Logic及GUI定义   | 已补充Mock用例；尚未执行或真实验收       |
| `search_bte_dispatchers`                     | 独立扩展      | Event/Process调度函数搜索及标识符提取      | ADT Repository Search     | 已补充Mock用例；尚未执行或真实验收       |
| `read_bte_configuration`                     | 独立扩展      | 定义、SAP/客户处理分配及原始激活字段       | SAP助手2.3 BTE配置表      | 已补充Mock用例；助手未部署或真实验收     |
| `prepare_enhancement_configuration_workflow` | 独立扩展      | CMOD/FIBF/FI配置只读预检及受控人工步骤     | 现有读工具及静态流程模板  | 已补充Mock用例；尚未执行或真实验收       |
| `search_badi_objects`                        | 独立扩展      | Classic/New精确仓库子类型独立搜索          | ADT Repository Search     | 已补充Mock用例；尚未执行或真实验收       |
| `read_classic_badi_definition`               | 独立扩展      | Classic定义、接口、过滤、实现类及激活原值  | SAP助手2.4 Classic表      | 已补充Mock用例；助手未部署或真实验收     |
| `manage_classic_badi_implementation`         | 独立扩展      | Classic实现创建、激活、停用、删除          | SAP助手2.6 SXO标准API     | 已补充Mock用例；未执行或真实验收         |
| `read_enhancement_implementation`            | 独立扩展      | ENHO四类版本状态、包、实现及逐Hook源码     | SAP助手2.6增强框架API     | 已补充Mock用例；未执行或真实验收         |
| `create_enhancement_hook_implementation`     | 独立扩展      | 显式/隐式Hook实现创建、保存及激活          | SAP助手2.6增强框架API     | 已补充Mock用例；未执行或真实验收         |
| `create_new_badi_implementation`             | 独立扩展      | New BAdI实现、类、过滤器创建及激活         | SAP助手2.6增强框架API     | 已补充Mock用例；未执行或真实验收         |
| `update_enhancement_hook_implementation`     | 独立扩展      | 按extId更新单个Hook源码并激活              | SAP助手2.6增强框架API     | 已补充Mock用例；未执行或真实验收         |
| `update_new_badi_implementation`             | 独立扩展      | 更新New BAdI类、过滤器、默认/活动状态      | SAP助手2.6增强框架API     | 已补充Mock用例；未执行或真实验收         |
| `manage_enhancement_implementation_state`    | 独立扩展      | 激活或丢弃ENHO非活动版本                   | SAP助手2.6增强框架API     | 已补充Mock用例；未执行或真实验收         |
| `delete_enhancement_implementation`          | 独立扩展      | 指纹/包/传输保护的ENHO永久删除             | SAP助手2.6增强框架API     | 已补充Mock用例；未执行或真实验收         |
| `inspect_enhancement_framework`              | 独立扩展      | 显式锚点及源码推导的隐式候选               | 活动源码静态解析          | 已补充Mock用例；尚未执行或真实验收       |
| `inspect_fico_rule_exit_program`             | 独立扩展      | FI出口目录声明与FORM实现关联               | 活动程序源码静态解析      | 已补充Mock用例；尚未执行或真实验收       |
| `get_abap_object_workspace_uri`              | 已冻结        | 已实现                                     | 确定性 `adt://` URI       | 真实调用通过                             |
| `get_abap_object_url`                        | 已冻结        | 已实现                                     | 独立生成WebGUI URL        | 真实调用通过                             |
| `find_where_used`                            | 已冻结        | 已实现，含旧RIS适配与超时诊断              | ADT/RIS引用映射           | 映射超时/RIS故障；真实引用正例未验       |
| `get_sap_system_info`                        | 已冻结        | 固定表后备及来源状态                       | 标准只读RFC，双指纹       | 接口范围已验；时区原生独立对照未验       |
| `get_version_history`                        | 已冻结        | 已实现，含读取和比较版本                   | `ADTClient.revisions`     | w200通过                                 |
| `get_abap_diagnostics`                       | 已冻结        | 已实现，检查活动源码                       | ADT syntax check          | w200通过                                 |
| `get_abap_sql_syntax`                        | 已冻结        | 已实现，无头安全指南                       | 内置静态文档              | Mock通过                                 |
| `execute_data_query`                         | 已冻结        | 已实现，只读/限行/internal                 | ADT及限定后备             | 限定查询有证据；非通用SQL恢复证明        |
| `read_abap_table`                            | 独立扩展      | 有界结构化单表查询                         | ADT/受限标准RFC           | w200五项真实检查通过；仅单表范围         |
| `run_atc_analysis`                           | 兼容扩展      | 批量语法报告及ATC完整性保护                | ADT语法诊断/可选原生ATC   | 语法/边界已验；原生ATC批准延期           |
| `run_sci_analysis`                           | 独立扩展      | 显式目标、隔离helper与E2 profile           | SAP SCI助手               | 三类对象/三规则入口已验；整体部分验证    |
| `run_unit_tests`                             | 已冻结        | 已实现，不自动激活                         | ADT ABAP Unit             | 请求已通；既有样本无测试类，不算断言执行 |
| `discover_application_logs`                  | 独立扩展      | 已实现，有界日志头抽样                     | SAP只读日志助手           | 非空读取有记录；不代表全量发现           |
| `search_application_logs`                    | 独立扩展      | 已实现，精确对象与有界检索                 | SAP只读日志助手           | 已有限定检索证据；不扩展到全权限范围     |
| `read_application_log`                       | 独立扩展      | 已实现，正文、分页与修订检查               | SAP只读日志助手           | 限定正文/分页/修订/英文原生对照已验      |
| `search_background_jobs`                     | 独立扩展      | 已实现，精确作业与有界检索                 | SAP只读运行日志助手       | 已有限定检索证据；非作业管理能力         |
| `read_background_job_log`                    | 独立扩展      | 已实现，八槽正文与修订分页                 | SAP只读运行日志助手       | 两作业正文/分页/修订/原生对照已验        |
| `read_system_logs`                           | 独立扩展      | 已实现，本机有界尾部读取                   | SAP只读运行日志助手       | 英文正文/程序过滤已验；非全实例全历史    |
| `correlate_sap_logs`                         | 独立扩展      | 已实现，固定来源及候选关联                 | 复用只读日志工具          | 覆盖/质量标志已验；不证明因果            |
| `analyze_abap_dumps`                         | 已冻结        | 已实现，只读现有Dump                       | ADT feeds/dumps           | w200通过                                 |
| `diagnose_sap_failure`                       | 独立扩展      | ST22结构化诊断、过滤和时间候选关联         | ADT feed + 本地解析       | 0.36.8专用工具真实非空读取已验           |
| `analyze_abap_traces`                        | 已冻结        | 已实现，只读现有Trace                      | ADT trace APIs            | w200返回404                              |
| `manage_transport_requests`                  | 已冻结        | 已实现，四个只读查询动作                   | ADT或仓库助手1.7          | w200助手通过                             |
| `cleanup_transport_entries`                  | 独立扩展      | 已实现，开放任务精确条目清理与写后回读     | 原生ADT removeobject      | 本地静态待检；w200未验证                 |
| `abap_download`                              | 已冻结        | 已实现，对象和包本地导出                   | Node文件系统 + ADT读取    | w200包内通过                             |
| `adt_discovery_export`                       | 已冻结        | 已实现，四文件Markdown导出                 | Node文件系统 + ADT发现    | w200包内通过                             |
| `replace_string_in_abap_object`              | 已冻结        | 已实现，客户源码矩阵和完整锁流程           | ADT lock/source/activate  | w200类写通过                             |
| `abap_activate`                              | 已冻结        | 已实现，仅限显式Z/Y对象URI                 | ADT activation            | w200链路通过                             |
| `create_object_programmatically`             | 已冻结        | 已实现，客户源码创建和传输保护             | ADT或仓库助手1.7          | Include助手通过                          |
| `delete_abap_source_object`                  | 独立扩展      | 已实现，客户源码对象受控删除               | ADT原生锁和删除           | w200通过                                 |
| `create_test_include`                        | 已冻结        | 已实现，客户类测试Include创建              | ADT class include API     | w200通过                                 |
| `manage_text_elements`                       | 已冻结        | 三类对象ADT优先、助手后备                  | ADT或仓库助手1.7          | w200助手通过                             |

工具名称和输入契约按原服务基线冻结；仅将依赖编辑器上下文的工具说明调整为独立服务语义。

## 当前证据边界

- 0.36.31扩展RFC字段约束及源码锁内指纹；新增回归和人工入口未执行。0.36.29完整行查询失败不被旧单表检查或新静态检查覆盖，真实550值问题保持未关闭。
- M5：15项真实回归、7组同语言原生对照、2组原生程序过滤已通过；特殊样本延期、受限身份移出本轮门禁。主功能已交付，整体证据仍Partially Verified，见[日志套件](diagnostic-suite.md)。
- M6：2026-09-09系统信息和单表查询已通过限定真实验收；2026-09-10 SCI-E2.1专用入口已验。原生ATC延期，质量门禁保持not_evaluated。引用正例和真实调试未通过，见工作区[M6状态](../../.doc/m6-current-status.md)。
- 函数接口仅IMPORTING四操作完整真实验收；Report事务删除与消息类增量更新已有0.32.0真实生命周期记录，不再标记待验收。工具注册、技术用例与业务事务覆盖不得相互替代。

## 历史验证记录

以下保留各版本实施时点的证据。“当前”“候选”“待验收”等措辞仅指相应历史时点，不是实时报告；存在后续记录时按上方当前证据及全局基线解释，不删除旧失败。

- 2026-09-08正文修复时运行0.36.13 / 84工具，两只日志助手已部署；223项本地测试和15项真实检查通过。当时独立显示、低权限及长中文仍缺，后续原生对照、程序过滤和门禁调整见上方当前状态。此前九项失败证据保留。

- MCP Streamable HTTP初始化、工具枚举和工具调用。
- 0.36.11时80个工具已注册；原版工具契约继续按冻结基线回归，独立扩展工具按协议和Mock回归验证。当时新增 `discover_application_logs` 有界只读头引用抽样，真实发现链路待验收，不等同完整SLG1支持。
- 0.36.9 的 `search_application_logs` / `read_application_log` 仅完成本地接入及批准门禁，SAP助手未部署；未批准返回unavailable，不代表日志为空。消息详情需独立无副作用审查。见 [SLG1 部署门禁](application-logs.md)。
- 0.36.7 新增 `diagnose_sap_failure`：本地189项回归通过；w200两条历史转储经0.36.6旧工具读取、新解析器处理成功，各8层调用栈、1个重复错误分组。新版本专用工具尚未部署验收；SLG1、SM21、SM37尚未交付。详见 [M5 运行诊断](runtime-diagnostics.md)。
- 0.36.6 新增 `run_sci_analysis`：独立 SCI 助手路径，限定 `ZCODEX_MCP_CORE` 的语法与危险语句两项检查。SAP SOAP 已返回 28 条结果；不是原生 ATC，也不证明完整 DEFAULT 或日常业务对象覆盖。部署和边界见 [SCI 兼容说明](sci-compatibility.md)。
- 0.36.26 候选新增 SCI-E1：显式 `target` 路由到独立 V2 helper，支持单个客户 PROG/CLAS/FUGR 主对象，仍仅两项规则。W200 三类真实 RFC 运行已返回，旧 V1 不变；在线 0.36.24 未切换，不能将候选包等同于客户端验收。
- 0.36.27 候选新增 SCI-E2.1：显式 `profile=syntax_critical_sql` 加 `target` 选择隔离的 E2 helper，在原两项规则上仅增加循环 SELECT。W200 真实 RFC 返回30条，其中2条循环查询警告已核对源码；类/程序为0条。当前在线0.36.26的E1入口已验收，E2新profile仍待候选切换后验收，不包含FAE。
- 原版52个语言模型工具和2个MCP专属工具已冻结到 `contracts/full-tool-baseline.json`，并完成SAP核心、编辑器专属、本地工具及影响类型分类。
- Mock SAP后端下普通类、程序和DDIC表的搜索、信息、分段读取、方法提取、Enhancement元数据和批量读取行为。
- 源码和构建产物不存在 `vscode`、`Code.exe`、Extension Host或子进程调用。
- 独立服务直接依赖 `abap-adt-api 8.4.3`，没有 VS Code运行时依赖。
- 诊断波次的Mock覆盖语法检查、只读查询安全边界、ATC、ABAP Unit、Dump和Trace格式化。
- 传输波次的Mock覆盖用户传输、明细、对象清单、对比和非法传输号拒绝；实现只调用读取接口，不创建或更新ADT传输视图配置。
- 导出波次的Mock覆盖绝对目标路径、默认拒绝覆盖、源码文件写入、ADT发现四文件输出和无编辑器状态运行。
- 最终0.6.0便携包在真实 `w200`下载 `ZCL_CA_HZ`成功，生成1个非空源码文件（141320字节）；同一运行实例在便携目录 `exports`下生成4个ADT发现Markdown文件。
- 写入波次的Mock覆盖专用有状态ADT会话、精确唯一替换、已有非活动版本保护、锁定、保存失败后的解锁、传输冲突、激活结果和Z/Y对象限制。
- 0.7.0写入策略覆盖类、类Include、接口、程序、Include、函数组、函数模块、函数组Include、DDL和DCL源码；标准对象、标准父对象、无法证明客户归属的技术Include和结构化DDIC URI在SAP加锁前拒绝。
- 0.8.0创建策略覆盖 `CLAS/OC`、`INTF/OI`、`PROG/P`、`PROG/I`、`FUGR/F`、`FUGR/FF`、`FUGR/I`、`DDLS/DF`和 `DCLS/DL`；创建前执行系统类型发现和SAP名称验证，创建后重新解析对象路径并激活。
- 旧ECC创建兼容层仅在SAP明确拒绝通用内容类型时重试对象专用ADT媒体类型；函数组按v3、v2、v1和无版本媒体类型降级，且只对已确认的内容处理器或`ExceptionInvalidData`转换错误继续重试。函数组Include优先尝试v2媒体类型，并仅对404/501端点缺失继续降级。SAP未及时建立仓库索引时不再把成功创建误报为失败。名称验证端点返回空结果、404或501时，仍保留本地客户命名、系统类型、包和传输约束，并由创建端点最终校验。
- 创建策略拒绝标准对象、标准函数组父对象、自动新建传输、`$TMP`携带传输号和正式包缺少现有传输号；类测试Include在加锁前和锁内各检查一次是否已存在，并在创建后重新读取类结构。
- 0.9.0文本元素策略支持程序、类和函数组；读取不限定客户命名，创建和更新仅允许 `Z*`/`Y*`，保留未改动文本，并协调锁定、保存、解锁、激活和回读验证。标准对象在SAP加锁前拒绝。
- 0.10.0通过真实 `w200` SOAP/RFC通道调用SAP侧客户助手；助手 `1.0`只开放 `PING`和 `VALIDATE_TARGET`，并在SAP侧执行Z/Y命名、对象类型白名单和`S_DEVELOP`显示权限检查。
- 0.11.0增加仓库助手 `1.1`和5个经典Dynpro工具。真实 `w200`已创建并激活模块池 `ZCODEX_MCP_DYNPRO`、屏幕 `0100`和事务 `ZCODEX_MCP_UI`；MCP回读得到5个屏幕字段、4行流逻辑，事务正确指向该模块池和屏幕。
- 0.12.0增加DDIC助手 `1.2`和8个工具，覆盖域、基于域的数据元素、平面结构和STANDARD/default-key表类型。真实 `w200`已创建并激活 `ZCODEX_MCP_DOM_0831`、`ZCODEX_MCP_DE_0831`、`ZCODEX_MCP_STR_0831`和`ZCODEX_MCP_TT_0831`，均回读为包 `ZABAP`并由SAP返回传输记录 `GR2K923421`。最新版便携包还验证了标准对象写入、缺失传输、重复结构字段和陈旧版本令牌均被拒绝。
- 0.13.0将DDIC助手升级至 `1.3`并新增2个透明表工具。读取返回键、非空标记、交付类、Data Class、数据浏览维护标记、大小类别和缓冲设置；创建仅允许最多16字符的全新 `Z*`/`Y*`对象，要求键字段连续位于开头、全部字段非空、Data Class为 `APPL0/APPL1/APPL2`并固定为不缓冲，现有透明表拒绝替换以避免数据转换或丢失。真实 `w200`已在包 `ZABAP`、请求 `GR2K923421`中创建并激活 `ZCMCP_TAB_0831`，回读版本 `20260831132653`；重复创建、标准对象、超长名称和错误键顺序均被拒绝。
- 0.14.0将仓库助手升级至 `1.2`并新增3个工具。真实 `w200` 已创建并回读Report事务 `ZCMCP_R14`，正确指向 `ZCMCP_RPT_0831`，包为 `ZABAP`、请求为 `GR2K923421`；活动Report包含选择屏幕校验和列表输出，源码回读与语法诊断通过。程序文本符号 `R14` 已通过ECC文本池助手创建、回读，并验证重复创建会被拒绝。非法Variant、标准事务码、标准程序和重复事务均在写入前或SAP助手内被拒绝。
- 0.15.0将仓库助手升级至 `1.3`并新增3个函数模块接口工具。旧ECC函数组ADT创建端点返回405或501时，服务使用 `RS_FUNCTION_POOL_INSERT`后备创建；函数接口创建使用ECC兼容的 `RPY_FUNCTIONMODULE_INSERT`参数和 `RSEXC`/`RSFDO`异常说明结构。真实 `w200`已创建并激活 `ZCMCP_FG_1501`和远程函数 `ZCMCP_FM_1501`，回读确认包 `ZABAP`、请求 `GR2K923421`、任务 `GR2K923422`、导入/导出参数、异常说明和源码。有效SOAP调用返回 `MCP:VALIDATION`，空输入调用返回包含 `INVALID_INPUT`的SOAP Fault；标准函数、标准父函数组、缺失传输、重复参数、非法类型和重复创建均被拒绝。
- 0.16.0新增6个无头ABAP用户调试工具，Mock覆盖会话、Z/Y断点、调用栈、只读变量、单步、继续和清理；MCP协议回归覆盖公开契约。真实 `w200`在会话启动阶段对 `GET /sap/bc/adt/debugger/listeners`返回HTTP 404，SOAP未触发、断点未设置、没有SAP源码或传输变更。
- 0.17.0新增客户RFC标量功能验证工具。Mock和本地SOAP端点覆盖活动接口门控、Z/Y限制、远程启用检查、输入输出白名单、精确输出断言、声明异常断言、HTTP 500 SOAP Fault解析、显式副作用确认和有界值。真实 `w200`通过MCP调用 `ZCMCP_FM_1501`完成正反例验证：有效输入精确返回 `MCP:VALIDATION`，空输入返回声明异常 `INVALID_INPUT`，接口指纹为 `3eeec94781429bfe103c7297540e758511e24bd2de7231c0b2d35fa1632ff4a2`。
- 0.18.0将客户RFC验证扩展到平面DDIC结构和TABLES参数，并为接口读取增加可选执行能力分析。工具通过DDIC解析字段白名单，拒绝深层字段、非TABLES位置的表类型、未知参数/字段、接口指纹漂移、Update Task和标准函数；限制200行、每结构100字段、单值4096字符、请求1 MiB和响应10 MiB。真实 `w200`通过MCP调用 `ZCMCP_FM_1801`完成 `BAPIRET2`结构导入/导出和两行TABLES正例、空消息声明异常反例、接口回读、活动源码诊断及仓库分配检查；接口指纹为 `ce80d194fab72df21ea3d49502afebb6b33416674c7bb03a13e92a5d2e4c4951`。
- 0.19.0新增白名单客户RFC正式调用，并支持IMPORTING、EXPORTING和CHANGING位置的平面DDIC表类型。每次调用要求准确白名单、活动接口指纹、请求ID和显式副作用确认；返回实际有界结果、声明异常和输入/输出摘要哈希，不自动重试网络或HTTP故障。真实 `w200`创建并调用 `ZCMCP_FM_1901`，确认 `BAPIRET2_T`两行导入/导出、空表 `INVALID_INPUT`、白名单拒绝、指纹拒绝、未知字段拒绝、201行拒绝、活动源码无诊断，接口指纹为 `e0648e2f04259f9a0c16b095a84117ae32db8a6f9f82951fa5a11e7e2663556d`。
- 0.20.0为正式客户RFC调用增加持久化一次性请求凭证，并新增只读状态查询。文件系统独占创建保证同一连接和请求ID的并发调用只有一次进入目标RFC；相同调用返回 `duplicate_blocked`，不同函数、接口或输入返回 `request_id_conflict`。完成、声明异常、网络/超时不确定结果和重启遗留调用分别报告 `completed`、`declared_fault`和 `outcome_unknown`。凭证只保存元数据与SHA-256摘要，不保存原始输入、输出或密码。
- 0.21.0新增屏幕SHA-256指纹、Flow Logic模块引用、组件新增/更新/删除、坐标移动和Dynpro应用静态验证。坐标移动使用 `update`修改 `LINE`和 `COLUMN`；不提供无法由原生D021S回读证明的表内排序操作。真实 `w200`已安装仓库助手1.4，在 `ZCODEX_MCP_DYNPRO`屏幕 `0100`新增、修改坐标并删除临时组件 `BTN_PATCH_021`；陈旧指纹被拒绝，PBO/PAI定义验证为 `valid`，清理后恢复原5个组件和原语义定义。
- 0.22.0新增完整Menu Painter读取和行级补丁工具，覆盖 `RSMPE_STAT/FUNT/MEN/MNLT/ACT/BUT/PFK/STAF/ATRT/TITT/BUTS`及 `RSMPE_ADM`。客户端先用SHA-256指纹拒绝陈旧编辑，再将合并后的完整定义交给SAP助手1.5；SAP端重新读取活动定义并比较14位修改时间令牌，使用原生`SCUA`对象类别记录`CUAD`传输子对象、调用 `RS_CUA_INTERNAL_WRITE`写入活动定义并回读。真实 `w200`已部署助手1.5，并在 `ZCODEX_MCP_DYNPRO`中完成临时Titlebar `TITLE_MCP_022`新增、更新、陈旧指纹拒绝、删除及语义清理；最终指纹恢复基线，程序保持在`ZABAP`和开放请求`GR2K923421`，Dynpro验证为`valid`。
- 0.23.0新增便携包内PowerShell 7助手安装器，提供 `status`、`preflight`、`install`、`upgrade`、`repair`五种模式；配置解析、明文密码拒绝、连接选择、TCP可达性、单次安全密码传递、三个助手API状态、函数组生成状态和各模式动作映射已通过受控本地后端回归。便携包包含安装器及唯一的SOAP/ABAP生成实现，不依赖VS Code或系统Node.js。
- 0.24.0新增便携包首次接入入口 `setup.ps1`，组合0.23.0只读预检、Codex注册和服务启动。受控回归验证了单次 `SecureString`复用、临时密码环境变量清理、`SkipCodex`分支和预检失败后禁止注册/启动；现有 `start.ps1`增加内部 `PassThru`返回模式，直接启动行为保持兼容。
- 0.25.0完成完整经典屏幕闭环。真实 `w200`临时创建 `ZCMCP_DYN_0250`、屏幕 `0100`、`STATUS_025`、`TITLE_025`和事务 `ZCMCP_0250`，精确回读5个功能码、菜单、4个工具栏按钮、5个PF键、状态映射、10个屏幕组件及PBO/PAI定义。功能文本使用ECC原生 `TEXT_TYPE=S`，`BACK/EXIT/CANC`使用Exit类型和 `AT EXIT-COMMAND`。用户在SAP GUI实际验证屏幕按钮、菜单、工具栏、F键和三种退出路径；随后事务和模块池均由SAP助手删除并验证不存在。对象位于 `ZABAP`和开放请求 `GR2K923421`，未释放传输、未修改标准对象。
- 0.26.0新增ECC仓库助手1.7后备：消息类读取/新建、CLASS/FUNCTION_GROUP文本符号读取/合并、函数组技术Include新建及传输明细读取。协议、Mock、生成器和安全门控已覆盖；真实 `w200`已验证 `ZCMCP_MSG_0260`、`ZCL_CMCP_0260`、`ZCMCP_FG_0260`、`LZCMCP_FG_0260F01`及请求 `GR2K923421`。写入仍限 `Z*`/`Y*`、正式包和已有传输，传输操作保持只读且没有释放入口。
- 0.27.0为22个SAP写入或潜在副作用工具增加统一操作ID、持久化SHA-256凭证、目标级跨进程独占锁、重复ID/输入冲突拒绝、前置条件摘要、完成/失败/中断状态和人工恢复指引；新增 `get_write_operation_status`。本地协议与故障回归覆盖完成、失败、重复、同目标并发、服务重启中断和陈旧锁失败关闭。凭证不保存原始源码或业务载荷。该层不自动重试，不自动删除陈旧锁，也不承诺任意业务RFC回滚。
- 0.27.1完成真实SAP安全验收。真实 `w200/200`在包 `ZABAP`、请求 `GR2K923421`中临时创建并回读活动模块池 `ZCMCP_SAFE_0271`，验证同ID重复返回 `duplicate_blocked`、同ID变更输入返回 `operation_id_conflict`、已存在对象失败凭证为 `failed`、隔离状态目录播种的未完成凭证恢复为 `interrupted`、残留目标锁返回 `target_concurrency_conflict`，并确认 `automaticRetry=false`和 `automaticRollback=false`。删除返回 `completed`后，独立ABAP FS搜索、对象信息和源码读取均确认对象不存在；未释放传输，未修改SAP标准对象。
- 0.28.0在写动作前持久化只读SAP观察证据，包含目标存在性、活动状态、版本或指纹、包、请求、任务及观察时间；无法确认存在性时不调用写动作。恢复中心可只读列出中断/陈旧操作，并在最新凭证哈希、精确人工确认和原因齐全时仅解除本地目标锁。Mock和MCP协议覆盖证据、旧凭证兼容、列表边界、活动操作拒绝、哈希冲突和人工解除；不清除SAP锁、不自动重试、不自动回滚RFC。
- 0.30.0新增消息类版本化增量更新、七类源码对象ADT受控删除，以及域、数据元素、结构和表类型的依赖检查后删除。Mock、SOAP生成器和MCP协议覆盖版本冲突、增删改保留语义、禁止清空、重复操作、包/父对象/确认门控、依赖拒绝、写后不存在验证和版本2操作凭证。真实 `w200/200`已完成七类源码对象和四类DDIC对象的创建、证据回读、冲突或依赖拒绝、逆序删除和最终不存在验证；消息类增量更新因缺少可靠的公开清理路径，未执行真实写入。
- 0.30.1统一源码生命周期操作的本地目标锁身份，函数组子对象按父函数组互斥；源码删除要求调用方SHA-256指纹并在SAP锁内重新读取比较，冲突时解锁且不调用删除接口。本地锁身份和锁内指纹回归已覆盖；真实 `w200`陈旧指纹拒绝和七类源码删除已通过。
- 0.30.2修复便携安装器产品版本硬编码，并在源码读取结果中公开完整活动源码SHA-256；锁内删除比较显式读取活动版本。真实 `w200`已重新创建仓库和DDIC助手并通过生成/活动预检，源码与DDIC生命周期验收通过且临时对象已清理。
- 0.31.0新增动态能力中心，使用ADT发现、仓库搜索、单行只读查询、传输列表、Dump/Trace列表和三个助手读取入口生成连接级报告。报告区分本地实现、原生ADT、SAP助手后备、不支持和未知，不以工具注册或Discovery声明替代真实探测，也不为需要准确对象或执行目标的能力发起写入或副作用调用。助手版本是当前读取操作返回的协议版本；高于该版本的能力保持未知，不能据此判定助手整体版本过低。真实 `w200/200` 只读验收覆盖全部71个注册工具，结果为12项能力可用、1项不支持、12项未知；ADT Discovery返回21个工作区和39个集合，验证过程中未调用SAP写入或锁清理。
- 0.32.0新增消息类受控删除、事务包与确定性指纹回读，并把事务删除扩展到Report事务。函数接口生命周期由现有显式创建、完整回读和函数模块受控删除组成；真实 `w200/200`已升级仓库助手1.9，并通过接口参数/异常/源码与执行形状回读、Report事务陈旧指纹拒绝及删除、消息类增量更新/陈旧版本拒绝/删除，以及全部五个临时对象逆序清理。助手活动源码回读和ABAP诊断也已通过。
- 0.33.0新增透明表安全字段追加。仅允许在不含Include或Append结构的现有 `Z*`/`Y*`透明表末尾追加可为空、非键、引用活动数据元素的新字段，同时要求当前14位版本、定义指纹、准确包、已有请求和唯一操作ID；服务与DDIC助手1.5双层拒绝已有字段、`MANDT`、键/非空字段、复杂表布局和陈旧定义，写后完整回读。真实 `w200/200` 已在 `ZCMCP_TAB_0330`追加 `APPEND_MSG`；恢复核验确认版本由 `20260904094047`变为 `20260904094927`、字段位于末尾且为可空非键、原字段和表设置未变、陈旧版本/指纹被拒绝。原进程完成凭证不可用；测试表已由用户在SE11删除，并通过只读回读确认不存在。
- 0.34.0新增透明表字段补丁和删除。字段补丁通过DDIC助手1.6接收完整最终字段定义，支持字段删除、重命名以及数据元素/键/非空属性修改，同时要求版本、指纹、包、请求、破坏性确认和数据丢失确认；服务与助手均禁止修改`MANDT`、复杂Include/Append布局、重复字段、无变化补丁、非连续键和可空键，并完整保留技术设置。`delete_ddic_object`新增`TABL`并要求额外数据丢失确认。真实`w200/200`已升级DDIC助手1.6，并在`ZABAP`、`GR2K923421`下完成`ZCMCP_TAB_0340`新建、追加、字段删除、重命名、数据元素/键/非空属性修改、陈旧定义拒绝、写后回读及最终删除；全部四项写凭证完成，临时表最终不存在，未写业务数据且未释放传输。
- 0.35.0新增函数接口有序补丁。`patch_function_module_interface`支持IMPORTING、EXPORTING、CHANGING、TABLES参数和经典异常的新增、重命名、属性修改与删除，要求当前接口及实现源码指纹、正式包、已有请求、唯一操作ID和破坏性变更确认。结构变更使用ADT原生锁定、保存和激活链路，仓库助手2.0在函数锁内确认结构后维护参数说明并完整回读；不自动修改实现源码、清除SAP锁、重试、回滚接口或释放传输。2026-09-07 M1已在真实 `w200/200`验证IMPORTING参数四操作、说明维护、实现不变和陈旧指纹保护，临时函数与函数组最终删除；其他参数类别及经典异常的补丁仍只有本地回归证据。
- 0.35.0 M2已验证源码维护、激活、诊断、CHAR20输入正常/20字符边界/超长拒绝及 `INVALID_INPUT`声明异常。M3正式白名单调用 `m3-live`返回 `M3-LIVE`，重复操作和请求冲突被拒绝，超长输入凭证明确未开始业务调用；最终临时对象清理完成。114项本地测试通过；真实Node进程退出、HTTP连接丢失和12路并发使用MockBackend，不代表真实SAP业务事务中断或并发验收。
- M3为新凭证及本地锁增加 `ownerPid`和独占 `.recovery`保护。持有进程存活/身份不确定时禁止解锁，旧凭证无进程信息时要求离线恢复；升级须停止共享状态目录的旧服务并保留凭证，不允许靠清空状态绕过去重。详见接入说明。
- 包和传输检查确认模块池与事务均属于 `ZABAP`，请求 `GR2K923421`及用户任务 `GR2K923422`保持可修改；请求中包含 `R3TR PROG ZCODEX_MCP_DYNPRO`和 `R3TR TRAN ZCODEX_MCP_UI`。屏幕 `0100`没有独立的 `LIMU DYNP`记录，由已入请求的主程序对象覆盖。
- WebGUI已实际打开 `ZCODEX_MCP_UI`，确认初始文本显示、输入字段可编辑、`Clear`清空内容且`Exit`返回Easy Access；SAP页面来源没有控制台错误。浏览器扩展自身的报错与SAP页面无关。
- 真实 `w200`已在 `$TMP`创建并激活 `ZCODEX_MCP_CLS_0828`、`ZCODEX_MCP_IF_0828`、`ZCODEX_MCP_PRG_0828`和 `ZCODEX_MCP_I_0828`；源码回读和语法诊断通过。`ZCODEX_MCP_CLS_0828`测试Include创建、回读、激活和诊断通过。
- 真实 `w200`已创建并激活函数组 `ZCODEX_MCP_FG_0828`和函数模块 `ZCODEX_MCP_FM_0828`。函数组创建在v3媒体类型返回`ExceptionInvalidData`后以v2成功；两者源码均已回读，活动源码无语法错误或警告。
- 真实 `w200`只读解析并读取 `ZCL_CA_HZ`、`Z001`、`Z009_I01`、`ZCA_FM_005_HZ_CX`和`ZIF_CCJF`成功，覆盖类、程序、Include、函数模块和接口的实际ADT URI。
- `w200`批准对象 `ZCODEX_FS_SYNC_0807`连续两次完成无写入锁定/解锁，证明每次会话均能自动清理。
- 同一对象完成临时精确替换、保存、解锁、激活、无诊断、反向恢复和再次激活；最终活动源码与测试前SHA-256均为 `FDF04E1221CF686339325271B287C1424241CF7DA9D4E49C420C140693AA540D`。
- Codex CLI通过独立端点 `http://127.0.0.1:4847/mcp`实际调用 `get_object_by_uri`并读取最终恢复后的 `w200`源码。
- 0.4.1将 `X-Requested-With: XMLHttpRequest`应用到全部ADT客户端后，`ZCL_TESTEE`的ABAP Unit请求由403恢复为正常结果；对象当前没有测试类，服务返回 `NO TESTS FOUND`且未执行激活。
- 旧ECC类元数据按显式ADT内容类型重试后，`ZCL_CA_HZ`版本列表返回2个版本，版本1源码读取4666行，版本1与版本2比较成功。
- `analyze_anst_enhancements`只处理本地XLSX，已重分类为本地工具并排除，避免引入Excel运行时依赖。

## 支持限制与历史未验收项

以下按版本保留限制；已由后续证据关闭的条目在上方当前表中注明，不重新列为全局待办。未注明关闭的边界仍保留，不能据一个成功样本推广为完整覆盖。

0.36.0新增的是独立本地配置中心，不增加MCP工具或SAP写入能力。页面配置保存、内存凭据、ADT/基础助手只读测试及服务启停分别验收；浏览器测试中的Mock SAP成功状态不能当作真实系统登录证明。旧无头脚本入口继续保留，配置中心不会接管其他服务进程。

- 0.3.0新增七个诊断工具与原服务的双跑。
- 0.16.0无头调试的真实暂停、栈、变量、单步、继续和SOAP结果尚未验证。`w200` ADT Discovery显示Debugger workspace但没有collection，且 `/sap/bc/adt/debugger/listeners`返回HTTP 404；需SAP管理员先核实该ECC版本是否提供及是否启用 `/sap/bc/adt/debugger` 服务，不能将管理员权限视为端点存在的证明。
- 0.19.0客户RFC调用支持标量、平面DDIC结构、经典TABLES以及平面行类型的DDIC表类型；仍不支持深层结构、嵌套表、对象引用或任意复杂XML映射。客户命名空间和白名单都不代表只读；每次真实调用仍需针对函数名和输入取得授权。通用MCP层不能为任意业务RFC保证回滚、幂等或Dry Run。
- 0.20.0的持久化凭证只阻止Agent层重复提交，不会把任意SAP函数改造成业务幂等接口。`outcome_unknown`不证明SAP已提交或未提交；服务不提供凭证删除、自动重试或自动业务核对工具。
- 0.27.1真实 `w200`验收证明了模块池创建/删除路径及操作凭证状态，不等同于22个写工具逐项真实回归。`preChangeSummary`记录调用时声明的目标、指纹/版本/精确源码匹配等并发前置条件及传输号，不是完整SAP对象快照。文件锁只协调共享同一 `ABAP_MCP_STATE_DIR`的独立服务实例，不能替代SAP原生锁或消除读取与写入之间的全部竞争窗口；`interrupted`场景由隔离目录播种未完成凭证，不是实际进程在SAP写入中被强制终止。
- 0.21.0屏幕指纹检查发生在独立服务读取屏幕后、调用SAP补丁助手前，当前不是SAP端原子比较；并发修改仍存在读取与写入之间的竞争窗口。真实写入前必须确保目标屏幕没有其他编辑者，并在写入后立即回读核对。
- 0.22.0 GUI补丁增加SAP端14位版本令牌检查和写后精确回读，但旧ECC时间粒度为秒，同一秒内的并发编辑仍不能视为强事务锁。工具公开原生CUA行，不提供高层可视化菜单设计器；调用者必须维护状态、功能、菜单、工具栏和PF键之间的有效关系。0.25.0已验证一套完整组合的SAP GUI运行时行为，但不代表所有SAP标准图标、动态文本、复杂控件和多语言组合均已覆盖。
- 0.23.0安装器的本地和便携包受控预检已验证；真实 `w200`也已从0.23.0便携包完成 `status`和 `preflight`，三个助手均存在且已生成，函数组生成检查通过，整体 `ready=true`。旧ECC中基础助手和DDIC助手的 `ENLFDIR-ACTIVE`为空，但 `GENERATED=X`且此前已有真实调用证据，因此不作为失败条件。后续0.30.2已真实执行 `upgrade`并通过助手生成/活动预检；`install`和`repair`模式仍未真实执行。安装器不能在空白SAP系统中创建前置函数组、基础类或客户引导RFC，正式系统仍应优先使用经过审查的SAP传输。
- 0.24.0一键接入的受控脚本回归和便携包文件/启动回归已覆盖；真实用户环境也已在PowerShell 7可见窗口执行完整 `setup.ps1`：真实 `w200`预检整体 `ready=true`，已有Codex注册被识别为相同地址并保持不变，服务随后监听 `127.0.0.1:4847`，健康检查正常，MCP探针枚举62个工具并返回 `Connected SAP systems: w200`。验收结束后关闭该临时服务进程，用户后续可用同一入口重新启动。
- `get_abap_object_workspace_uri` 返回独立服务可消费的确定性ADT URI，不再承诺VS Code虚拟文件树路径。
- `w200` where-used早期从403变为404；后续已实现旧RIS适配，现有真实失败位于映射超时并伴随RIS共享内存故障，不能继续只归因于端点缺失。不使用不完整源码扫描伪造语义引用结果。
- `w200` 早期自由查询存在空/无效响应；系统信息和有界单表查询后来通过受限RFC后备取得真实结果。该验收不证明原生自由查询端点恢复，原生时区界面独立对照仍缺。
- 独立 `abap_activate`工具未单独对带有预先存在非活动版本的对象执行；已验证的是精确替换内部复用的同一激活后端链路。
- 旧版已授权的函数组技术Include `LZCODEX_MCP_FG_0828F01`没有创建；ADT通用请求返回404，v2媒体类型端点返回501。0.26.0已改用仓库助手后备，并在准确批准对象 `LZCMCP_FG_0260F01`上完成真实创建和源码回读。
- `w200`不公开 `DDLS/DF`和 `DCLS/DL`创建类型，`ZCODEX_MCP_DDL_0828`与 `ZCODEX_MCP_DCL_0828`在写入前被拒绝并确认不存在；ECC 7.31不具备本阶段所需CDS创建能力。
- 0.30.0源码和DDIC删除已在真实 `w200`批准的临时对象范围内通过；0.34.0另补充透明表受控删除，但未验收含业务数据的迁移/删除。DDL、DCL及其他未列类型仍无删除入口；任何后续写入仍必须先批准准确对象、父对象、包、请求和清理范围。
- PROGRAM文本符号继续使用已验证的仓库助手路径。0.26.0将CLASS和FUNCTION_GROUP文本符号扩展为ADT优先、仓库助手1.7后备；真实 `w200`已对 `ZCL_CMCP_0260`和 `ZCMCP_FG_0260`的文本符号 `026`完成写入和回读。
- 基础助手 `1.0`仍不写入；仓库助手 `1.5`在1.4基础上增加原生CUA读取和受控写入，不代表所有结构化仓库对象均可写。1.5已安装到真实 `w200`，活动函数源码无诊断并通过Titlebar真实写入回归。
- 真实 `w200` 文本元素ADT锁端点返回HTTP 200但不返回锁句柄，文本元素URI激活返回 `No URI-Mapping defined`。0.26.0将该明确能力缺失分类为可进入ECC文本池助手后备；权限、网络和其他保存失败不会触发后备。
- 0.13.0透明表能力仅支持读取和新建，0.33.0增加受限追加，0.34.0再增加字段删除、重命名、数据元素/键/空值属性修改和透明表删除。技术设置修改、Include/Append复杂布局、自动数据库转换恢复、自动重试和SAP锁清理仍不支持。真实 `w200`已部署并验证DDIC助手1.6；破坏性路径仅在空临时表`ZCMCP_TAB_0340`验证，不代表带业务数据表的数据库转换安全。
- `w200` 的ADT Discovery未公开消息类端点；0.26.0通过T100A/T100只读及受控新建助手后备完成 `ZCMCP_MSG_0260`真实创建和回读。0.32.0仓库助手1.9增加仅限客户消息类、带版本/包/请求校验和写后不存在确认的删除路径；该路径包含直接删除匹配的 `T100`、`T100A`和 `TADIR`记录，已在真实ECC 7.31通过新建、增量更新、陈旧版本拒绝、删除和最终不存在验收，但仍不扩展到SAP标准消息类或未批准对象。
- `manage_transport_requests`在真实 `w200`查询当前用户 `WYS`成功。0.26.0对旧ECC不完整的ADT明细增加E070/E07T/E071只读助手后备，真实回读确认 `GR2K923421`、任务 `GR2K923422`及20条主请求/任务对象记录；不会释放传输。
- `cleanup_transport_entries`使用SAP原生ADT Transport Organizer的 `removeobject` 动作，不直接写 `E071/E071K`。当前ECC 7.31尚未验证该ADT写端点；已部署的旧仓库助手若未返回 `E071-AS4POS`，工具会以 `CTS_CLEANUP_POSITION_UNAVAILABLE`拒绝执行。助手升级、真实任务清理及业务验证均需另行授权。
- `adt_discovery_export`在真实 `w200`返回21个workspace和39个collection，但该旧ECC本次未返回template link、core discovery entry或RES_APP class；导出链路和四文件落盘已验证，空项不代表这些发现能力在该系统可用。
