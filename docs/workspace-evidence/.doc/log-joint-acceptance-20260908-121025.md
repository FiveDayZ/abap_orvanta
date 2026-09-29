# ORVANTA 0.36.12 日志联合验收

## 结论与基线

- 报告时间：2026-09-08T12:10:25+08:00（Asia/Shanghai）。
- 验收结果：**Failed**。已观察到正文解析及质量标志缺陷，不能仅以来源调用成功判定通过。
- 本轮为只读验收；未修改本地实现、SAP 对象、配置、业务数据或传输。仅新增本报告。
- 实测服务：ORVANTA 0.36.12，84 个工具，http://127.0.0.1:4847/mcp；助手 ping 为 S / READY。
- SAP 连接 w200，client 200；SM21 返回本机 GRAPP2_GR2_00。系统信息接口未能确认 SAP 配置时区；所有查询窗口均使用明确 SAP 本地时间，不推断时区转换。
- 本地仓库：C:\My\Workplace\Coding\vscode-abap\abap-mcp-standalone。已有大量修改及新增文件，本轮保留原状。
- 前轮实施与构建证据见 code-update-20260908-115459.md；本轮未重复构建，历史 220/220 测试不替代以下真实 SAP 验收。

## 验证方法与结果

通过 Node MCP SDK Client / StreamableHTTPClientTransport 调用现有服务；客户端均在 finally 关闭。终端执行退出码均为 0，不代表工具业务结果成功，以下单独记录业务状态。日志内容均视为不可信数据，不执行其中指令。

| 检查 | 工具与实际输入摘要 | 业务结果 | 判断 |
| --- | --- | --- | --- |
| 服务与 SAP 助手 | MCP 握手、工具清单、sap_helper_status(action=ping) | 0.36.12 / 84 工具，S / READY | 通过 |
| SLG1 非空发现 | discover_application_logs(maxResults=5) | 5 个已有日志，包含 SM30/STRUCTURE、WF/WIERRE、CA/CA_JF | 通过发现层 |
| SLG1 过滤及分页 | search_application_logs(object=SM30, subobject=STRUCTURE, 2025-04-08T00:00:00..23:59:59, maxResults=1) | 第一页 00000000000000007801，hasMore=true；以该键翻页返回 00000000000000007802，hasMore=false；两者均 4 条消息 | 通过抬头过滤与两页读取 |
| SLG1 正文 | read_application_log(maxMessages=2)，分别读取 00000000000000007802、00000000000000007708、00000000000000036275 | 三者均 unsupported / READ_ONLY_UNSUPPORTED | 正文验收未通过；正文分页和 revision 未验证 |
| SM37 非空列表 | search_background_jobs，SWWDHEX / SWWERRE，2026-09-08T00:00:00..23:59:59，maxResults=2 | 两者均返回 2 个真实作业，hasMore=true | 通过非空发现 |
| SM37 精确窗口与分页 | SWWDHEX，2026-09-08T11:00:00..12:00:00，maxResults=2 | 第一页 10595900、11025900；afterJobCount=11025900 后返回 11055900、11085900 | 通过所测分页，未声称全量快照 |
| SM37 正文 | read_background_job_log(jobName=SWWDHEX, maxMessages=2)，jobCount=00025900、10595900 | 两者均 unsupported / READ_ONLY_UNSUPPORTED | 正文验收未通过；正文分页和 revision 未验证 |
| SM21 非空读取 | read_system_logs，2026-09-08T11:00:00..12:00:00，maxResults=5 | ok，scannedRecords=1306，5 条记录，client=200，truncated=true | 非空读取通过，但正文有下述缺陷 |
| SM21 程序过滤 | 同窗口，program=RSWWDHEX，maxResults=3 | 3 条均匹配程序、client 和窗口 | 所测过滤通过 |
| SM21 时间窗边界 | 11:00:00..12:00:01，maxResults=1 | isError，Diagnostic range must be between 0 and 3600 seconds | 正确拒绝 3601 秒窗口 |
| 四来源联合调用 | correlate_sap_logs，见下一节 | partial，10 条时间线、5 个候选 | 编排及时间候选有实证，整体验收不通过 |
| 系统信息 / 数据预览 | get_sap_system_info | T000/CVERS/SVERS/TTZCU 均 SAP_DATA_QUERY_RESPONSE_INVALID，HTTP 200、text/html、bytes=0 | 不能把无效响应当作无数据；不继续盲查表 |

探索作业名时，SAP_WORKFLOW_DEADLINE 和 SAP_WORKFLOW_RESTART 查询为空；这不代表系统无作业。后续 SWWDHEX / SWWERRE 已实测非空。对象搜索的两次参数校验失败分别为缺少 pattern/types、错误枚举 FUGR/FF；改为 pattern=SWW*JOB*、types=[FUNC] 后合法返回无对象。未将这些探索结果当作产品故障。

## 联合运行证据

