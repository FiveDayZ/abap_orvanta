# r60：链接前态产品集成及可对账的标准保存/恢复

时间 2026-10-06T09:59:00.652+08:00（Asia/Shanghai）。依据原 CFG01–08 文档、r58完整候选、[r59实际记录](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261006-095900.md)与标准 CTS 实际源码。API-only、单代理，保护当前其他开发与暂存差异。

## 目标与最小交付

完成已批准 EFFECTS 只读验收并把真实前态加入现有不可变证据设施；再准备可审阅的固定 CUNI/T 保存与恢复完整候选。当前 not_started_manual_login_pending，全项目未结束。下一阶段不自动激活 BC Set、不扩大标准配置表或业务写权限。

## 顺序及验收条件

1. 同一固定 r59 构建、同一批准预算完成原生效果读取：2正常/4原生拒绝/4schema拒绝累计，配置/链接/CTS业务写0。保留全原始回执、counts/hash、19官方键范围、profile与四表前态、前后 READ/PREVIEW/ROUTE/GUARD/CTS；异常保留首根因，禁止自动重试。当前部署授权已取得，不重复询问。
2. 原生真值成立后，在现有 ConfigurationBcBeforeStateStore 扩展兼容的、不可变的关联效果前态引用；旧 format1引用仍可读取，调用者不能上传buffer、任意table或篡改绑定。保存配置stateVersion、CTS版本、effectsVersion及body/接口/DDIC身份；保持 recoveryPermit / executable / snapshot=false。共享 ToolService/schema/MCP 注册若需修改，只增本任务最小hunk，保护现有暂存与其他开发；相关接口/无效输入和集成行为必须验收。
3. 从真实 TR_REQ_CHECK_OBJECT 返回逻辑闭合固定 R3TR/TDAT/CUNI、TABU与链接 CTS 对象的 lockable/locktype 路线，确认 TLOCKCIO/CICO 影响是否可达。已读取CICO FORM不能替代真实对象条件。若可达，读取 TRINT_READ_CICO_REQ_LOCKS 及准确前态范围/版本，证明官方恢复能保护已有COMNT与请求锁；不能用全对象注释清空替代恢复。
4. 设计标准CTS精确delta补偿的分段提交：TRINT_DELETE_COMM_KEYS确实调用DB_COMMIT，故不声称单LUW整体原子。本次新增/已有键逐个全身份区分；已有TDAT/CUNI主对象与历史键完整保护；E071K_STR另行确定官方精确路线。每段用同一WriteOperationReceiptStore记录准备、已提交、拒绝、unknown与读回证据；未知结果只对账，不换operationId盲写。
5. 标准配置APPLY候选明确官方auth/enqueue、同表链接号分配序列化、锁内source/target/candidate/metadata/guard/CTS/effects版本核对、必要标准协议/变量/后导入效果与顶层提交；恢复十九键全字段、八个保护键和缺失行，同时对账相关profile四表及CTS/CICO。官方接口无法精确恢复的部分保留明确人工接管，不虚构自动成功。
6. 候选完整并本地检查通过后，提供确切新客户对象、部署差异、系统/client、业务键和值、标准影响、请求任务、命令/改值预算、清理/恢复条件，再申请对应SAP写入许可。用户已授权本地实现/测试及当前读函数部署，这些许可持续有效；整包配置写仍需具体范围。

## 累计进度与依赖

CFG01/05已存在只读对象/IMG导航与人工语义核对历史；CFG02计量单位单字段、CFG03专用号码对象/区间有批准的受控写恢复历史；CFG04目前新增关联前态RFC已部署，完整整包标准保存/恢复仍待闭合；CFG06跨系统只读比较有历史验收；CFG07/08仍待独立动作/业务域需求与真实触发验收。不能以本阶段技术交付宣布全部SPRO自动配置完成。

P1：需要独立窗口手工登录，之后执行已经批准的只读验收。 P1：官方精确CTS键删除独立数据库提交、CICO影响条件与必要标准效果仍是保存/恢复设计约束。P2：真实并发/超限/冲突样本及通用业务域未验收。只在实际不可继续且需要外部输入时暂停对应动作，独立本地准备继续推进。
