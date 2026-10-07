# r74 具体审阅包：固定 TBE24 原生控制块只读 RFC

实际时间 2026-10-07T16:33:20.240+08:00；状态 Partially Verified（完整本地候选，未部署、未获 SAP 诊断/激活/运行证明）。本方案补 CFG-07 产品 API 保存前所缺的真实控制块，不提供产品启用/停用命令。

## 对象、源与 ABI

- 新父组 ZORVANTA_BTE_CFG：[父组主程序骨架](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-meta-group-20261007-163320-r74.abap)，候选字节 SHA-256 8952f1244589df9b7f1dbbc73f1e5d7c9a04990c87528d6a255b29acb7be438e。[完整 TOP 声明](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-meta-top-20261007-163320-r74.abap)；父组应由标准创建工具生成骨架并重读，不把 FUNCTION-POOL 声明写入主程序，不手工伪造 UXX 函数索引。SAP 创建/注册函数时生成本组 TOP/UXX 等标准依赖，不编辑已存在 BC 组。
- 新 remote-enabled 函数 Z_ORVANTA_CFG_BTE_META：[完整函数源](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-native-meta-20261007-163320-r74.abap)，候选字节 SHA-256 f687afa00958f5808c82626a88ed9ea372181c48eb2a4ad3359a76661715524e。
- [完整 ABI](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-native-meta-abi-20261007-163320-r74.json)；输入/Changing/异常为空。输出 EV_CODE(CHAR40)、EV_MESSAGE(BAPI_MSG)、EV_READ_ONLY(TVDIR-FLAG)、EV_FRESH(TVDIR-FLAG)，三个 typed TABLES 为 VIMDESC/VIMNAMTAB/TVIMF。SAP 参数元数据与 RFC 序列化仍需部署后逐项确认。

对象名称的本次 typed 检索均无匹配；这只说明检索未发现，不是授权充分或 SAP 绝对不存在的证明。部署前必须按准确 URI/原态、活动/非活动及锁重新确认，不覆盖任何已存在草稿。

## 固定行为与错误契约

仅 GR2/client200，固定 TBE24。先标准 VIEW_AUTHORITY_CHECK 的显示动作 S 且 GRANTED_ACTVT=03；读取 TVDIR/TVIMF 固定记录，再通过实际非 RFC 标准函数 VIEW_GET_DDIC_INFO 取一条头及最多200字段控制块，原子性不保证。头必须匹配 BFTM/0090、文本 TBE24T 和实际生成日期时间；目录及事件结束重读，不一致即拒绝。最多64事件；不接受任意表、产品、SQL、执行动作、用户名或传输入参。

成功仅 METADATA_READ_OK；EV_READ_ONLY=X，EV_FRESH 一直为空。SVIX 有原生缓存，此接口不证明缓存新鲜、锁内快照或任何写授权，也不能作为产品 SAVE 的许可。拒绝码 SCOPE_UNSUPPORTED / AUTHORIZATION_DENIED / ROUTE_UNSUPPORTED / METADATA_LIMIT_EXCEEDED / METADATA_INVALID / METADATA_CHANGED / NATIVE_METADATA_FAILED；所有失败表输出为空，异常映射到稳定导出而仅 MESSAGE...INTO 组装原生错误文本，不执行对话 MESSAGE/RAISE。

完整 source 使用 ECC7.31 经典声明，无 7.40+ 构造。只读不存在 enqueue/commit/rollback 所有权；不调用 TABLEPROC/NO_DIALOG/SAVE/handler/CTS API，不修改 TBE24/TBE24T/两类关联或 TCONT。标准权限检查可能生成 SAP 安全审计，这是标准显示权限检查的审计副作用，不能声称所有 SAP 日志绝无写入。

## 已取得依赖证据及剩余风险

VIEW_GET_DDIC_INFO 源/ABI 664862e585d40b9c861723e638889c498140dff3e6cac1ee005e534513c9210f / 7257ed108a4ed78f0d38a458ee51c3c97feb5d68be781715c164cc843fb3dd7a；VIEW_AUTHORITY_CHECK 源/ABI 7d4fd479dbeaead1bd179578506691a1991f9f8372948f86b997832c908c82aa / 18ad8eee7711075432161fd6f58fd997a4d1a7e2702379024482512986c36ef1。实际 VIMDESC/VIMNAMTAB 定义包含92/33字段，CHAR40/BAPI_MSG 已从 w200 读取。原生值及各字段实际 RFC 可序列化尚未运行。

父组相互独立、无客户全局可变请求数据；每次清空导出并只使用本地表。标准 SVIX 缓存被明确暴露为不新鲜，不尝试直接清理/写其私有全局变量。回调事件只返回元数据，不执行。r73 已知产品保存回调 CONTEXT_BUFFER_DELETE_CUS 会调用 update module CONTEXT_BUFFER_DELETE 同步修改 TCONT 时间戳；不在本候选的调用路径，未来保存/恢复审阅必须纳入该副作用。

完整标准子 FORM 调用闭包以及缓存/序列化、拒绝用户、运行时资源上限，尚未有本候选部署运行证据。标准 TVDIR/TVIMF 选择为固定名称；源中 SELECT * 是后续整行一致性比较所需，不是业务数据批量读取。标准授权/原生元数据自身内部读和缓存未由本候选改变；原生内部限制若不能证明，保持不发布。

## 具体审批范围与部署前检查

拟在 w200/200 的 ZABAP 创建并激活上述两个新客户对象，使用既有开发请求 GR2K923472 / 任务 GR2K923492。请求/任务当前状态、owner、层级和可编辑性尚未为此新对象重读；本审阅不把既有请求授权当新对象权限。批准后先重读父组/函数真实存在性、锁、依赖源/ABI和请求任务，任何不一致停止写入并保留结果。SAP 标准对象和其他任务源码保持不变，传输不释放。

仅准备源码/ABI不构成部署授权。需要对象明确批准后，由正常 MCP 管理源备份/锁/保存/激活/读回。已有对象与草稿不得以创建名义覆盖。每次部署回执必须对账，未知结果禁止重放。

## 只读验收预算及成功条件

最多两次正常原生 META 调用，检查实际导出、所有字段/回调、一致性及 EV_FRESH 空；先校验真实源码/ABI。其他不匹配入参仅在公开严格 schema 入口拒绝，不增加 SAP 原生命令。调用前后读固定 ZFICHK 的产品/各语言文本/完整两类关联和实际 CP_INFO 缓存时间戳（其 DDIC/读路径须先确认），配置及缓存保持原值；CTS 仅检查原开发录制及配置任务无新增配置键。不得为测试故意制造标准缓存或业务配置漂移。无法读取必要前态则先暂停验收，不用空值替代。

技术质量按实际 diagnostics/逐对象激活/可用 SCI 与运行读回报告；拒绝用户、多会话缓存/并发和业务运行若未执行保留未验证。不调用产品 APPLY/SAVE/RECOVER、BC Set、handler，不追加/清理配置 CTS，不创建/释放请求，不升级共享服务。
