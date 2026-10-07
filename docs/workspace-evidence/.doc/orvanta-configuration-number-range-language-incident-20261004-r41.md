# MCP 配置号码范围创建错误（r41）

时间：2026-10-04T10:24:57.710Z；w200/GR2/client 200。已核实服务根目录：C:/My/Workplace/Coding/vscode-abap/abap-mcp-standalone。核实依据：Local default dist fingerprint equals live shared service current/startup artifact；指纹 fb3a974e6bdd5aa5a67e77f25c7c6e90a90ffe34c6363d87acd4681deaabe5ca。

目标：创建获准专用 ZORVCFGNR，调用 upsert_number_range_object。完整原始参数/返回（不含凭据）：

```json
{
  "at": "2026-10-04T10:22:39.132Z",
  "name": "upsert_number_range_object",
  "args": {
    "connectionId": "w200",
    "packageName": "ZABAP",
    "transportNumber": "GR2K923472",
    "operationId": "cfg-r41-create-test-number-range",
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
    "message": "Error invoking upsert_number_range_object: Error: texts language must be a one-character SAP language: 1\n\nOperation Receipt\n{\n  \"operationId\": \"cfg-r41-create-test-number-range\",\n  \"version\": 2,\n  \"status\": \"failed\",\n  \"connectionId\": \"w200\",\n  \"toolName\": \"upsert_number_range_object\",\n  \"operationIdHash\": \"5b2b8c91a7d0850725d817d9cf2c60401a543a7a63766fb27d300ab4b53f793e\",\n  \"targetKeyHash\": \"d95bd1a818ec1c62c3d516c4bb23b5b5206c85f064a79f29db1269ce8ae9147d\",\n  \"inputHash\": \"516d6e5591c313af1de6447a957b412ab78a616a9e576a3f5b6845fbab90a184\",\n  \"preChangeSummary\": \"{\\\"target\\\":\\\"object object ZORVCFGNR\\\",\\\"requestedOperation\\\":\\\"upsert_number_range_object\\\",\\\"concurrencyGuard\\\":\\\"tool-specific SAP readback and lock checks\\\",\\\"transportNumber\\\":\\\"GR2K923472\\\",\\\"automaticRollback\\\":false}\",\n  \"sapPreChangeEvidence\": {\n    \"observedAt\": \"2026-10-04T10:22:39.117Z\",\n    \"target\": \"object object ZORVCFGNR\",\n    \"exists\": false,\n    \"active\": null,\n    \"version\": null,\n    \"fingerprint\": null,\n    \"packageName\": null,\n    \"requestNumber\": null,\n    \"taskNumber\": null,\n    \"observationStatus\": \"complete\",\n    \"sources\": [\n      \"sap_ddic_read\"\n    ],\n    \"warnings\": []\n  },\n  \"sapInvocationStarted\": true,\n  \"errorHash\": \"7a7185986aa6b2e770063a9e5b036b762ca666470da55e3461d934ac8b959e3a\",\n  \"startedAt\": \"2026-10-04T10:22:39.080Z\",\n  \"finishedAt\": \"2026-10-04T10:22:39.126Z\",\n  \"durationMs\": 43,\n  \"receiptHash\": \"2bd69b1fbcfc75302c98b9fd0274b3b60597c57c6533b5bfca63f16fa385f9e8\",\n  \"automaticRetry\": false,\n  \"automaticRollback\": false,\n  \"outcomeMayBeUnknown\": true,\n  \"localLockReleased\": true,\n  \"manualRecovery\": \"Read back object object ZORVCFGNR from SAP and compare it with the pre-change summary and requested change. Do not retry automatically. If the state is interrupted or uncertain, resolve locks and transport assignment in SAP before using a new operationId.\"\n}"
  }
}
```

本地 numberRangeTexts 仅允许 A-Z，错误拒绝实际 T002.SPRAS=1/LAISO=ZH。通用写包装提前标记派发，纯本地参数错误未使用 PreSapValidationError，回执 sapInvocationStarted/outcomeMayBeUnknown 因而为 true。只读回查确认定义 authoritative exists=false 且 E071 无此 NROB；不是以失败回执推断未写。历史失败回执不修改。先修复纯本地校验与回执分类，在独立构建验收后使用不同的有归属修正操作；不盲目重试或绕过语言规则。

新客户函数组/两 RFC 已创建并激活、诊断无错误；该事故未执行 NRIV 原生命令。所有原始证据保存，未暴露口令、cookie、token 或锁句柄。
