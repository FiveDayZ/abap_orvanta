# r75：BTE 产品保存/恢复 API 的完整候选

2026-10-07T17:05:53+08:00；依据原SPRO backlog CFG-07、r73维护路线及r74实际源码/接口/控制块范围。全SPRO尚未完成，沿用现有授权，不等待用户再提醒规划。

## 目标与最小交付

1. 先完成当前r74固定构建最多2次只读正例，核对VIMDESC92字段、VIMNAMTAB33字段实际序列化、EVENT02→CONTEXT_BUFFER_DELETE_CUS及可见回调映射；产品/各语言文本/两类完整关联/CP_INFO/配置CTS前后保持。native header含缓存，EV_FRESH空，不作为写许可。
2. 根据真实元数据继续闭合 VIEW_MAINTENANCE_NO_DIALOG→BFTM TABLEPROC 的无对话输入、权限、enqueue、TOTAL/EXTRACT/语言文本actionflags、TR_EC_CUST_ORIG_LANG/CTS交互和commit流程。精确读FORM/接口/表/锁，不能从GUI状态复制FORM为RFC。
3. 准备独立产品 AKTIV 保存与恢复完整候选/ABI和MCP preview→prepare→approve→execute→reconcile/recover契约，限定一个已有产品及仅AKTIV。锁内重读完整前态/源码/ABI、产品及文本/关联保护、键级CTS归属、单提交、未知回执对账，不重放。若标准无对话/事务副作用不能证明则保持执行关闭并明确缺口，不用直接UPDATE替代。
4. 缓存回调会同步修改TCONT时间戳，必须声明并设计失效语义；恢复原产品不恢复旧时间戳、不把缓存更新等同业务验证。已有事件00001025关联及handler不执行，真实业务验收由业务负责人另行安排。

## 验收与授权依赖

最小本地交付必须有完整源、ABI、原native调用闭包证据、可审阅完整实际值、保护范围、恢复清单和有区分力的故障/重复/超时/漂移测试。新SAVE/RECOVER客户对象需要按实际名称审阅后的对象部署批准；实际产品启停/配置CTS录制/恢复或清理需要完整实际值和独立命令预算。现阶段可持续实施本地候选与只读调查，不要求重复通用开发/测试批准。不得释放请求或升级共享服务。

CFG-07后续还需产品注册/关联更改、CMOD/BAdI/规则与组织作用域逐动作；CFG-08按具体目标域与组织键/目标值推进，不能宣称任意SPRO节点都可自动维护。
