# r41 来源校验与 SOAP TABLES 返回问题

时间：2026-10-04T11:12:37.430Z。服务根目录已核实为 C:/My/Workplace/Coding/vscode-abap/abap-mcp-standalone，沿用 r41 live startup/current 与本地 default dist 指纹核对。w200/200/WYS。

1. CONFIGURATION_NR_INCLUDE_NOT_ATTESTED：FSNR1CDC 实际路径 /sap/bc/adt/programs/includes/fsnr1cdc/source/main，而非 SNR1 function-group include 路径。四个 Include 现读完整范围和既有 SHA256 全部一致；修正此精确路径，其他指纹/来源/全量读取规则保留。原拒绝回执 sapInvocationStarted=false，不是 SAP 写失败。

2. 实际首次原生创建：

```json
{
  "at": "2026-10-04T11:05:01.344Z",
  "name": "apply_configuration_number_range",
  "args": {
    "connectionId": "w200",
    "objectName": "ZORVCFGNR",
    "expectedVersion": "7d9157a9d74ae68008972b91cc218f5aa6ecd5fe2c24338c44a7ebd7e60a493d",
    "action": "create",
    "intervalNumber": "01",
    "fromNumber": "00000000000000000001",
    "toNumber": "00000000000000000100",
    "external": false,
    "operationId": "r41b-public-create-01-fixed-include",
    "acknowledgeConfigurationWrite": true,
    "acknowledgeLocalClientOnly": true
  },
  "isError": true,
  "data": {
    "status": "unknown",
    "operationId": "r41b-public-create-01-fixed-include",
    "objectName": "ZORVCFGNR",
    "client": "200",
    "transportPolicy": "local_client_only_not_recorded",
    "sapInvocationStarted": true,
    "outcomeMayBeUnknown": true,
    "native": {
      "EV_CODE": "SAVED_LOCAL_CLIENT",
      "EV_SYSTEM": "GR2",
      "EV_CLIENT": "200",
      "EV_USER": "WYS",
      "EV_COMMITTED": "X",
      "EV_BEFORE_VERSION": "7d9157a9d74ae68008972b91cc218f5aa6ecd5fe2c24338c44a7ebd7e60a493d",
      "EV_VERSION": "22eb77b22bff571d3c7fde9bc3744a24397782fb0cb567e5625c2fa7f13f83b5",
      "EV_SESSION_RESET": "X",
      "EV_UNLOCKED": "X",
      "EV_MSGID": "",
      "EV_MSGNO": "",
      "ES_ERROR": {
        "MSGNR": "",
        "TABLENAME": "",
        "FIELDNAME": "",
        "TABIX": "0"
      },
      "ET_INTERVALS": []
    },
    "readback": {
      "EV_CODE": "READ_OK",
      "EV_SYSTEM": "GR2",
      "EV_CLIENT": "200",
      "EV_VERSION": "22eb77b22bff571d3c7fde9bc3744a24397782fb0cb567e5625c2fa7f13f83b5",
      "ES_DEFINITION": {
        "OBJECT": "ZORVCFGNR",
        "DTELSOBJ": "",
        "NRTAB": "",
        "NRINTFLD": "",
        "NREXTFLD": "",
        "NRFLD": "",
        "NRSOBJFLD": "",
        "NRELEFLD": "",
        "YEARIND": "",
        "DOMLEN": "NUMC20",
        "PERCENTAGE": "10.0",
        "CODE": "",
        "TEXTIND": "",
        "NRELTXTTAB": "",
        "NRELTXTSOB": "",
        "NRELTXTELE": "",
        "NRELTXTTXT": "",
        "NRELTXTLNG": "",
        "BUFFER": "",
        "NOIVBUFFER": "00000000",
        "NONRSWAP": "",
        "RFCDEST": "",
        "NRCHECKASCII": ""
      },
      "ET_INTERVALS": []
    },
    "retryAvailable": false,
    "operationReceipt": {
      "version": 2,
      "status": "failed",
      "connectionId": "w200",
      "toolName": "apply_configuration_number_range",
      "operationIdHash": "80eb7337faf6cfc66ca40cb03fe621bddc2cb1b6f0eed44beef00e327676c9a2",
      "targetKeyHash": "3d23806c93052e6b81e794248bd0317c4571998abd8889bb68820abb28b696f3",
      "inputHash": "7d17f8efbad6bde8b264eac5eb34daaf1f2b39c14e8f46cd257286b023e012f3",
      "preChangeSummary": "Complete ZORVCFGNR/200 version 7d9157a9d74ae68008972b91cc218f5aa6ecd5fe2c24338c44a7ebd7e60a493d; create interval 01.",
      "sapPreChangeEvidence": {
        "observedAt": "2026-10-04T11:05:00.009Z",
        "target": "NRIV:ZORVCFGNR:200",
        "exists": true,
        "active": null,
        "version": "7d9157a9d74ae68008972b91cc218f5aa6ecd5fe2c24338c44a7ebd7e60a493d",
        "fingerprint": "7d9157a9d74ae68008972b91cc218f5aa6ecd5fe2c24338c44a7ebd7e60a493d",
        "packageName": null,
        "requestNumber": null,
        "taskNumber": null,
        "observationStatus": "complete",
        "sources": [
          "Z_ORVANTA_CFG_NR_READ",
          "TNRO",
          "NRIV"
        ],
        "warnings": [
          "NRIV intervals are local client only; no CTS recording."
        ]
      },
      "sapInvocationStarted": true,
      "errorHash": "4c54ad5edde5ea30945c0d5cade8ea67d1c8802889fe3581e2ddd9ca2e9363b2",
      "startedAt": "2026-10-04T11:04:52.133Z",
      "finishedAt": "2026-10-04T11:05:01.334Z",
      "durationMs": 9202,
      "receiptHash": "d6970bf9e1e237852fcab515b85fe78b3e0d08eafc3fd2f56f1ed117fc7fee2e",
      "automaticRetry": false,
      "automaticRollback": false,
      "outcomeMayBeUnknown": true,
      "localLockReleased": true,
      "manualRecovery": "Read the complete number range definition and all client 200 intervals, native commit and cleanup result. Never retry or roll back automatically. Intervals remain local; no CTS import or release."
    }
  }
}
```

首次保护回执 failed/outcomeMayBeUnknown=true，禁止重做创建。独立只读对照同一 reader 的不绑定/绑定 ET_INTERVALS=[] 请求：不绑定输出空数组，绑定输出 client200 ZORVCFGNR/01、空 subobject/year0000、1..100、level00000000000000000000；两个版本均 22eb77b22bff571d3c7fde9bc3744a24397782fb0cb567e5625c2fa7f13f83b5。原生提交/清理标志 X，历史 unknown 不更改；当前行已真实读取，而非用版本变化推断写成功。

范围内安全继续：仅补齐 reader/writer 内部 SOAP TABLES 绑定，不修改公共输入/schema、SAP 客户源、标准源、通用 SOAP parser 或 allowlist；从已持久化 01[1..100] 继续剩余一次直接旧版本拒绝、update[1..200]、same-value 三原生命令，native总额4/改值提交总额2，定义写成功1。创建不重复，未取号/删除/重置/迁移/释放。具体只读请求、原始结果、红绿回归和历史回执均保留。
