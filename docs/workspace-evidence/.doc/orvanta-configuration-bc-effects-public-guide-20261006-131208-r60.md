# read_configuration_bc_effects：固定计量单位关联效果前态

基线：2026-10-06T13:12:08.120+08:00，w200/GR2/200，API-only。当前实现及本地HTTP/MCP接口通过；底层只读RFC原生通过，新公开工具SAP运行仍unverified。本指南不替代当前schema、SAP接口、权限或集成测试。

## 调用顺序

先在同一服务的server exportRoot调用 read_configuration_bc_before_state，取得 beforeStateReference。随后将该引用作为新工具输入。引用必须已有于服务端，并与当前SAP配置连接/用户及固定请求任务绑定；工具不接受调用者上传buffer，不复制外部前态或从摘要推定其存在。读取返回 effectsStateReference，是关联前态的独立只读证据引用；原配置format1引用保持不变。当前没有公开import或restore命令。

| 必填输入 | 允许值/来源 |
| --- | --- |
| connectionId | w200 |
| bcSetId | EHS_CUNI_KNM |
| version | N |
| requestNumber | GR2K923429 |
| taskNumber | GR2K923430 |
| operationId | 8–80字符，首字符字母或数字，其余字母/数字/下划线/点/连字符；仅用于本次只读证据 |
| beforeStateReference | 前一工具返回的64位小写十六进制摘要；必须存在于此服务端证据根 |

strict schema拒绝额外字段，buffer/tableName/execute/IV_CTS_VERSION不允许。用户、system、client及CTS版本均由服务端身份与已存前态派生，调用者不提交。既有登录状态不代表写权限。

## 返回及稳定语义

返回当前观察的 counts(matched/records/headers/variables/links)、profileCount、effectsVersion、ctsVersion、scopeVersion、bodyFingerprint、源码/接口/DDIC identities、原生buffer和新effectsStateReference。只读范围是19个固定CUNI键，以及相应全部profile的SCPRACTR/P/X/XL前态；matched=0仍纳入当前BC Set profile身份，不意味着全系统无链接。原生最多32profiles，每类512行，buffer524288bytes；过限或两轮漂移拒绝，不截断后伪成功。

buffer为服务器读取的SAP EXPORT数据，经原生IMPORT/re-EXPORT、字节数/规范base64/SHA检查；外部调用者不得解码为显示值后再上传恢复。format2仅保存本次关联证据并重新校验旧format1引用；不能用效果引用替代配置引用，不能跨用户复用。同内容并发保存原子发布一个不可变文件，已有文件不覆盖。

固定 readOnly=true；snapshot、executable、activationAvailable、recoveryAvailable、currentStateRechecked、ctsRecoveryChecked和buffer.recoveryPermit均false。已存CTS相同是一次版本绑定与顺序观察，配置前态不在此调用中重新读取，也未取得SAP锁，不提供当前原子快照或恢复权。

## 失败处理

schema、缺失/损坏引用、身份不符、标准Include URI或源码/接口/DDIC漂移在dispatch前拒绝；调用后的漂移、非法原生响应/计数/buffer亦拒绝。稳定错误如 CONFIGURATION_BC_EFFECTS_INPUT_INVALID、VERSION_CONFLICT、READ_CHANGED、KEY_SCOPE_INVALID保留原因；公开错误不带可用的新引用。工具不自动重试、不调用任意query/helper回退，也不预约业务写operation receipt。

此工具为后续审阅提供前态证据。完整配置APPLY/RECOVER、精确CTS补偿、锁内验证和非空共享profile真实验收仍未交付；r59的2正常/4原生拒绝/4schema拒绝预算已用完，不用它支持新增原生命令。
