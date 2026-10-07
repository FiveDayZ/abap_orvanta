# r57：CUNI标准维护与CTS所有权复核

时间2026-10-06T08:41:43+08:00。本文件是只读源码分析；没有执行所列标准维护/激活/传输命令。完整来源、接口、行数和SHA均封存于[证据JSON](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-recovery-check-repair-20261006-084143-r57.json)。本轮完整读取13个标准函数4487行；详细检查下列影响路径及两个FORM的实际范围，未声称完成所有标准源码的全量审计。

## 已确认调用及影响

| 真实owner/范围 | 已确认行为 | 对APPLY/RECOVER的要求 |
| --- | --- | --- |
| SCPR_PRSET_CT_ONE_TABLE_LOAD，上一轮591行 | 官方DELETE/MODIFY后调用HI_SCPRACTR_FILL，不拥有外层授权/锁/commit | 锁内重读，显式错误检查；不能直接UPDATE标准表替代 |
| SCPR_HI_SCPRACTR_FILL，134行 | g_actlinks初始值会报错；支持no/write/yes模式；构造内存链接并记录历史时间与动作 | 每请求初始化标准全局状态，准确选择已批准模式；不能依赖上次RFC会话 |
| SCPR_HI_ACTLINKS_UPDATE，173行 | 分配tabrecnumb，删除同key旧链接，写SCPRACTR/SCPRACTP，可录制传输 | 原九表前态不足；需链接/相关头与变量前态、版本和锁 |
| LSCPRHIF01，274–328行 | 读取当前表全部链接并取最大tabrecnumb递增；删除同table/view/key全部旧链接，不以当前BC Set过滤 | 必须序列化该标准分配owner；不能只锁十九配置业务键 |
| SCPR_HI_ACTLINKS_DELETE_UPD，128行 | 删除旧数据链接；若相应BC Set已无数据链接，删除该BC Set header/variables/variable-links | 其他BC Set关联前态必须准确识别，不得把它们误判无关旁路数据 |
| HI_DB_SCPRACTR_WRITE / HI_DB_SCPRACTP_WRITE，各12行 | 标准MODIFY没有本地commit，也未回传受影响计数 | 顶层须读回验证并负责rollback/commit；不能仅按无异常宣布成功 |
| HI_ACTLINKS_INTO_TRANSP，164行 | 原生字段长度+offset拼SCPRACTR/P/X/XL键，变量键带官方星号范围 | 使用官方键构造并审阅范围；恢复精确新增delta而非任意全任务删除 |
| SCPR_ACTIV_TRANSP_TABLE_FILL，1532行 | CUNI/T走T/T combination7；按语言valuesl与deleteflag计算TABU键，mastertype为TDAT | 不能把CUNI/T录制简化为独立TABU行；限制真实语言/删除范围 |
| LSCPRACF03，610–779实际读取；T分支610–约683 | GET_E071_OF_OBJECT产生R3TR/TDAT/CUNI、OBJFUNC=K及activity；不走逻辑传输对象L分支 | 准确绑定官方主对象、子键和ACTIVITY |
| TRINT_APPEND_TO_COMM_ARRAYS，763行 | 校验任务状态/类型/owner/client，支持IV_DIALOG；检查对象和键，可能写TLOCK；调用TRINT_APPEND_COMM并更新E070时间 | 显式无对话、保留检查，不放开NO_OWNER_CHECK/NO_KEY_CHECK；错误有ROLLBACK路径，真实callee还须审查 |
| TRINT_APPEND_COMM，307行 | 官方E071/E071K/E071K_STR追加和去重，保留固定空格/身份；物理INSERT异常可能dump；自身无COMMIT | 顶层提交；异常/超时按回执+值/CTS/锁对账，不能因无回复重放 |
| TR_REQ_CHECK_OBJECT / KEY，564/532行 | 对象可维护性、系统/任务及键语法/语言/大小写规则 | 保留官方检查和DDIC lowercase；kN/m2不能统一转大写或去空格 |
| TRINT_READ_REQUEST_HEADER，90行 | 真实CTS请求头读取接口 | 固定开放Customizing parent/task和当前owner/client；锁内再检 |

## 仍需闭合的边界

父IMPORT_INDUSTRY的NO_COMMIT仅覆盖其局部提交；上一轮已读独立R/3*协议commit及SCDTSYNC/远程RFC分发路径，不得据NO_COMMIT承诺整包原子性。选择低层owner后仍需明确标准激活链接与协议/变量/后导入方法是否必要及其正式语义，不能为伪原子性删掉必要效果。

TRINT_APPEND_TO_COMM_ARRAYS的set_cico_comnt/check_keys/dequeue_all等FORM没有在本轮找到；没有把整个调用图认定无独立副作用。类型T路径已在实际元数据确认；其余1532行通用分支未作为固定CUNI可达行为。没有执行维护API、任何simulation或CTS追加来试探。

## 结论

当前允许只读准备；完整命令尚不能开放。r58必须把链接表的真实受影响数据和官方CTS主对象/键纳入同一可审阅恢复清单，复用已有回执/不可变前态设施。配置十九键、其他BC Set关联记录、任务历史条目与未知提交结果应分别有真实证据，不能相互替代。
