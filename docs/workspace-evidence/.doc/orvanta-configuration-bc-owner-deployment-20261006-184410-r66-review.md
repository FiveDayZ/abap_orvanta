# r66 客户代码部署与依赖激活审阅

2026-10-06T18:44:10.868+08:00，Asia/Shanghai。**Partially Verified**。用户已经批准原r65六客户对象部署及只读验收，本审阅记录技术修正，不新增业务配置权限。

## 实际部署与原生限制

六对象均已存在。F65的1267行正文及三个新remote-enabled STRING RFC的接口/正文通过回读与诊断；原八个reader正文和接口指纹逐个保持。TOP与普通内核仍列于非活动清单，不能宣称六对象整体已激活。父组激活成功不能替代独立Include激活；get_object_by_uri的当前文本也不能替代明确active版及非活动清单。

内核SCPR_VALS_TAB在结构中是通用类型，已改成SCPrVALS标准表及DEFAULT KEY的客户具体类型，700行。SAP INSERT_REPORT_LINE_TOO_LONG转储证明原owner最多440字符行会拒绝写入；完整语句仅在常量外断行，当前最多253字符、1267行。完整新候选见[JSON](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-owner-deployment-20261006-184410-r66-candidate.json)。原r65审阅及失败回执均保留。

## 独立固定构建的剩余动作

固定构建SHA256 20fbd4d138a95a473efc8f19a1a46034889fad83d13b025857fb1b1b22c4de2d。仅通过MCP abap_activate完成两个已有获批Include激活：先重读两对象明确active/inactive全源、比对完整候选并分别原样备份；从SAP D010INC中读取TOP实际主程序，必须唯一为SAPLZORVANTA_BC_CFG；审阅TOP的真实INCLUDE关系后，以该实际主程序为内核的标准ADT activation context。沿用AdtBackend状态会话和标准SDK activate，保留MCP写回执，不自造锁/会话token、标准表或主程序，不清理未知回执保护。只允许w200和这两个URI，源码漂移或重放在SAP派发前拒绝。随后TOP使用普通MCP激活，明确active回读及非活动清单证明。不会修改主程序正文、UXX或其他客户对象。

之后执行11客户RFC、38标准函数、27DDIC和4Include全指纹审计，再调用原生RECONCILE的空引用拒绝及当前完整前态的无历史拒绝；公开READ/PREVIEW/ROUTE/GUARD/CTS/STATE/EFFECTS；公开RECONCILE缺回执必须无SAP派发。只有RECONCILE只读分支X可以被调用，APPLY与RECOVER不允许调用。独立窗口凭据仅在进程环境，不写文件、不复用共享服务、不修改共享dist。

## 待完成

P0：这两个真实依赖激活及原生/公开只读流程仍待登录执行。P1：ATC customizing HTTP404，质量门未评估；不使用诊断替代ATC。P1：真实KNM新增、正式links/header/协议、配置CTS录制/恢复/清理仍无本次授权与闭环证据；发布登记维持unverified。
