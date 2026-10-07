# MCP 能力缺口、错误与异常日志

只读调用在SAP端已完成并保存原生前态，但默认客户端20分钟超时。保留原错误，先核对持久文件和原生调用计数再切换已确认的只读传输客户端；共享服务与固定构建不重启、不扩大权限。

```json
{
  "at": "2026-10-05T13:07:35.675Z",
  "classification": "CALL_ERROR",
  "operation": "read-only",
  "serviceRoot": "C:\\My\\Workplace\\Coding\\vscode-abap\\abap-mcp-standalone",
  "serviceRootEvidence": "current package.json name verified and isolated r53 launch cwd; no other service root used",
  "version": "0.50.23",
  "tool": "read_configuration_bc_before_state",
  "arguments": {
    "connectionId": "w200",
    "bcSetId": "EHS_CUNI_KNM",
    "version": "N",
    "requestNumber": "GR2K923429",
    "taskNumber": "GR2K923430",
    "nativeSourceVersion": "73783f69f1bf9805b058fbc9bab0adb8cc8047f85c837ee16c174a9edd0f512b",
    "nativeTargetVersion": "23a193a37f81d4b208829c647d8e3058c47312cd49727343f9cdebe581148477",
    "nativeCandidateVersion": "1fd8fcbe40506af29645a4c216c3ff2e3439197142c453b71d90f31adc1c3a18",
    "nativeMetadataVersion": "b9f1b672cc742718e967dff5f48d545bd8dbdbee58ed13cd9204e0e366211d6d",
    "nativeGuardVersion": "1c4e09257f3b2699e7cb25834b3f398291706757008a6087f8d4118e1cc4ab9f",
    "nativeCtsVersion": "7592fcc1736c5b6856f7c702fbf1bcca3c3ff372f71761fdc6fd4ff7ebe63b50"
  },
  "connection": "w200/GR2/200",
  "deadlineMs": 1200000,
  "rawExposedResult": {
    "error": "McpError: MCP error -32001: Request timed out",
    "status": "failed",
    "finishedAt": "2026-10-05T13:04:41.913Z",
    "transportDetails": "client did not expose a nested UND_ERR code; do not fabricate it"
  },
  "clientEvidence": ".cache/spro-r54/default-client-timeout.json",
  "serverEvidence": ".cache/spro-r53/state/exports/configuration-bc-before-state/c73130af1434697327f6c601a7f1bf2870dde52bf1c6f686b43dd89bd1dccb95.json",
  "metrics": {
    "startedAt": "2026-10-05T12:44:02.043Z",
    "configurationWrites": 0,
    "configurationCtsWrites": 0,
    "nativeStateReads": 2,
    "nativeRefusals": 4,
    "nativeDependencies": {
      "Z_ORVANTA_CFG_BC_READ": 65,
      "Z_ORVANTA_CFG_BC_PREVIEW": 5,
      "Z_ORVANTA_CFG_BC_ROUTE": 25,
      "Z_ORVANTA_CFG_BC_GUARD": 9,
      "Z_ORVANTA_CFG_BC_CTS": 5
    },
    "tableReads": 3840,
    "nativeQueries": 3840,
    "metadataReads": 544,
    "definitionReads": 79,
    "sourceReads": 28
  },
  "localReproduction": {
    "test": "public native before-state long read keeps SSE alive and returns its complete RPC payload",
    "passed": 4,
    "failed": 1,
    "reason": "SSE wire has only final event/data, no : keep-alive comment; src/http.ts name check covers preflight only",
    "source": "test/http-preflight-stream.test.ts"
  },
  "safeAlternative": "exact same frozen instance and public readonly input, existing restricted loopback native node:http client; one remaining positive uses two STATE calls, total four; no write retry or credential reuse",
  "redactions": "No credentials, cookies, lock handles or session tokens in these selected fields; raw unrelated successful source omitted"
}
```
