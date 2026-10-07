# r58：激活链接前态只读 RFC 完整部署审阅

时间 2026-10-06T09:14:23+08:00（Asia/Shanghai）。Result：**Partially Verified**。完整本地实现及139项相关检查已通过；客户 RFC 尚未部署，原生 EFFECTS 读取尚未执行。本审阅只请求新客户对象部署及有限只读验收，不请求配置值、激活链接、CTS业务条目或请求释放操作。

## 问题与行为

标准 SCPR_HI_ACTLINKS_UPDATE 按 table/view/key 替换旧链接，不按当前 BC Set 过滤；SCPR_HI_ACTLINKS_DELETE_UPD 在旧 BC Set 无剩余链接时会删除其头、变量和变量链接。此前九表十九键配置前态不足以覆盖这些副作用。本接口识别十九键、空 VIEWNAME 的既有数据链接，连同当前 EHS_CUNI_KNM 和这些记录所属的其他 BC Set，完整读取相关四表记录。只读证据不是锁内快照或恢复许可。

## 精确对象与源码

- 新函数：Z_ORVANTA_CFG_BC_EFFECTS，函数组 ZORVANTA_BC_CFG，包 ZABAP，远程启用，非 update task；开发请求 GR2K923472 / 任务 GR2K923492。部署前须重新确认请求开放、owner/client、锁及组基线。
- 完整源码：[ABAP候选](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-effects-20261006-091423-r58.abap)；971行函数体，所有行≤72字符。文件 SHA256 62618aeafcc65fb0d10c369eee22c7e9fe72e713bac793a2d5164bb580e1de08；归一化函数体指纹 f9913506d16864a367b2d66ae3bab4b8b346dfdbb72f38a3e4e904b140217ae9。两者不是尚不存在对象的激活指纹。
- 完整属性、源/接口依赖、DDIC基线与本地执行日志：[证据JSON](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-effects-development-20261006-091423-r58.json)。
- 只允许新增该函数及 SAP 工具为该函数生成的 include/UXX引用。部署前备份并重读已有7函数、组主程序/TOP/UXX。新 include 名称由 SAP 返回，不预设。已有7函数源和接口、TOP及组主程序须保持原值；UXX只能增加新函数的正常生成引用。
- 不修改 SAP 标准对象、MCP共用注册器或当前共享服务，不安装新依赖。

## 外部接口与约束

全部参数为 RFC兼容 STRING、by value、必填；无 TABLES/CHANGING/自定义异常。导入：IV_BC_SET、IV_VERSION、IV_REQUEST、IV_TASK、IV_CTS_VERSION。导出：EV_CODE、EV_SYSTEM、EV_CLIENT、EV_USER、EV_REQUEST、EV_TASK、EV_CTS_VERSION、EV_SCOPE_VERSION、EV_EFFECTS_VERSION、EV_ROW_COUNTS、EV_PROFILE_COUNT、EV_DATA_BASE64、EV_DATA_BYTES、EV_ROUNDTRIP。

输入固定 w200/GR2/200、EHS_CUNI_KNM/N、配置请求 GR2K923429 / 任务 GR2K923430。IV_CTS_VERSION 为服务端既有不可变前态中提取的64位小写 SHA256；调用者不能提供原生缓冲、表名、profile列表或执行许可。内部适配器复用 ConfigurationBcBeforeStateStore 与既有命令引用 schema，不新增存储或通用工作流。

原生函数检查四表 S_TABU_DIS/03，使用当前 DDIC 的十九键结构和 SCPR_HI_KEY_TO_ACTKEY；再把返回键与本次字符键长度/值比较，以拒绝标准全局描述器缓存变化。保留 lowercase 与固定空格。匹配 SCPRACTR 的空 VIEWNAME 表级链接，读取最多32个相关 profile，matched/records/headers/variables/links每类最多512行。每次 SELECT最多取513行作为超限哨兵；超限拒绝整包结果，不返回截断成功。FAE前有非空和数量检查。

排序采用实际主键。匹配记录必须与完整关联表的整行值相同；两轮完整读取之间原生序列化字节必须相同，各轮前后 CTS 版本必须相同；原生 IMPORT/EXPORT须等值。缓冲最多524288字节。Node校验数量、canonical base64、字节长度、SHA256、用户/client/task与固定scope，再次核对全部源/接口/Include/DDIC。标准依赖11项、组FORM Include1项、DDIC18表；每批最多4个读取。发生错误或变化拒绝并保持最多一次适配器原生派发，不自动重试。

本接口不取得业务锁，两轮顺序读取不能证明没有 ABA 或后续变化。返回 snapshot/executable/activationAvailable/recoveryAvailable/currentStateRechecked/ctsRecoveryChecked=false，buffer.recoveryPermit=false。完整范围指上述已识别相关profile四表，不是所有 CUNI / 所有 SPRO。

## 实际检查与原生验收方案

本地139个独立测试全部通过：首轮138通过、1项因私有目录缺历史fixture失败；补齐真实fixture后只重跑该项通过，未削弱断言。类型/私有构建、三文件格式、headless检查通过。模拟字节只验证适配器；不作为 SAP序列化或业务验收。37次实际元数据读取确认11项标准依赖、18表布局及19键字段顺序、7客户函数基线一致；新函数确实不存在。

在获得该新对象部署批准后：

1. 重新读取活动源/锁/请求状态，保存不可变客户组备份；按完整候选新增函数、检查真实回执、激活/诊断并读回，不因假阴性诊断忽略真实HTTP错误。
2. 私有固定构建中捕获 READ/PREVIEW/ROUTE/GUARD/CTS/STATE 的新鲜只读前态；保存服务端不可变引用。仅 EFFECTS 最多2次正常调用（含必要修补后重验），新函数原生拒绝最多4次（BC Set/版本/任务/过期CTS），本地schema拒绝4次（跨连接、缓冲、表名、execute）。不重新消耗已经关闭的 RCHECK 预算。
3. 正常返回须证明绑定、5类真实数量、完整关联范围、原生 roundtrip与哈希；调用前后只读观察配置/CTS及7兄弟函数。拒绝路径不得返回缓冲或有写副作用；超限、关联profile或缓存/并发变化按真实观察拒绝，不伪造样本。
4. 不激活/模拟 BC Set，不调用任何维护/删除/追加CTS函数，不释放传输；配置/CTS业务写次数均0。相关profile可能包含其他BC Set，仅四表只读；其变更必须另立完整授权范围。

## 未完成与下一阶段

P1：新函数部署、ECC7.31原生语法/加载和上述真实验收未执行；标准保存/恢复、链接分配owner锁及精确CTS补偿未闭合。P2：原生测试尚不覆盖真实超限/并发、FLTP极值、初始D/T与字符串CTS键，函数组诊断漏报根因尚未确认。当前工具没有公开注册新调用，也没有放开 APPLY/RECOVER。[r59任务与验收](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-standard-command-plan-20261006-091423-r59.md)。
