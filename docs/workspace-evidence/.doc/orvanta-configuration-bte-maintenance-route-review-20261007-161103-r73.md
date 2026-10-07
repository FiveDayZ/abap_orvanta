# r73：BTE 产品维护路线及写入前置证据

时间 2026-10-07T16:11:03.938+08:00，w200/200/WYS，ECC 7.31；状态 **Partially Verified**。本阶段依据 r73 最终 STATE 收口计划推进 CFG-07，仅本地实现和 SAP 只读调查。

## 已实现

新增公开只读工具 `inspect_configuration_bte_maintenance_route`，输入仅 connectionId=w200、maxProducts=2..200（默认 100），client 固定 200。以实际 DDIC 布局及标准 API 源/ABI 为前提，读取固定 BF24 的 TSTC/TSTCP、TBE24 的 TVDIR/TVIMF 和客户产品清单；不接受任意表、事务或执行参数。

- 两轮数据读取必须一致；元数据在第一轮前、第二轮前核对。结果明确 atomicSnapshot=false，不把读取一致视为锁内状态。
- 仅识别 `/*SM30 VIEWNAME=TBE24;UPDATE=X;` 的等价字段顺序；额外、重复、其他参数返回未确认，保留原观察。只有 TSTC/参数/TVDIR 同时满足固定标准路径时报告观察到 BFTM 路线。
- 维护事件最多 64 行；截断、重复键、错误范围拒绝。产品清单截断明确 complete=false，不能据空候选断言系统没有 Z/Y 产品。
- 返回已有 Z/Y、最多 8 字符的产品候选；公开产品预览另读完整 TBE24/TBE34/TPS34。所有 executable/writeAvailable 始终为 false。
- ADT 仅在已知精确空 HTML 错误时采用源/ABI 均已钉定的 RFC_READ_TABLE；没有放开通用表白名单或通用 RFC 命令。

## SAP 实际源码发现及覆盖

以下“完整取得”表示各分段保存同一完整源指纹；静态重点核对控制块、数据/文本、保存、权限/锁和 CTS 路径，不能替代业务执行。

| 对象 | 完整取得范围 | 已确认含义 |
| --- | --- | --- |
| BFTM / LBFTMTOP / LBFTMT00 | 1–40 / 1–28 / 1–185 | 包含 TBE24 状态、0090 屏幕及 TBE24T；实际 TVDIR 绑定仍待新工具实测 |
| LBFTMF00 / LBFTMF01 / LBFTMCHK | 1–370 / 1–619 / 1–36 | 主表采用通用 LSVIMFTX；TBE11 回调含 BC Set 分支，不能视作 TBE24 已绑定回调 |
| TABLEPROC_BFTM | 1–9 | 非 RFC，委托 FORM tableproc |
| VIEW_GET_DDIC_INFO | 1–886 | 非 RFC，生成 VIMDESC/VIMNAMTAB，带 SVIX 缓存和 TVIMF 回调映射 |
| VIEW_AUTHORITY_CHECK | 1–413 | 标准表权限及组织范围逻辑；包含审计调用；未调用授予写权限 |
| LSVIMFXX / LSVIMFTX | 1–310 / 1–1494 | 动态 TABLEPROC、原表/文本表维护及标准 TABLEFRAME/TABLEPROC 分支 |
| LSVIMF45 / LSVIMF0U | 1–819 / 1–206 | TOTAL/EXTRACT 的类型、长度、Unicode/文本字段和状态初始化；调用低层维护接口 |
| LSVIMF14 / LSVIMF13 | 1–413 / 1–51 | 保存前 CTS、保存后文本/回调/同步器；不能把外层函数名当无副作用证明 |
| LSVIMF1W / LSVIMF1S | 1–461 / 1–778 | 键录制包含文本、请求选择、CTS 原语言检查和错误消息路径 |

VIEW_MAINTENANCE_NO_DIALOG 的实际源/ABI 钉定保持 r72 证据；本阶段 route 工具会重读身份，但未调用标准维护。LSVIMFTX TABLE_DB_UPD 499–749 会根据独立动作标记更新原表和文本表，因此仅提供 TBE24 行不足以构造可靠 TOTAL/EXTRACT。LSVIMF13 10–32 会进一步调用多语言文本更新、AF_SAV 回调和同步器。

LSVIMF1S 392–396、525–529 的 TR_EC_CUST_ORIG_LANG 明确传入 iv_dialog='X'；还包含 TRINT_ORDER_CHOICE、MESSAGE 和异常路径。是否在给定请求/产品/原语言分支触发，尚未实测。不能宣称 API 路线已完全无对话，也不能为绕过该分支修改标准源。

## 写命令候选的契约和当前缺口

候选业务动作限定“设置一个既有 Z/Y 产品 AKTIV”。未来命令需绑定 w200/200、完整产品/文本/两类关联前态、实际源/ABI、明确配置请求和任务、独立操作 ID；server 端权限及锁内版本一致后方可维护。RFCDS、产品文本、Event/Process 关联与其他产品保持原值，产品注册/handler 创建/业务执行保持独立动作。

失败必须区分已拒绝、已回滚与结果未知；未知结果先只读对账，不能重放。恢复只能比较已批准目标，恢复本次 AKTIV 并清理本次新增 CTS 键，保留旧键、审计和历史未知回执。此契约不是已存在的执行 schema 或 SAP 客户源码。

尚缺 native 控制块实际值、实际 TBE24 事件绑定及其调用闭包、标准 CTS 无对话和提交边界、跨调用状态初始化、目标产品/文本完整前态。**本阶段没有编造占位写 RFC，没有生成或部署可执行保存候选，也没有申请宽泛对象写权限。** 下一阶段先补证据，再交付完整具体源码/ABI 审阅包。

## 验收与故障留证

本地新模块 11 项规则测试、1 项真实 SDK 契约测试，加产品/协议/服务/配置档/验证注册表回归共 230 项通过；BC 回归 460 项通过，合计 690。SDK 契约测试使用服务替身，不是 SAP 集成证明。格式、headless、两项矩阵检查和私有目录 TypeScript 编译通过。

初次 scoped 回归失败为工具名称排序和隔离注册表未复制；BC 初次两轮失败为隔离历史附件/fixture 缺失。保留原始退出码及日志，补齐实际附件后通过，没有吞错、弱化断言或修改 BC 行为。

SAP 只读已确认源码和 DDIC，不等于新工具有数据运行。固定构建登录仍待完成，公开路线/客户产品预览待实际验收。函数源码读取失败：TBE24 where-used 返回 RESOLUTION_INCONCLUSIVE；TDDAT 透明表工具返回 OBJECT_TYPE_MISMATCH，实际表类别未确认。已在 .logs 记录并回传用户，没有把错误推断为对象不存在或无引用。

## 范围和保存证据

保存 39 个源片段/函数接口证据及全部 DDIC 原始回包：[r73 证据](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-maintenance-route-evidence-20261007-161103-r73.json)。共享服务 PID 60128 和 dist 的 230 文件保持不变；七个修改文件移除本阶段 AST/注册项后，SHA-256 精确匹配阶段初态；其余原有文件、暂存和 HEAD 均保留。新增工具仅在本地源码和私有固定构建中，未升级共享服务。没有 SAP 对象、配置、CTS 写或传输释放。
