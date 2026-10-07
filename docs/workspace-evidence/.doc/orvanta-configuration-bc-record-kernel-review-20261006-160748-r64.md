# r64：CUNI 逐行与批次标准维护内核候选审阅

2026-10-06T16:07:48.376+08:00，Asia/Shanghai；w200 / GR2 / 200。Result：Partially Verified。

## 交付范围与整体进度

承接 r63 已实际读取的 %_CSCPR 和真实标准接口，本次交付可嵌入客户函数组的私有 Include 候选 ZORVANTA_CFG_BC_RECORD_KERNEL，含准备、错误保留、逐行暂存、十行批次暂存四个 FORM，以及内部原生行证明计划器。已实现保存/删除的标准 API 调用代码，尚未部署或运行；不是完整 BC Set 激活，也没有新增远程入口或宣称恢复可用。原 r64 的完整 APPLY/RECOVER/CTS/关联/协议目标尚未全部交付，剩余工作由 r65 继续。

[完整候选源码](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-record-kernel-candidate-20261006-160748-r64.abap)，原生源码候选 SHA256：ebbb5c52d63170864eb16009a1b76b721a0f11471279bfd00649a27b41fe0c22。[本次证据](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-record-kernel-evidence-20261006-160748-r64.json)。

原始 backlog 的 CFG-02/04 完整闭环仍未收口；原有计量单位文本维护、号码范围、导航及只读比较不在本轮重写范围。CFG-07/08 本轮未实施，也没有宣称全部 SPRO 活动可自动配置。API-only 与现有固定系统/请求边界保持。

## 内部输入、输出与行为

- prepareConfigurationBcRecordPlan 接受已认证且由不可变回执取得的绑定，以及 SAP 原生十九键的存在性/整行散列。拒绝外部恢复字节和 JS 字段值、异用户/异版本、重复/越界键、KNM 现存行、缺失目标行、保护键变化。该函数不会读取或写 SAP，不能替代外层的真实 source/layout/guard/CTS/effects 校验。
- 固定 T006 KNM 一行，T006A/B/C 的中文/德文/英文各三行，共十个可维护键；T006D/PRESS 加八个关联键，共九个保护键。历史前态和本地回放为8现存/11缺行，本次没有重新读取配置现值，执行前必须锁内 fresh。
- orv_bc_record_prepare 绑定实际 SCPRRECA 的 EHS_CUNI_KNM/N、RECNUMBER=1、CUNI/T、空 activity/delete/genref 等字段，检查固定业务键，读取标准 TYPE_GET/FIELDDEF_GET。直接拒绝 TABLE_UNSUITABLE；完整字段顺序、Unicode 字节长/连续字符键、未缩减描述器、client 字段、readonly/不支持类型/官方 FKY/USE 标记逐项校验。显式补充 OBJNAME/OBJTYPE/ACTIVITY，不依赖集合工厂的未填字段。
- 全行/删除键分别经过标准 INT_EXT 与 PROFDATA_CONVERT；EXPORT 原生字节相等才返回 RECORD_PREPARED，拒绝 FLTP/空格/类型的有损转换。恢复首个试点的十个新增行采用严格 DELETE 键；不声称支持恢复任意已有行。
- orv_bc_record_stage 每行重新准备并比对整个 prepared 结构，检查服务器用户/系统/client、无对话/无模拟/NO_COMMIT/ACTLINKS=W，并检查对应表的02权限。保存要求当前不存在；删除要求当前整行等于批准候选。仅调用 SCPR_PRSET_CT_ONE_TABLE_LOAD，随后用标准 RECORDS_GET 验证完整值/缺行；读错误、维护错误和读回失败分别停止，保留第一批标准错误及消息字段。
- orv_bc_records_stage 检查恰好十个唯一 ordinal 和一致模式，第一遍准备全部行后才初始化标准关联全局集合/服务器时间并进入第二遍维护；删除按10至1倒序。返回已暂存数和失败 ordinal，成功码 BATCH_STAGED，绝不返回 APPLIED/RECOVERED/COMMITTED。它仍需要外层完整锁、九保护键前后核对、正式关联/变量/header、CTS、协议、提交及回执所有权；失败可能已暂存部分行，必须由外层回滚/重读。

## 实际标准源与所有权边界

本次通过共享4849公开 SDK 读取 21 份标准源/接口/搜索结果；不是执行这些标准维护函数。十份 ABI 原始定义及 r63 实际 SCPR_RECORD2 声明已保存成独立测试夹具。SCPR_ACTIV_MN_ACTIVATE 的2674行已读取，但本次只审阅相关目标段及依赖，不声称整个标准调用图已闭合。

1. 集合工厂 SCPR_PRSET_DB_FLDDESCRS_GET 隐藏 TABLE_UNSUITABLE 且未填记录对象身份，因此内核直接检查 FIELDDEF 的异常并显式绑定身份。
2. ACT_ID 的真实 DDIC 是 SCPR_HANDL（32字符 GUID 容器），不是 BC Set ID。候选只要求外层提供非空服务器激活句柄并匹配用户/系统/client，GUID 创建与持久化关联仍属外层任务；未猜造一个字符串当激活 ID。
3. SCPR_HI_ACTLINKS_UPDATE 会在 LSCPRHIF01:274–327 读取每个表的旧 links，取现存最大 TABRECNUMB 后逐一分配，并移除相同 view/key 的旧关联。必须对整个分配范围及旧关联所有者进行保护，十九业务键的只读版本本身不够；不得复制成客户 MAX+1 分配。
4. LSCPRHITOP 的 g_linkdescrs 是按表缓存的描述器，SET_GLOBAL_ACTOPTS 只清两份临时关联集合。外层需证明会话/缓存与 DDIC 版本一致并核对精确关联键，不能把设置 options 当完整 cache reset。
5. 高层激活还写协议、运行分发框架、处理内部锁及 after-import；协议和部分 CTS 清理具有独立提交。NO_COMMIT 不代表全部副作用原子回滚。本候选没有绕过这些必要效果来发布假的正式激活/自动恢复。协议保留并作为分阶段证据，不删日志掩盖历史。

## 本地验证与限制

完整 TypeScript 隔离编译、31项相关测试、格式和 source-only headless 检查通过。31项中12项为本次内核/实际ABI/类型池契约，11项为命令对账，8项为前态准备。测试覆盖真实缺陷边界；生成源码结构检查及 ABI 对照不能代替 SAP 编译、激活、锁行为或真实维护。

早期负例夹具被 TS 误推为只允许受支持表名，TS2322 已通过仅扩大测试夹具 tableName 类型纠正；私有目录首次缺两份历史回放文件导致 ENOENT，已原样复制到私有目录，不修改生产路径/断言。源码实现过程中还依据实际常量纠正了字段 flag，最终复用官方描述器的 FKY/USE，而非自造单字符标志。

没有发布新命令、重启共享服务、写 SAP 源码、配置、CTS、释放传输或提交 Git。公开 read_configuration_bc_effects 的独立 SDK/SAP 集成验收仍待完成，其登记不变。

## 下一阶段

按[r65计划](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-native-owner-plan-20261006-160748-r65.md)继续完成完整外层 owner 和审批包。此 Include 不单独申请部署，也不单独调用。只有客户对象、必要效果、标准提交边界及精确配置/CTS预算全部形成可审阅候选后，才提出具体 SAP 写入批准。