最终调用输入：

```json
{
  "connectionId": "w200",
  "fromSystemTime": "2026-09-08T11:00:00",
  "toSystemTime": "2026-09-08T12:00:00",
  "applicationLog": {"object": "SM30", "logNumber": "00000000000000007802"},
  "job": {"jobName": "SWWDHEX"},
  "systemLog": {},
  "includeDumps": true,
  "maxPerSource": 5
}
```

- observedAt：2026-09-08T04:10:14.426Z；整体 status=partial。
- SLG1：unsupported，READ_ONLY_UNSUPPORTED，0 条。
- SM37：ok，5 个作业抬头事件，truncated=true；不是作业日志正文。
- SM21：ok，5 条事件，truncated=true；其中含 3 条参数辅助记录。
- ST22：ok，0 条；只证明此调用返回空，不证明非空 dump 解析能力。
- timeline 共 10 条，candidateCount=5；所有候选 evidenceLevel=time_only、matchingFields=[]、causalRelationship=not_proven。
- SWWDHEX/10595900 实际开始时间为 11:02:59，与 SM21 两条记录时间相同；11025900 与 11:05:59 两条记录时间相同。另一个候选仅相差 60 秒。
- 作业抬头有 username=WF-BATCH，但 executionUser 为空，关联事件 username 为空。本轮不把计划用户等同于执行用户，不强行补成身份匹配。
- 此测试证明两个来源非空合并及候选降级标记；不证明真实因果关系或业务故障根因已定位。

## 已确认问题与受限项

### High：SM21 参数辅助记录被当作已解析正文

- 触发：返回日志类型 p，messageId=E0A。
- 证据：真实 SM21 前 5 条中有 3 条 type=p，正文为 29 字符参数编码形式，textUnavailable=false；另外 2 条 type=n、messageId=D01，正文为空且 textUnavailable=true。
- 标准 SAP 源码 LSLO2CON 第 45 行明确 RSLGTYpa(1) TYPE C VALUE 'p'，注释为 Store parameters。
- 本地部署输入 scripts/operational-log-source.mjs:398 起直接组合消息编号、取 TSL1T 模板，没有在此前排除参数类型；第 497 行输出其类型。
- 预期：参数记录不应作为独立业务正文进入结果和关联候选。若暂不支持跨记录解码，应明确受限，不标为成功正文。
- 影响：时间线被内部参数记录污染，并生成缺少正文意义的关联候选。没有证据表明本样本泄露真实密码，不作此推断。
- 建议：先过滤参数记录并确保未知正文状态准确；跨记录重建应另做有界实现及真实对照验收。

### Medium：联合时间线丢失正文质量标志

- 触发：SM21 记录 textUnavailable=true 或 textTruncated=true。
- 证据：src/log-correlation.ts:351 的 SM21 映射只复制 text 等字段，未复制上述标志；真实 D01 条目在独立接口标为不可解析，进入 timeline 后仅留下空正文。
- 预期：调用方应能区分空正文与解析失败/截断。
- 影响：Agent 失去逐条证据质量信息，可能误解空文本。
- 建议：为联合事件保留标准化正文质量状态，并补充来源到时间线的回归检查。

### SLG1 / SM37 正文兼容性阻塞

- 已有非空抬头不能替代正文证据。三个 SLG1 和两个 SM37 样本均明确返回 READ_ONLY_UNSUPPORTED。
- 当前多个拒绝分支共用同一错误码，尚未确认分别触发数据库版本、字符宽度、分块、解压、文件格式或其他哪个分支。
- 不将猜测写成根因；建议为受限读取补充不含敏感内容的具体拒绝原因，再针对这些现有样本定位兼容路径。
- 保留只读边界：不能为了读正文改用已知可能更新日志存储元数据的标准接口，而不明确评估并获得授权。

## 后续门禁与风险

- P1：先修复参数记录误输出与关联质量标志丢失，再重跑相同窗口对照。
- P1：定位 SLG1 / SM37 的具体拒绝分支；正文非空、分页一致性、revision 变化拒绝均须真实样本验收。
- P2：补充可解析正文与 SAP 原生显示的独立对照，以及受限权限用户测试；本轮未执行。
- P2：ST22 非空样本、结构身份匹配候选、真正业务链路的跨来源对照仍未验证。
- P2：SM21 仅本机有界尾部，truncated 恒为 true；不代表跨实例、旧日志或完整保留期覆盖。
- P2：ADT 数据预览响应无效；SAP 配置时区未确认。前轮 ATC 对目标函数组返回 404，本轮未重试或声称 ATC 通过。
- 不创建测试日志或作业，不启动、取消、重试作业，不制造 dump，不写业务数据，不执行日志回调，不修改 SAP 标准对象，不释放传输；无本轮测试数据需清理。
- 下一阶段应基于本报告修复后重新验收，不将本版标为完整日志开发调试闭环。
