# r72 KNM 恢复后完整 STATE 只读验收

时间：2026-10-07T13:25:06.867+08:00；w200 / GR2 / client 200 / WYS；分支 main；当前提交 775ae25980f2988e1f84f11d71409592d8bc4063。

## Result

**Passed（本次限定九表十九键的只读验收）**。人工登录后的固定构建成功返回新鲜完整 STATE；十条临时新增配置行已经恢复为不存在，九个保护键保持原态，CTS 和 effects 与已证明的 r71 恢复结果一致。此结论只覆盖 EHS_CUNI_KNM / version N 的批准范围，不证明全部 CUNI 或全部 SPRO。

本次补齐 [13:15 开发记录](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261007-131518.md) 中等待登录的最终 STATE 验收；原开发记录、r71 failed/unknown 历史和 stopped_for_reconciliation 结论均保持原文。BTE 有数据公开预览及写适配器仍未完成，不提升其验证登记。

## Changed Objects/Files

本次没有修改 SAP 对象、配置、CTS 或产品源码；仅新增这份只读验收记录、原始证据和下一阶段计划，并在 docs/workspace-evidence/.doc 镜像。使用 r72 既有固定私有构建，140 个冻结文件及清单摘要均未改变；没有重新编译或更换实例。因没有产品/SAP 实施修改，不另生成 code-update 记录。

## Verification

执行由既有 AI 测试授权和本次人工登录支持，没有扩大写权限。固定入口 `node .cache/spro-r72/state-read.mjs` 在人工输入口令后运行；复核入口 `node .cache/spro-r72/state-completion-check.mjs` 只检查已生成回执、状态文件与哈希，不重发 SAP 查询。

| 检查 | 实际方法 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 固定构建只读验收 | state-read.mjs；SDK 调用 read_configuration_bc_cts_snapshot / read_configuration_bc_before_state | 0 | fresh_full_state_and_restoration_readback_passed |
| 公开 CTS | 最新完整 CTS 两读一致 | 正常 MCP 回执 | 881 ms；2 objects / 2 keys / 0 stringKeys |
| 公开 STATE | 两次原生 STATE、两轮 preflight、CTS 和 API 身份检查 | 正常 MCP 回执 | 94,640 ms；两次 STATE_READ_OK；原生 roundtrip=X |
| 独立恢复读回 | 五表 BC READ + 八个其他保护键的精确只读读取 | 正常 RFC 回执 | 十新增行不存在；九保护键原值/原不存在状态一致 |
| effects | Z_ORVANTA_CFG_BC_EFFECTS | EFFECTS_READ_OK | matched / records / headers / variables / links 全为 0 |
| 最终证据复核 | node .cache/spro-r72/state-completion-check.mjs | 0 | 原生 buffer、版本、19 键计数、358 条只读日志、140 冻结文件全部一致 |
| 快照持久化 | 从私有 state-export 重新加载不可变快照，复核内容哈希、认证绑定及版本 | 0 | 472e643e4163b361bf28554b8c345fffdbfe40cd0e32050698509e6628b06b48 可完整读取；recoveryPermit=false |
| 工作区保留 | node .cache/spro-r72/final-verify.mjs state-complete | 0 | 1027 个阶段前文件中无无关变化/删除；HEAD、暂存和 230 个共享 dist 文件相同 |
| 进程清理 | 测试退出 0；进程回执 PasswordEnvironmentCleared=true；核对指定 launcher 后关闭 PID 66204 | 0 | 临时口令清除、测试 node 退出、任务窗口关闭；共享 PID 60128 仍运行 |

本轮 358 次原生调用全部在 READ/PREVIEW/ROUTE/GUARD/CTS/STATE/EFFECTS/RFC_READ_TABLE 只读名单内；APPLY=0、RECOVER=0、sapWrites=0。未再次执行上阶段已通过的 678 项本地测试：本次没有新产品代码变更。没有 SAP 源修改，不执行激活/ATC；未写配置、没有新写预算、没有传输释放或业务触发。

## Runtime Evidence

| 表 | 恢复后存在行数 |
| --- | --- |
| T006 | 0 |
| T006A | 0 |
| T006B | 0 |
| T006C | 0 |
| T006D | 1 |
| T006I | 1 |
| T006J | 3 |
| T006T | 3 |
| T006_OIB | 0 |

以上为批准十九键的投影：8 行存在、11 个目标键不存在；其中十个此前新增键均不存在，九保护键中 8 个原有行相同、1 个原缺失键仍缺失。scope.tableCount=9、keyCount=19、allCuniKeys=false，snapshot=false；两读一致不宣称全局原子快照。

系统身份 GR2 / 200 / WYS；请求 GR2K923429、任务 GR2K923430。两次原生 STATE 均返回同一 3402 字节 buffer 和状态版本 `572190644fc0056ef1b271948a12fcb464886becbc8dae5293a362d84bf89462`。源版本 `73783f69f1bf9805b058fbc9bab0adb8cc8047f85c837ee16c174a9edd0f512b` 与目标版本 `23a193a37f81d4b208829c647d8e3058c47312cd49727343f9cdebe581148477` 匹配 r71 恢复证据。

最新 CTS 摘要 `90f1299c69f8c6f07cf506711698934fe2f77ae1ad8110e35622ab65e27f1d15`、完整 buffer 和 2/2/0 计数与 r71 已恢复结果逐字节相同。effects 全零且摘要与恢复后记录相同；保留原已有 CTS 条目，不做追加或清理。

历史 STATE 引用 `c73130af1434697327f6c601a7f1bf2870dde52bf1c6f686b43dd89bd1dccb95`，新鲜不可变引用 `472e643e4163b361bf28554b8c345fffdbfe40cd0e32050698509e6628b06b48`。引用变化与前阶段标准维护更新 E070-AS4DATE/AS4TIME 相符；本次新 CTS 与恢复后 CTS 完全相同，稳定配置原态保持。使用新 CTS 摘要绑定新 STATE，不回写审计日期，也不将两个引用强制设为相同。

原验收开始 2026-10-07T13:19:06.673+08:00，完成 2026-10-07T13:20:43.600+08:00；之后只读复核和归档。全部实际输入、公开 MCP 返回、原生返回及快照在 [原始证据](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-state-acceptance-20261007-132506-r72-evidence.json)；不包含口令、Authorization、cookie 或环境转储。

## Remaining Risks

- P1：BTE 产品有数据公开预览、产品专用标准 API 写命令与 CTS/恢复闭环尚未交付，不能宣称完整 SPRO 自动配置。
- P2：此次范围仅 KNM 批准的九表十九键，不覆盖任意 BC Set 或所有 CUNI 值；没有真实业务触发/生产验收。新快照不是恢复许可，也不产生新的 APPLY/RECOVER 预算。
- P2：公开 STATE 耗时 94.64 秒，358 次原生只读调用；记录实际成本供后续评估，没有自行扩大性能测试。

## Documentation / 下一阶段

[r73 最新计划](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-followup-plan-20261007-132506-r73-state-closed.md)：CFG-04 本实例的最终只读 STATE 已完成，下一重点为 CFG-07 产品专用标准 API 维护所有权、完整依赖及有数据预览，之后准备具体客户桥接候选审阅。仍按现有开发/只读授权推进，不自动扩展 SAP 写入或发布。

确认没有 SAP 标准或客户对象变更、配置写入、CTS 写入或请求释放；未改 GUI 路线，未重启共享服务、提交或推送。
