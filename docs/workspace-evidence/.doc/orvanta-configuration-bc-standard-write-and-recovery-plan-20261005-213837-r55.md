# r55：标准 API 写入、锁内前态与恢复候选

时间：2026-10-05T21:36:22.442+08:00。承接 r54；总体 SPRO 需求未结束。依据原始 backlog 与当前实际证据主动规划，本计划不扩大 SAP 对象、配置、CTS、独立效果、测试改值或发布授权。

## 当前进度与本阶段边界

| 工作包 | 已有记录与 r54 新证据 | 尚缺验收 |
| --- | --- | --- |
| CFG-01/05 | 已有定向 DDIC/IMG 活动及维护路线；r54 未改该功能 | 全量对象/权限/语言/分页边界 |
| CFG-02 | 已有 KG 中文描述保存、恢复、CTS 与回执对账样例 | 其他配置维护 API、原生并发与失败、完整闭环 |
| CFG-03 | 已有号码对象与区间创建/更新样例及当前号保护 | 其他年度/子对象/并发边界；不自动扩大在用号码维护 |
| CFG-04 | 九表十九键 READ/PREVIEW/ROUTE/GUARD/CTS/预检已有证据；r54 新增真实 STATE 原生往返、不可变引用及内部准备接口 | 真实无对话 APPLY、锁内再读、准确录制、日志与独立效果、RECOVER |
| CFG-06 | 保留已有跨系统读和比较记录 | 双方稳定业务键、真实漂移、单侧失败完整验收 |
| CFG-07 | 保留已有增强审计 | 分动作运行配置、激活/停用、真实业务触发 |
| CFG-08 | 按原文需求驱动选择一业务域 | 具体域、组织维度、依赖与业务方触发验收；未选择前不建任意表写入口 |

r54 原定完整 APPLY 候选仍未闭合；本次实际交付是只读前态运行验收、内部命令准备及长响应保护修复，不将其描述为可执行写入或完整 SPRO。首次公开调用服务端完成但客户端超时；同一冻结实例第二次公开调用返回完整结果。新 HTTP 修复未部署到该实例。

## 目标与最小交付

1. 优先闭合固定 EHS_CUNI_KNM/N、w200/GR2/200、配置请求 GR2K923429/任务 GR2K923430 的标准写入 owner；继续复用 WriteOperationReceiptStore 与当前不可变引用，不新增通用 workflow、任意 SQL、外部恢复字节或 GUI。
2. 已读并确认 SCPRACTOPT 28 字段，LSCPRACF01 的 FILL_ACTIVATION_OPTIONS 239–367 行；answer_yes='Y'、answer_no='N'、pcat_classic=' '。非对话 activation_type 非 0，COMPLETE_ONLY=1、SAFETY='Y'、TRANSPORT_OFF/SYSEDIT_OFF='N'、NO_COMMIT='X' 等仅为候选选择，必须继续证明对既定路线及所有下游分支的效果，不能仅凭填值开放执行。
3. 定向读取 SCPR_PRSET_CT_ONE_TABLE_LOAD、IMPORT_INDUSTRY 的实际 T/L/U 分支、VIEW_BCSET_IMPORT/VIEWCLUSTER 路由（仅若本目标可到达）、CTS owner 与 after-import/变量历史分支。读取当前 DDIC、权限和锁接口，追踪配置写、任务选择、update task、ON COMMIT/ROLLBACK、异常、ABAP memory 和函数组全局清理。
4. 明确 E_SCPR 的 BC Set 锁、E_TABLEE 的表/client 级锁与 DEQUEUE 的实际范围、E_TRKORR/CTS 锁获取与释放。证明外层锁内 STATE 再读及标准 API 不会提前释放保护；否则调整权威所有权点，不能把 r54 的 lockedSnapshot=false 改成 true。
5. 对 11 个当前缺行和 8 个现存行构建恢复语义：标准 API 怎样恢复原始类型/初始值/FLTP/语言键，怎样删除本次新建行，怎样只恢复新增 CTS 而保留原根中所有无关条目。找不到可证明的标准补偿路线时阻止该写候选，不能改成直接 SQL 绕过。
6. 形成完整 APPLY/RECONCILE/RECOVER 客户桥候选、接口、拒绝/未知/重复接管回归及具体审阅包。回执只由现有 WriteOperationReceiptStore 管理；超时后核对实际值/CTS/锁/独立日志，禁止自动重放；恢复与释放分别保持独立授权。

## 提交与独立效果必须处理

- SCPR_ACTIV_MN_ACTIVATE 中 NO_COMMIT 约束其主 COMMIT；SCPR_ACTIV_PROTOCOL_WRITE 有 COMMIT CONNECTION R/3*，不能回滚该独立协议。
- FRAME 的结束路径到 LSCTMF01 LOCAL_START、SCDC_DISTRIBUTE_TABLE_KEYS；特定释放状态或 GUID 分支会调用 DB_COMMIT/WAIT。必须证明当前调用路径是否可达，不以请求当前 D 状态替代证明。
- SCDC_GET_WORKPLACE 会写 SCDTSYNC 并调用远程 RFC，不能当纯只读解析器直接试运行。
- IMPORT_INDUSTRY 在加锁前已有历史/标记操作；配置、CTS、协议、分发和内存生命周期必须逐项说明。最终采用可证明的事务或分阶段提交/补偿契约，禁止声称全链路原子 rollback。

## 验收条件

- 本地和公开协议：拒绝外部缓冲、错误用户/client、错误/过期来源与引用、漂移、无批准预算；不预约写回执、不执行标准维护的拒绝路径可证。
- 锁内拒绝/失败/超时：未开始、已提交、部分、未知分别有完整证据；当前值等于 before 不能推断历史从未写入。
- 精确批准写成功后才可标记：十九键完整回读、八保护键和共享 PRESS 不变、正确配置任务与完整 CTS、锁释放、独立协议和分发效果已对账。
- 恢复真实运行要证明原始类型与缺行复原、CTS 无关条目保留；恢复批准不能由读取前态推导。请求不自动释放。

## 依赖与顺序

目前 STATE 只读运行依赖已满足，原生写命令仍缺标准锁/提交/补偿完整候选及具体写批准。先完成独立可审阅候选和本地测试，再申请准确客户对象部署及一次配置/CTS/独立效果预算；等待审批期间推进 CFG-06 的只读稳定键/单侧失败和 CFG-07 的标准动作调查。新 HTTP 修复在下一个必要的新冻结验收实例中一并验证，不为已成功的只读样例额外重复登录。单次完整 STATE 公开请求本次约 12 分 26 秒，保留准确指标，后续只做请求内共享元数据/范围的性能优化且保持全部再读及身份校验。ATC 404 与未覆盖原生边界保持明确限制。

## 范围校正

2026-10-05T21:38:37.317+08:00 独立交付核对：FILL_ACTIVATION_OPTIONS 的实际 FORM/ENDFORM 为 239–367，235–399 是本次完整读取块。先前计划将范围末行写作 376，包含例程后的注释；此版本替代 [orvanta-configuration-bc-standard-write-and-recovery-plan-20261005-213622-r55.md](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-standard-write-and-recovery-plan-20261005-213622-r55.md)，原件保留。仅校正文档，代码、验证结论及授权边界不变。
