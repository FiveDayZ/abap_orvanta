# r50：九表版本绑定的激活预检与具体执行契约

编制：2026-10-05T12:28:50.312+08:00（Asia/Shanghai）。这是后续计划，不是完成或执行批准。

## 当前进度与前提

r49 新增客户只读 RFC Z_ORVANTA_CFG_BC_GUARD 已创建并激活，原生源码/接口与 r48 候选匹配；原函数组 main/TOP 与 READ/PREVIEW/ROUTE 未变，仅系统生成 U04 和 UXX 两行追加。开发任务 GR2K923492 仍在批准请求 GR2K923472 中。新八键 SAP 正例仍待独立窗口登录；登记保持 unverified，不把诊断清洁当运行成功。

先完成已批准 r49 验收：四个 native 拒绝、两次公开八键完整值/命名缺失、四项 schema 和两项 stale 拒绝、五表与路线前后相同；冻结构建不变，不追加登录/改值预算。详细方法沿用 r49 计划和冻结脚本。

## 目标与最小交付

在八键验收证据成立后，复用现有 READ、PREVIEW、ROUTE、GUARD 和 receipt 设施，将五表 11 个源键与四表 8 个关联键组成**明确的固定保护范围**，与 BC Set source/target/candidate、CUNI metadata 和 native guard 版本同时绑定。不是 CUNI 全行覆盖，不因总计 19 个固定键就推断没有其他单位或业务影响。

形成只读激活预检契约和一次具体可审阅执行申请：活动 EHS_CUNI_KNM/N、w200/GR2/200、语言 1/D/E 的来源及选择、CREATE_INITIAL_OR_UPDATE_USE 的 before/after、保留 omitted 字段、共享 PRESS 和 KPA 关联行保护、准确维护 API、锁内重读、明确 Customizing 请求/任务与真实键、标准 API 各提交点、部分/未知结果、只读对账和可执行恢复清单。未完成这些事实时 executable/activationAvailable 保持 false，不自动调用 simulation。

## 实施与验收条件

1. 先核对 r49 实际存在/缺失与当前权限；完整五表 before 行、native candidate、metadata 和 guard 需在同一固定 scope/身份下前后复读，任一漂移或缺数据撤回整个预检，不能仅撤一张表。
2. 将九表保护与将改变的五表候选分开呈现。检查 MANDT/CLIENT、SPRAS/LANGU、ISO KPA、共享 PRESS、语言占位来源和 native USE/FIX/VAR 比较；missing 是观察事实，不是允许创建或绕过业务校验。
3. 依据实际源继续明确 SCPR_ACTIV_MN_REMOTE_SUB → SCPR_ACTIV_MN_ACTIVATE → SCPR_PRSET_CT_IMPORT_INDUSTRY 的头less分支、AUTHORITY/锁、更新任务、CTS 与独立日志提交；记录内存/函数组状态初始化与清理。r49 已刷新 ACTIVATE 2674 行及 CT_IMPORT_INDUSTRY 1205 行完整接口源，但源码取得与模式关键字列表不是整个调用链已审查证明。
4. 真实 OBJM 当前为 0；不虚构“已发现 CUNI 方法”，预检/执行前仍须重查方法集和 9 个成员。方法变化撤回计划。NO_COMMIT 不等于独立日志或后导入方法事务原子；不使用通用动态 SQL 或任意方法回退。
5. 本地增加能检出实际缺陷的版本/身份/保护范围/未知恢复拒绝及真正 MCP 契约测试。新客户命令只准备完整接口/源候选；给出精确对象、配置/CTS/日志作用及恢复预算后，再按已有对象与业务写授权边界申请，不自动释放传输。

## 依赖和后续文档收口

- P1：r49 八键真实只读正例需一次人工登录，当前窗口已打开；不能以本地测试替代。
- P1：整包激活、模拟、日志和配置 CTS/恢复没有具体预算；标准路径独立日志提交、部分结果和锁范围需要可审核证据，不能承诺通用 rollback。
- P2：CFG-06 双侧变化/失败实证及 CFG-07 独立启用/业务触发；P3：CFG-08 明确业务域、组织键、业务规则与维护 API。继续按原 backlog 逐项收口，不将当前单场景等同所有 SPRO。

坚持全部 API，保留共享服务、默认 dist、原暂存和其他开发对象；不扩通用白名单，不使用 GUI。后续纯本地预检准备沿用现有开发和 AI 技术测试授权；真实 SAP 配置执行仍须具体范围。
