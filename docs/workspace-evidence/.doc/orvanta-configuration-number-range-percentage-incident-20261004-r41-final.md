# r41 专用号码范围创建拒绝

时间：2026-10-04T10:56:22.036Z；已核实服务根目录 C:/My/Workplace/Coding/vscode-abap/abap-mcp-standalone，依据原 r41 current/startup 与本地默认 dist 指纹一致记录。w200/200/WYS。

原始调用/返回及历史回执：

```json
{
  "at": "2026-10-04T10:49:55.795Z",
  "name": "upsert_number_range_object",
  "args": {
    "connectionId": "w200",
    "packageName": "ZABAP",
    "transportNumber": "GR2K923472",
    "operationId": "cfg-r41-create-test-number-range-corrected",
    "objectName": "ZORVCFGNR",
    "description": "ORVANTA configuration API acceptance only",
    "properties": {
      "DOMLEN": "NUMC20",
      "YEARIND": "",
      "BUFFER": "",
      "DTELSOBJ": "",
      "NRTAB": "",
      "TEXTIND": "",
      "RFCDEST": "",
      "NRCHECKASCII": ""
    },
    "texts": [
      {
        "language": "1",
        "text": "ORVANTA配置API专用验收号码范围",
        "shortText": "配置API验收"
      }
    ]
  },
  "isError": true,
  "data": {
    "message": "Error invoking upsert_number_range_object: Error: SAP DDIC helper rejected the operation: NUMBER_RANGE_UPDATE_REJECTED: Number range object was rejected by SAP 输入一个在 0,1 和 99,9 之间的百分值\n\nOperation Receipt\n{\n  \"operationId\": \"cfg-r41-create-test-number-range-corrected\",\n  \"version\": 2,\n  \"status\": \"failed\",\n  \"connectionId\": \"w200\",\n  \"toolName\": \"upsert_number_range_object\",\n  \"operationIdHash\": \"d9ab689ee7ce29ca9b9b81ecd2e4a71e27d64c0c048ec4ae5725b1dbd3aea043\",\n  \"targetKeyHash\": \"d95bd1a818ec1c62c3d516c4bb23b5b5206c85f064a79f29db1269ce8ae9147d\",\n  \"inputHash\": \"516d6e5591c313af1de6447a957b412ab78a616a9e576a3f5b6845fbab90a184\",\n  \"preChangeSummary\": \"{\\\"target\\\":\\\"object object ZORVCFGNR\\\",\\\"requestedOperation\\\":\\\"upsert_number_range_object\\\",\\\"concurrencyGuard\\\":\\\"tool-specific SAP readback and lock checks\\\",\\\"transportNumber\\\":\\\"GR2K923472\\\",\\\"transportCheckWarning\\\":\\\"E070 could not be read for GR2K923472 (Error: read_abap_table reported TABLE_QUERY_READ_FAILED); it was submitted unchanged\\\",\\\"automaticRollback\\\":false}\",\n  \"sapPreChangeEvidence\": {\n    \"observedAt\": \"2026-10-04T10:49:55.645Z\",\n    \"target\": \"object object ZORVCFGNR\",\n    \"exists\": false,\n    \"active\": null,\n    \"version\": null,\n    \"fingerprint\": null,\n    \"packageName\": null,\n    \"requestNumber\": null,\n    \"taskNumber\": null,\n    \"observationStatus\": \"complete\",\n    \"sources\": [\n      \"sap_ddic_read\"\n    ],\n    \"warnings\": []\n  },\n  \"sapInvocationStarted\": true,\n  \"errorHash\": \"87963389ea70cd8b44f0667f439a119d2a75dd8a3d45e94650d07f50c70f2264\",\n  \"startedAt\": \"2026-10-04T10:49:55.522Z\",\n  \"finishedAt\": \"2026-10-04T10:49:55.787Z\",\n  \"durationMs\": 263,\n  \"receiptHash\": \"99242db39b6e681b3843c1615af0670e34b36cf9eea2d3d99cd50dc453bda6d5\",\n  \"automaticRetry\": false,\n  \"automaticRollback\": false,\n  \"outcomeMayBeUnknown\": true,\n  \"localLockReleased\": true,\n  \"manualRecovery\": \"Read back object object ZORVCFGNR from SAP and compare it with the pre-change summary and requested change. Do not retry automatically. If the state is interrupted or uncertain, resolve locks and transport assignment in SAP before using a new operationId.\"\n}"
  }
}
```

SAP 标准 LSNR2F30 的 CHECK_OBJECT（439—451 行）要求 PERCENTAGE 在 0.1—99.9，原测试定义未传此必填属性。NRPERC 实际域 DEC3/1，无符号。它是创建验收参数遗漏，不修改标准校验或通用回执错误分类。未知历史回执不更改；只读确认 authoritative NROB exists=false、TADIR/E071 均零、SM12 当前用户字面过滤零条，native APPLY=0、改值提交=0。TNRO 通用查询 TABLE_NOT_ALLOWED 保留，不扩大 allowlist。

安全下一步：同一已批准专用对象新增 PERCENTAGE=10，保留原 TNRO 条件/文本/包/请求；新受限实例以对账为前提且 DDIC 只派发一次，任何失败停止；完整原生四命令/两改值额度未消费，不取号/释放/GUI/标准业务表写。
