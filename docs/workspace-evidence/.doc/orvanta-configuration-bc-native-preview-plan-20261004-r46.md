# r46：标准 BC Set 转换与五表差异预览

2026-10-04T22:15:06.321+08:00；依据r45实际原生前态。全SPRO尚未结束，继续API-only。

## 当前进度与依据

| 文档项 | 已有实现/证据 | 尚未关闭 |
| --- | --- | --- |
| CFG-01/05 | T006/A描述器、定向活动/路径/文档及CTS检查已具名验收 | 不代表整棵IMG或所有配置域 |
| CFG-02 | KG中文MSEHL保存/恢复、配置行键录制及只读对账已具名验收 | 仅指定单位文本；并发/错误提交与更广单位维护未全验收 |
| CFG-03 | ZORVCFGNR原生读取、01更新及02创建、回读/未知回执保护 | 当前只支持限定未用区间；旧写预算耗尽，年度/子对象/在用迁移等未关闭 |
| CFG-04 | 五表来源、清单与本次10缺失keys+完整PRESS前态 | 标准转换、完整差异、受控激活/后导入/日志/CTS/恢复未完成 |
| CFG-06 | 同键跨系统reader/比较及schema已实现 | 登记仍有unverified项，真实范围/失败条件需逐项核对，不能以登录成功代替 |
| CFG-07/08 | 增强审计与workflow已有基础 | 独立配置动作、组织/业务域及真实触发验收未关闭 |

详情沿用原实施backlog与不可变阶段记录；不将原文中的拟议接口视为已存在功能。

## 目标与最小交付

1. 固定EHS_CUNI_KNM/N来源版与r45目标版，完成标准转换调用图/字段描述/异常和全局状态分析，先阅读不调用激活或模拟。
2. 在SAP原生类型中生成只读候选after rows及逐字段差异，明确来源client001到目标200、三语言1/D/E、固定键/变量键规则。source omitted字段的标准全行替换结果必须显式展示；不凭“patch”标签假定保留。
3. host MCP preview复用r45快照/回执保护；source与target两个版本共同绑定。明确alias碰撞及共享PRESS现值，失败/未知转换/动态越界/截断/漂移时不输出可执行候选。
4. 只读转换通过后才准备激活命令的完整before/after、所有keys/语言、覆盖规则、正确开放Customizing任务、CUNI后导入、持久化/日志/CTS边界与恢复清单。保留其独立审批门槛。

## 已实际准备的标准 API 依据

- SCPR_CPROF_CT_PROFDATA_CONVERT：完整249行，non-RFC；typed PROFVALUES/SCPRVALS、TABLEDESCR/SCPR_FLDDESCRS，LINE/RAW_XRECORD为未定型输出，不能作为通用外部RFC直接代理。实际需要currkey与外部到内部转换委托。
- SCPR_CT_CURRKEY_GET（176行）：有字段描述和动态基础表读取路线；必须先证明本五表字段是否触发该分支，不能假定只在内存计算或任意开放查询。
- SCPR_CT_VALUE_CONVERT_EXT_INT（149行）和SCPR_CT_VALUE_CONV_EXT_INT_STR（110行）：委托 SCPR_CT_DECDELIM_CONVERT_ONE、RS_CONV_EX_2_IN_NO_DD、SCPR_CT_CURR_CONVERT_EXT_INT；下一步补齐实际接口/源与描述类型，禁止JS通用数值转换。
- CTO_ORDER_GET_METHOD_CALLS（269行）：non-RFC；从OBJM等解析方法，包含ENH_UNSET_GENERATED条件调用；仅阅读不调用它来“试探”，CUNI实际动态方法仍待证实。
- 以上均未执行；来源快照与读到的标准源保存在r45证据中。

## 验收条件

- 原生转换处理1-/2-、1.000、0,000000及FLTP，不依赖显示值反算；三语言键与别名key精确、客户端200显式。
- 五表before/after/新增/变化/原值逐行核对，PRESS共享影响及source omitted字段明确；禁止隐藏类型/转换/变量/通配/孤立source行。
- 两源/目标版本漂移及元数据漂移拒绝；本地协议/错误/边界回归和公开固定构建只读正例通过。真实非空float、无权限/并发覆盖不足时继续明确标记未验证。
- conversion链无配置、日志、CTS、副作用或commit；若不能证明，维持preview blocked，继续独立分析。

## 依赖与授权

- 原生前态已实现，本阶段缺失的负例不因下一阶段开始而关闭。
- 标准源/接口/DDIC只读调查、host协议与本地候选准备沿用现有开发/测试授权，可继续。
- 若需要新增只读客户桥接RFC，拟议对象为 **Z_ORVANTA_CFG_BC_PREVIEW**，现有group **ZORVANTA_BC_CFG**、包ZABAP、请求GR2K923472；必须先完成实际依赖验证和可审查源/接口，再按根AGENTS.md第6节“Modify only an explicitly approved Z* or Y* customer object in the current task”取得该新RFC的对象级批准。r45对READ的批准不含它。
- 本计划不申请或授权BCSet activation/simulation、KNM创建、别名或PRESS改值、CTS配置行录制、任何业务执行、传输释放或共享服务重启。之后配置写另给具体申请，既有KG描述录制批准不覆盖新keys。
