# MCP 能力缺口、错误与异常日志

## 事件信息

- 时间：2026-09-22T10:56:59.808+08:00
- 事件序号与分类：本轮 001 / `OUTCOME_UNCERTAIN`（伴随 `CALL_ERROR`）
- 任务目标：继续实施装托后拆托、拼托、转托主线 R1B-1，恢复激活审计明细表 `ZTPMC_TPRPI`
- MCP 服务与版本：ORVANTA `abap-mcp-standalone` 0.46.14，Git `dc100e8`；启动方式未提供
- 已核实服务根目录：`C:\My\Workplace\Coding\vscode-abap\abap-mcp-standalone`
- 根目录核实依据：当前目录 `package.json` 包名为 `abap-mcp-standalone`、版本为 `0.46.14`；Git HEAD 为 `dc100e8`
- MCP 工具或所需能力：`resume_ddic_table_activation` / 非活动透明表受指纹保护恢复激活
- 目标系统/客户端：`w200` / `200`
- 目标对象/URI：`ZTPMC_TPRPI` / `TABL`；本次专用 DDIC 工具未提供对象 URI
- 操作性质：可写、可能触发 SAP 内部提交
- 结果状态：助手拒绝 `OPERATION_NOT_SUPPORTED`；回执 `sapInvocationStarted=true` 且 `outcomeMayBeUnknown=true`

## 开发或审查场景

前次建表失败留下非活动对象。用户授权继续实施。当前只读核对确认：定义仍为非活动，29 字段与 DD03L 独立结果一致；数据类 `APPL1`、容量类别 `1`；TADIR 包 `ZPMC`、作者 WYS；SM12 对 WYS/目标表返回 0 条，TBATG 无待处理项；运输 `GR2K923427/428` 为 WYS/D，父请求有 `LIMU TABD ZTPMC_TPRPI`。本次先建立并验真不可变定义快照，再以最新指纹执行一次恢复激活，不重建、不改技术设置、不操作业务数据。

## 能力缺口分析

当前工具暴露的恢复激活合同要求 SAP helper 支持 `RESUME_TRANSPARENT_TABLE_ACTIVATION`（协议 1.10 或以上）。实际 SAP DDIC helper 返回 `OPERATION_NOT_SUPPORTED: Unsupported DDIC operation`。本地工具暴露能力与目标 helper 的实际操作能力不一致；此调用不能完成恢复。回执同时标记结果可能未知，因此不能仅据报错断定 SAP 表、技术设置或 CTS 均未变化。工具提供的 `sapPreChangeEvidence` 源仅为 `adt_object_search` 且记 `exists=false`，与调用前专用 DDIC 读取证实的非活动对象不同，不能把该摘要当成“对象不存在”的独立证据。

## 上下文与前置步骤

1. 桌面方案与项目内方案字节数、SHA-256 完全一致：21,686 字节，`895C3E281CB192409D97F4EC2149FD40B0B56EB0AC7B5EAF65DDE9FB0EC92050`。
2. `get_connected_systems` 返回 `w200`；`sap_helper_status(ping)` 返回 READY、helper version 1.0；目标验证返回 `TARGET_ALLOWED`。
3. `read_ddic_transparent_table` 两次读取非活动定义，均为 29 字段、`APPL1/1`、指纹 `10e03bd3e24092fd1a61994f1ba24ec96e66b0a5cc8fc055bd5b40b5db01dc9b`。
4. DD03L 精确查询返回 29 条 `AS4LOCAL=N/AS4VERS=0001`，字段位置、元素和前三键与专用定义一致；DD02L 仅有非活动表头；TADIR 为 `R3TR/TABL/ZTPMC_TPRPI/ZPMC/WYS`。
5. TBATG 0 项、`pending=false`；SM12 当前客户端 WYS/目标表 0 条；`GR2K923427/428` 为 WYS/D，父请求 17 项含目标 `LIMU TABD`，任务 135 项且无目标条目。
6. 不可变写前定义快照：`C:\My\Workplace\Coding\abap-code\bzh-tp\.doc\source-backup\repack-r1b1-tprpi-resume-2026-09-22T10-55-47+08-00\ZTPMC_TPRPI.inactive.md`，3,420 字节，SHA-256 `570C3936718007230A7F525FF5CF895DE840DC54D2C8D7B466208376EB514303`；重新打开确认 29 字段和指纹。
7. 紧接写前第三次读取仍为非活动、29 字段、`APPL1/1`，指纹未变，然后调用恢复工具一次。

## 调用入参（已脱敏）

```json
{"confirmation":"RESUME_INACTIVE_ACTIVATION","connectionId":"w200","expectedInactiveFingerprint":"10e03bd3e24092fd1a61994f1ba24ec96e66b0a5cc8fc055bd5b40b5db01dc9b","objectName":"ZTPMC_TPRPI","operationId":"repack-r1b1-resume-tprpi-20260922-01","packageName":"ZPMC","transportNumber":"GR2K923428"}
```

未提供 `settingsRepair`：写前定义已报告批准的 `APPL1/1`。

## 原始返回或异常（已脱敏，未改写）

