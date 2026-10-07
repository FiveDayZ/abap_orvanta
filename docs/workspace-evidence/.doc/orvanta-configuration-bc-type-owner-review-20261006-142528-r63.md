# r63：SCPR 真实类型与标准保存/恢复所有权复核

2026-10-06T14:25:28.180+08:00，Asia/Shanghai；w200/GR2/client200，API-only。[evidence](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-type-pool-read-20261006-142528-r63.json)保留实际公共 MCP 返回、原生返回、前后元数据、真实标准源码/接口和失败记录。这里只复核固定 CUNI 可达部分，不宣称审完全部通用 BC Set 调用图。

## 真实类型来源已闭合

公共 get_object_by_uri 实际返回 %_CSCPR（PROG_TYPE=T）、active、826 行；来源为 RPY_PROGRAM_READ，表示 rfc_char255_rows_crlf，SHA-256 67ee66398adfe20921af6fe96bc77499b79384abc1f4c799c08c0d4b0dab6c64。该摘要标识保留的 RFC 行/CRLF 表示，不等同于 ADT 下载原始字节摘要。旧 r62 VIT source empty 与 SCPR_RECORD2 DDIC not-found 是当时入口/对象种类限制，不能再当类型声明缺失，也不删除历史记录。

| 实际声明 | 实际源行 | 约束及调用用途 |
| --- | --- | --- |
| SCPR_VALS_TAB / SCPR_VALL_TAB | 15–16 | 标准表行是 SCPRVALS / SCPRVALL；使用真实 DDIC 行，不猜通用字符串字段 |
| SCPR_FLDDESCR / SCPR_FLDDESCRS | 78–81 | 行别名 SCPR_DESCR、OCCURS 10；实际 DDIC 29 字段，摘要 6c7ea517335a503a70128ed55bf5248097ab3cc6e72862494e2aa44d5494fc35 |
| SCPR_RECORD2 | 84–104 | TABNAME/TABTYPE/TABTEXT/TABLEN/KEYLEN/CKEYLEN/OBJNAME/OBJTYPE/ACTIVITY/STATUS/DELETE/DESCR_REDUCED/CLNT_FLD/DELIVERYCL；深表 DESCR/SELLIST/HEADER/NAMTAB 分别是标准字段描述、VIMSELLIST/VIMDESC/VIMNAMTAB |
| SCPR_RECORDS | 108 | SCPR_RECORD2 的标准 OCCURS 表，属于 ABAP 类型池，不是同名 DDIC 结构 |
| SCPR_RAW2 / SCPR_RAW2_TAB | 165–185 | RANGE/TABNAME/RECNUMBER/PROFID/VERSION/TEXT/OBJNAME/OBJTYPE/TABTYPE/ACTIVITY/KEY_COMPLETE/UNCOMPLETE/DELETEFLAG/GENREF，及 VALUES/VALUESL 深表 |

这些深结构只用于客户桥的 SAP 内部调用，不能直接作为 ECC 外部 RFC 的深 TABLES 参数暴露。对外沿用标量、真实 DDIC 扁平行及不可变前态引用。

## 描述器与标准叶节点

SCPR_PRSET_DB_FLDDESCRS_GET 真实 182 行，source=463d4c9ba84c0eb0d1e72bf4dbd0970c5b245e97e971dec2db761d0e7cef15f9，interface=f410c68f83f7ce339cba891bfa6ce1e38c380f621928d354a3327ffc90fbddae。它从 RECATTR 取得 table/object 身份，经 SCPR_DB_TABLE_TYPE_GET、SCPR_DB_TABLE_FIELDDEF_GET 创建真实 SCPR_RECORDS，不应自行拼字节偏移。第 160–174 行填长度/字段/子表，未给 OBJNAME/OBJTYPE/ACTIVITY 赋值；调用桥必须按准确 RECATTR 身份补齐并校验，不能认为结果已包含全部对象上下文。它在第 144–158 行对 TABLE_UNSUITABLE 不转报错误，不能只看 TABLE_ERRORS 空就认定适用，仍要核对描述器、字段、完整五表及布局。

SCPR_PRSET_CT_ONE_TABLE_LOAD（591 行）是标准数据叶节点。参数包含 TABLEDESCR TYPE SCPR_RECORD2、VALUES TYPE SCPR_VALS_TAB、ACTOPTS TYPE SCPRACTOPT，确实支持固定 CUNI/T 路径；内部完成标准键/字段转换、现存行读取及合并、DELETE/MODIFY 和关联内存登记。第 481/528 行是 SAP 标准内部 SQL；客户桥继续调用标准 API，不新增任意标准表 SQL。该叶节点本身不建立完整授权、锁、CTS、协议或顶层提交语义，不能单独当完整 BC Set 激活。

