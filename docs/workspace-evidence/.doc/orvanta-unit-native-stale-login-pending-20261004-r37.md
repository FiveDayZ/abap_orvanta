# r37 登录等待补充记录

- 状态：**Partially Verified**。本地单次保护 8/8 通过，真实 SAP 原生命令尚未执行。
- 实际命令：`node .cache/unit-native-stale-r37/controller.mjs`。控制器在 240 秒内没有观察到独立 `ready.json`，以退出码 **1** 和 `R37_OBSERVATION_TIMEOUT_NO_RETRY` 结束。此错误属于等待手工登录的本地超时，没有执行 SAP 登录请求，因此不能归类为 SAP 口令错误或 SAP 原生拒绝验收。
- 原始失败证据：`C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-unit-native-stale-acceptance-20261004-r37.json`，保留不覆盖。当前没有 prepare/execute request 或 native claim；实际 native writer 调用 0。没有自动重试、恢复或传输操作。
- 独立手工登录窗口 PID60320 仍保留。固定运行文件及 manifest 未改，用户在窗口完成登录并回复后，使用准备好的 `controller-resume.mjs` 继续现有一次测试授权；该控制器与固定版本仅在不可变报告输出名称上不同，验收写入 `orvanta-unit-native-stale-acceptance-20261004-r37-recheck.json`。当前不运行续验控制器，也不在本次结束后自动派发 native 命令。
- 当前开发记录：`C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261004-141230.md`。r37 完成后优先规划已释放 CTS 容器的只读候选调查及具名拒绝验收；不释放当前429/430以制造场景。

权威原件均在项目根 `.doc`，同字节镜像到本项目 `abap-mcp-standalone/docs/workspace-evidence/.doc`；没有更改公共源码、SAP 标准对象、配置值、共享服务或其他任务暂存。