```text
Error invoking resume_ddic_table_activation: Error: SAP DDIC helper rejected the operation: OPERATION_NOT_SUPPORTED: Unsupported DDIC operation

Operation Receipt
{
  "operationId": "repack-r1b1-resume-tprpi-20260922-01",
  "version": 2,
  "status": "failed",
  "connectionId": "w200",
  "toolName": "resume_ddic_table_activation",
  "operationIdHash": "d6731844ca00b92dd3b5119e8a8d5e77854c2144350f8edf80c44343686dfcd1",
  "targetKeyHash": "3f733b2c17c1d97762ee98a6fbf227edd29de3578fbe959089a181786aeb5cdb",
  "inputHash": "155557c7b90be9294a20bef43ac7a0ffb18376cf07682ce8ab41baa968ff71cc",
  "preChangeSummary": "{\"target\":\"tabl object ZTPMC_TPRPI\",\"requestedOperation\":\"resume_ddic_table_activation\",\"concurrencyGuard\":\"tool-specific SAP readback and lock checks\",\"transportNumber\":\"GR2K923428\",\"automaticRollback\":false}",
  "sapPreChangeEvidence": {
    "observedAt": "2026-09-22T02:56:45.671Z",
    "target": "tabl object ZTPMC_TPRPI",
    "exists": false,
    "active": null,
    "version": null,
    "fingerprint": null,
    "packageName": null,
    "requestNumber": null,
    "taskNumber": null,
    "observationStatus": "complete",
    "sources": [
      "adt_object_search"
    ],
    "warnings": []
  },
  "sapInvocationStarted": true,
  "errorHash": "09e0a8510a9d2488ca32fed8543e281c97f5ac2126d93de99705555ff07a58bb",
  "startedAt": "2026-09-22T02:56:45.606Z",
  "finishedAt": "2026-09-22T02:56:45.760Z",
  "durationMs": 149,
  "receiptHash": "e0574f49b8893f48a26af3adab1b7b10f589141aaaaaf42081a56ccb3feca9fb",
  "automaticRetry": false,
  "automaticRollback": false,
  "outcomeMayBeUnknown": true,
  "localLockReleased": true,
  "manualRecovery": "Read back tabl object ZTPMC_TPRPI from SAP and compare it with the pre-change summary and requested change. Do not retry automatically. If the state is interrupted or uncertain, resolve locks and transport assignment in SAP before using a new operationId."
}
```

- `isError`: `true`
- HTTP 状态、响应头及原始响应体：未提供
- 异常类型/堆栈：除上述错误文本外未提供
- stdout/stderr：未提供
- 截断标记：未提供

## 相关原始信息

- 本次工具回执 `operationId`：`repack-r1b1-resume-tprpi-20260922-01`
- `receiptHash`：`e0574f49b8893f48a26af3adab1b7b10f589141aaaaaf42081a56ccb3feca9fb`
- `localLockReleased=true` 只说明本地 MCP 锁释放，不证明 SAP DDIC 锁或激活结果。
- 发生错误后遵照用户规则未调用任何后续 MCP 状态查询；故无本轮写后只读证据。

## 影响、结果确定性与受阻工作

- R1B-1 的 DDIC 恢复激活受阻；依赖类/函数及真实拆拼转托功能没有继续开发。
- 工具报告 `status=failed`，但 `sapInvocationStarted=true` 且 `outcomeMayBeUnknown=true`；SAP 侧最终状态未核实，不能称为“未激活”或“已激活”。
- 未自动重试、回滚、删除对象、清理运输、修改配置或业务数据；未发布/移动/重分配运输。

## 已考虑的安全替代方案

- 用相同或新的 operationId 重试：拒绝；写入结果未知且 helper 报不支持。
- 使用普通 create 或直接 DDIC/CTS 表写入：拒绝；已有部分对象和运输记录，可能覆盖或破坏现状。
- 改用 WebGUI 激活：未执行；用户要求尽量使用 MCP，且已明确“发现 MCP 异常后记录并停止”。
- 本轮再读回 SAP：未执行；按用户异常即停规则暂停，下一轮需先只读协调状态。

## 后续核对与开发者复现提示

1. 检查已部署 SAP helper 是否真正发布并允许 `RESUME_TRANSPARENT_TABLE_ACTIVATION`，确认协议版本与 MCP 工具预检一致；不要仅以 PING READY/version 1.0 推断支持该 DDIC 操作。
2. 工具在发起写入前应核实 helper 支持的操作清单；不支持时 fail closed 并返回明确阶段，不要让回执仅以 ADT 搜索报告 `exists=false`，而忽略可见的非活动 DDIC 定义。
3. 修复后先用只读工具核对活动/非活动定义、29 字段、`APPL1/1`、TADIR、DD02L/DD03L、TBATG、SM12 和运输树；基于本次 operationId 的回执协调结果，不能盲重试。
4. 若状态确认为仍非活动且无其他变更，再以新鲜指纹、批准运输及新的 operationId 执行一次恢复。

## 脱敏记录

- 原始返回、入参与上下文不含密码、Cookie、授权头、令牌、私钥、锁句柄或敏感业务数据；无字段脱敏。

## 文件信息

- 文件路径：`C:\My\Workplace\Coding\vscode-abap\abap-mcp-standalone\.logs\mcp-incident-20260922-105659-808-resume-ddic-operation-not-supported.md`
- 字节数：写入后外部回执
- SHA-256：写入后外部回执