## 提交与不可补偿边界

| 实际标准 owner | 已读/复核的作用 | 后续命令必须处理 |
| --- | --- | --- |
| SCPR_PRSET_CT_IMPORT_INDUSTRY（1205 行） | 锁、转换、标准叶节点、关联、CTS、协议及内存清理；第 1142 行自身 COMMIT 条件受 NO_COMMIT 控制 | 完整必要效果和锁释放顺序；NO_COMMIT 不等于全部链路无提交 |
| SCPR_HI_SET_GLOBAL_ACTOPTS（18 行） | 设置 g_actlinks/g_no_standrd，清空两项关联记录内存 | 每次请求初始化；并未清空所有 descriptor cache |
| SCPR_HI_ACTLINKS_UPDATE（173 行） | 标准关联编号、删除/新增关联、CTS 链接和关联 header | 真实前态、共享 profile 与变量范围，不能只恢复十条配置数据 |
| SCPR_CT_TRANSPORT_LOAD（468 行） | 无对话仍校验 Y/N，TR_REQUEST_CHOICE、任务锁、SCDC_DISTRIBUTE_TABLE_KEYS、TRINT_APPEND_COMM | 无对话不是没有分发；默认 DEQUEUE 可能提前释放命令的任务锁；不能在未分析分发契约时选此入口 |
| SCPR_PR_DB_DATA_WRITE（79 行）及 SCPR_ACTIV_PROTOCOL_WRITE | 默认调用标准协议数据库 owner；后者此前实读第 132 行 COMMIT CONNECTION R/3* | 协议有独立提交；必须分段回执，不能返回统一 rollback 成功 |
| TRINT_DELETE_COMM_KEYS（此前实读 103 行） | 精确清理后 DB_COMMIT 独立提交 | 只准已证明本次新增的精确 delta，保护原有 CTS，并单独记录提交和读回 |

以上 save/lock/delete owner 均未执行，只读取源码/接口。未激活、模拟 BC Set，也未写配置/CTS/标准对象。

## 恢复所有权与不能猜测的接口

真实存在并已读取 SCPR_HI_DB_SCPRACTR_WRITE / SCPR_HI_DB_SCPRACTP_WRITE，以及拼写为 SCPR_HI_DB_VARIBLES_DELETE 的标准删除入口。此前猜测 SCPR_HI_DB_SCPRACTX_WRITE / SCPR_HI_DB_SCPRACTXL_WRITE 实际读取失败，返回模块不存在；当前真实搜索 SCPR_HI_DB* 列出八个对象，不得继续用猜测名生成客户源码。

SCPR_HI_ACTLINKS_DELETE_UPD 真实 128 行，会排序/去重传入删除行；TASK_NUMBER 非空会产生删除 CTS。删除后如果该 profile 已无记录，会删除 header/variables；第 73 附近的 READ 非零分支不能被当成严格的 only-not-found 语义。恢复必须保存完整记录/headers/variables/links前态，精确证明所属本次效果，并读回；在非空共享 profile 的恢复 owner 未闭合前，不能宣称已支持该情况。

## CUNI 与 BC Set 的锁兼容性

MUNITF01 1679 行、MUNITI01 1141 行通过实际 get_object_by_uri 完整读取，针对保存 dispatch、权限和锁相关块复核。MUNITF01 第 1417/1496 行使用 S_TABU_DIS/02；第 1427–1432 /1507–1512 行将 VARKEY 设为 sy-mandt + old_dimid，对 T006 调 ENQUEUE_E_TABLE。生成的 ENQUEUE_E_TABLE / ENQUEUE_E_TABLEE 真实源码均以 gname=RSTABLE、TABNAME/VARKEY 组成锁参数、MODE_RSTABLE=E，默认 _SCOPE=2；DEQUEUE 默认3。不能因函数名不同而假定两套锁互不保护，也不能不看实际泛型键/ownership就叠加锁。源码证明结构一致，跨用户冲突、锁累计和跨提交保持仍未运行实测。后续沿标准键范围统一持锁，检查高层内部 DEQUEUE，清理只释放本命令所有权；禁止复制 CUNI FORM、DEQUEUE_ALL 或 GUI 操作。

## 剩余风险

P1：原生 APPLY/RECOVER 尚未实现；必须先完成标准必要效果选择、锁内前后态、分段提交与恢复、未知结果接管的完整候选。P1：r60 新公开 EFFECTS 路由仍未取得真实集成验收，不因本次类型读取成功改为 verified。P2：非空共享 profile、跨用户并发及 CFG07/08 业务域仍需真实条件。下一阶段见 [plan](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-native-command-plan-20261006-142528-r64.md)。
