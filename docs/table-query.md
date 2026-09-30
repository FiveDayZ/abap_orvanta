# M6.2 有界单表查询

0.36.17 新增 `read_abap_table`，为通用查询补充结构化单表入口。现有 `execute_data_query` 自由 SQL 和已批准的限定业务后备行为保持不变。

0.36.29新增完整行读取，用户回传54项本地测试通过，但ZTPMC_RKH真实查询因CHAR500备注加重复主键超宽而失败。0.36.30候选修正此分组缺陷，尚待人工验收：字段上限1024，`columns: ["*"]`展开全部物理字段，不是“尽量取前1024列”。超限或存在不支持字段时整体拒绝，绝不静默删列。数值输出保留SAP文本，不转为JavaScript Number；宽行按完整主键条件分组读取和复读比较。原生ADT空HTML故障未恢复，只扩展安全后备。

本项交付范围不是完整 SQL 引擎：不支持联表、聚合、排序、分页、客户端覆盖、转换出口自动处理或写入。2026-09-10本地补充Include兼容及受限混合布局后备；[4852候选限定真实复验](../../.doc/m7-reader-4852-review-20260910-123924.md)已通过MARA、两张合同表、T001W、MAKT及零行/超限边界，不代表任意表、原ADT路径或业务写入通过。既有配置及MAKT真实读取证据见[M7限定核验](../../.doc/m7-masterdata-review-20260910-114131.md)。

## 输入

```json
{
  "connectionId": "w200",
  "tableName": "CVERS",
  "columns": ["COMPONENT", "RELEASE"],
  "filters": [{ "column": "COMPONENT", "operator": "EQ", "value": "SAP_BASIS" }],
  "maxRows": 10
}
```

- 表名、字段名只接受 1–30 位字母、数字及下划线，以字母开头，规范化为大写。不支持星号、SQL 片段或命名空间斜杠。
- 必须明确1–1024个不重复字段，或仅传`["*"]`读取全部字段；正常路径只接受活动透明表，最多1024个物理字段，另允许已识别的Include标记。为兼容既有Classic BAdI诊断调用，`tableName="SXCI"`是一个明确标注的仓库投影，不宣称存在同名DDIC表：固定字段为`EXIT_NAME/IMP_NAME/CLASS_NAME/INTER_NAME`，并通过`read_classic_badi_definition`取得定义、实现及类映射；提供`EXIT_NAME EQ`时执行精确读取，无该筛选时仅在有限仓库搜索范围内返回有界结果。其他名称被DDIC明确判定不存在时，工具返回`TABLE_QUERY_TABLE_NOT_FOUND`且不尝试RFC读器。只有DDIC端点不可用时才允许受限降级；该降级不接受`["*"]`，也不能独立证明表类别。1024是本工具的安全上限，不是SAP所有版本的最大字段数承诺。
- 最多 8 条 AND 筛选，操作符为 EQ、NE、LT、LE、GT、GE。
- 值为 SAP 内部格式字符串，最多 40 字符；单条编译条件含 AND 前缀不超过 72 字符。服务转义单引号，拒绝控制字符，不接收用户 SQL。
- `maxRows` 默认 100，范围 1–500。多取一行检测截断，不返回总数估算。

## 读取与保护

1. 通过现有 DDIC 工具读取真实活动表定义，核对表名、TRANSP 类型、字段和定义指纹。
   若该DDIC端点本身不可用，工具仅允许改用已核验的`RFC_READ_TABLE`以`NO_DATA=X`读取完整字段元数据；若旧读器无法提供完整布局元数据或明确返回`DATA_BUFFER_EXCEEDED`，才切换到另行核验指纹的`BBP_RFC_READ_TABLE`尝试一次。权限失败不重试；对齐读器失败后关闭，不继续切换。必须显式指定字段，投影总宽不超过512，投影及筛选字段仅限C/N/D/T。读取数据后再次读取完整元数据并比较SHA-256；`["*"]`、数值、字节、深层、宽投影或元数据漂移全部关闭。该结果返回`definitionSource=rfc_metadata`和`tableClassVerified=false`，不得解释为已独立确认TRANSP类别。
2. 优先调用原生 ADT。新工具明确关闭底层既有业务后备，以避免来源误报；旧 SQL 工具仍保留该默认后备。
3. 只有已经复现的 HTTP 200 / text/html / 零字节数据预览错误允许尝试标准 RFC_READ_TABLE；403、404、空结果、普通传输及解析错误都不触发替代读取。
4. 复用 M6.1 已审阅的源码及接口指纹，验证 remoteEnabled=true、updateTask=false。不同指纹关闭路径，不开放任意标准 RFC 调用。
5. 先以 NO_DATA=X读取完整布局。活动DDIC仅识别`.INCLUDE`和`.INCLU--AP`两个结构标记；有标记时发送空FIELDS，让SAP独立展开全部物理字段，再与DDIC物理字段逐项核对。内部元数据允许命名空间字段，但用户输入语法不扩大。未知标记、未展开Include、字段遗漏、重复或漂移全部拒绝。
6. 旧RFC_READ_TABLE仍只读取全表C/N/D/T平面布局。若全行含P/I/F/X/b/s，须另行核验BBP_RFC_READ_TABLE活动源码及接口指纹，复核完整NO_DATA布局一致后才能读取；全行总外部长度不超过8000，另按Unicode宽度、定长存储及对齐计算保守字节上界，不超过30000。投影支持C/N/D/T/P/I/F/b/s；筛选和分组用的主键仍限C/N/D/T。X可以存在于未投影布局，但不能输出；深类型、未知类型或不匹配的读器拒绝，不自动重试。
7. 每个RFC返回分组仍不超过512字符。宽行先查询maxRows+1个完整主键，再按每个完整主键和原条件精确取各列组，要求每组恰好一行；普通组回显主键并核对。若字段本身不超过512、但加主键超宽，则单独返回该字段，完整主键仍保留在WHERE中，不按行位置拼接。完整列组复读比较；缺失、重复或改变的行整体失败，不返回部分行。一次最多256次数据RFC，预算不足须降低maxRows。只有单字段本身超过512时才拒绝，不截断或分割该字段。
8. 完整行及数值路径按核验后的固定偏移解码，保留SOAP行首填充，允许字段内容含分隔符；数值保留SAP符号、小数和精度文本，星号溢出或异常表示拒绝。旧窄字符路径仍保留分隔符碰撞拒绝行为。读取结束再核对表定义指纹。两次相等观测不等于数据库事务快照，snapshot仍为false。

原读器指纹详见 [系统信息说明](system-info.md)。新对齐读器源码199行已从w200完整读取，保留VIEW_AUTHORITY_CHECK；repository接口sourceFingerprint为`e08069939315d594527fe58fc1a52e32e583d0987bc173295ddb816be9051b94`，interfaceFingerprint为`d85d035301f09d00229fa830e7c4cd7c63c8a167055d53bb62ddebb44d17743a`。这不同于ADT渲染源码指纹，不能混用。无需新增 SAP 对象、修改角色或安装通用查询 Helper。原生 ADT 路径可以返回数字和日期；RFC后备的类型限制不推广到原生路径。

`execute_data_query`仅在已知空HTML错误后，将下述有限语法交给同一读取器；要求显式maxRows不超过500。

```
SELECT <投影> FROM <表> [WHERE <析取>] [GROUP BY <键列表>] [ORDER BY <键列表>] [LIMIT <n>]
投影   := * | 字段列表 | 聚合列表（可与分组字段混写） | 算术项列表（可与字段混写）
聚合   := COUNT(*) | COUNT(字段) | SUM(字段) | MIN(字段) | MAX(字段)
算术项 := 项 (('+'|'-') 项)*
项     := 因子 (('*'|'/') 因子)*
因子   := '-' 因子 | '(' 算术项 ')' | 裸数字 | 字段   // 字段不能写成 别名.列（那是联接方言）
析取   := 合取 (OR 合取)*                       // 最多 8 个分支
合取   := 比较 (AND 比较)*                      // 每分支最多 8 项
比较   := 字段 (=|<>|<|<=|>|>=) 字面量（下推给读取器）
        | 算术项 (=|<>|<|<=|>|>=) 数字（服务端判定，要求该分支读完）
        | 字段 [NOT] IN (内层语句)              // 服务端判定，要求两侧都读完
内层语句 := SELECT 字段 FROM 表 [WHERE 合取]     // 恰好一列、无聚合/算术项/分组/排序/LIMIT
键列表 := 字段 [ASC|DESC] (, 字段 [ASC|DESC])*  // 最多 8 个键（GROUP BY 键不带方向）
```

- `OR` 逐分支下推：每个分支一次服务端读取，读取器自身的比较语义保持权威（NUMC、日期、PACKED 不在服务端重写）。合并时按行身份去重：`SELECT *` 取得的完整行（含主键字段）即为行身份，同一行被多个分支命中只保留一次并计入 `querySource.deduplicatedRows`；仅投影部分字段时两行可能逐列相同，此时**不丢弃任何行**，只把重复计数写入 `querySource.repeatedProjectedRows` —— 不得把调用方写的 `OR` 私自改写成 `DISTINCT`。两种情况下"成员"都精确：返回的每一行都满足该语句，满足该语句的每一行至少出现一次。**聚合与 `GROUP BY` 语句一律读整行**（`read_abap_table` 的 `columns=["*"]`）：行身份是"同一行被两个分支都命中只算一次"的唯一依据，否则计数会把一行数两次。
- 任一分支命中行上界时 `querySource.incompleteBranches` 给出分支序号且 `truncated=true`：此时答案是"匹配行的一页"，不是完整匹配集。
- `ORDER BY` 是对完整匹配集的断言，因此只在每个分支都读完时执行；任一分支被行上界截断即整体拒绝（`TABLE_QUERY_ORDER_BY_INCOMPLETE`，附分支序号与上界），不允许用样本冒充"排序最前"。排序键必须出现在投影列中，否则在读取之前拒绝（`TABLE_QUERY_ORDER_BY_COLUMN_NOT_SELECTED`）。比较按读取器文本表示做数值感知的字典序，**不等于** SAP 的按类型排序（NUMC/DATS 按文本比较）；需要 SAP 自身排序时应走原生路径。`sortColumns` 仍是对返回页的重新排序，与本语句的 `ORDER BY` 各司其职。
- 聚合**要么精确、要么拒绝**：任何分支被行上界截断即整体拒绝（`TABLE_QUERY_AGGREGATE_INCOMPLETE`）——样本的计数只是样本的计数，不能写成更小的数交出去。因此聚合只对"读取器能一次读完的匹配集"成立（每分支 ≤ 显式 `maxRows` ≤ 500）；超出时正确做法是收窄 `WHERE`，不是把数字当近似值用。
- `COUNT(*)` 数行，其余聚合忽略空值（SAP 初值以空串返回，等同于 SQL 的 NULL）：`COUNT(字段)` 只数非空值，`MIN`/`MAX` 取非空值的极值（无则返回空串）。`SUM` 是唯一需要服务端**计算**的聚合：只接受纯十进制文本，按最长小数位整体放大成整数相加（`1.1 + 2.2 = 3.3`，不是 `3.3000000000000003`），单个加数或累计和超出双精度可精确表示范围（2^53）时拒绝（`TABLE_QUERY_AGGREGATE_NOT_EXACT`），非十进制文本拒绝（`TABLE_QUERY_AGGREGATE_NOT_NUMERIC`，如 PACKED 的尾随负号写法）——**宁可不给数，也不给一个静默错误的数**。
- `GROUP BY` 必须**恰好**等于选中的普通字段集合（`TABLE_QUERY_GROUP_BY_KEYS_MISMATCH`）：没分组的选中字段在组内没有唯一值，没选中的分组字段在答案里读不出来。`*` 不能参与分组或聚合（`TABLE_QUERY_AGGREGATE_WITH_WILDCARD`），`GROUP BY` 键不带方向（`TABLE_QUERY_GROUP_BY_DIRECTION`），四个聚合以外的函数按名字拒绝（`TABLE_QUERY_AGGREGATE_UNSUPPORTED`，`AVG` 就是其中之一——写成 `SUM` 与 `COUNT` 两列即可）。只有 `COUNT` 可以数整行，`SUM(*)` 之类拒绝（`TABLE_QUERY_AGGREGATE_ARGUMENT`）。
- 每个聚合由表达式推导出一个发布列名，便于排序且不必猜别名：`COUNT(*)`→`COUNT`、`COUNT(F)`→`COUNT_F`、`SUM(F)`→`SUM_F`、`MIN(F)`→`MIN_F`、`MAX(F)`→`MAX_F`；`querySource.aggregateColumns` 给出表达式到列名的映射，`querySource.aggregated` 与 `querySource.groupCount` 说明答案是不是聚合结果、共几组。分组按首次出现的顺序排列，`ORDER BY`（或 `sortColumns`）才是排名手段。`COUNT(*)` 在零匹配时返回 `0` 一行；带 `GROUP BY` 时零匹配就是零组。
- 工具自身的 `filters`/`sortColumns` 作用于**返回行**：聚合语句的返回行就是分组，因此那里的 `filters` 只能筛掉分组、**不是** `HAVING` 的替代、更不能当 `WHERE` 用——要缩小匹配集必须在 `WHERE` 里写，否则先分组再筛与先筛再分组会给出不同的计数。
- 行身份是**行的取值**：读取器不返回行号，两条内容完全相同的行（无唯一键的表）在这个路径上无法区分，会被当成同一行——这是截断之外的另一个计数边界。
- 无 `WHERE` 的语句按单分支有界读取，返回一页。
- 可翻译的比较运算符集合与`read_abap_table`完全一致——降级路径不该拒绝它所调用的读取器本就能表达的比较。值超过读取器40字符上界、或运算符不属于该方言（如C式`!=`）时不予翻译，仍返回原生ADT错误。字面量自身含 `ORDER BY`/`GROUP BY` 的语句因无法确定切分位置而整体拒绝（拒绝，而不是猜读）。
- 联接走同一套方言（2026-09-26 起 `INNER`/`LEFT`，2026-09-30 起补齐 `RIGHT`/`FULL`/`CROSS`）：最多 3 张白名单表，每条列引用必须写成 `别名.列`，`ON` 只收等值（列=列、列=字面量）并下推到该表的那一次读取。**字面量条件只能落在"这次联接丢得起行"的那一侧**：`INNER`/`LEFT` 是本次引入的表，`RIGHT` 是它之前的表（写 `ON B.列 = '值'` 会被拒绝而不是照做——B 是 `RIGHT JOIN` 要保留的一侧，下推过去会把联接本该保留的行删掉；该条件写进 `WHERE`，保留侧在 `WHERE` 里是可以过滤的），`FULL` 两侧都保留，因此字面量条件在 `ON` 里无处可落、`WHERE` 也表达不了，只能按名拒绝。四种外/交叉联接的语义各自明确：`LEFT` 保留结果里已有的一侧，`RIGHT` 保留本次引入的表，`FULL` 两侧都保留，未匹配的一侧按读取器口径读作空串；`CROSS` 不接受 `ON`（它没有键，写 `ON` 即自相矛盾，`TABLE_QUERY_JOIN_CROSS_ON`）。外联接仍必须是最后一个联接（`TABLE_QUERY_JOIN_OUTER_NOT_LAST`），且 `WHERE` **不得**触碰外联接未保留的那一侧——`LEFT` 是本次引入的表，`RIGHT` 是它之前的表，`FULL` 两侧都算（`TABLE_QUERY_JOIN_WHERE_OUTER_COLUMN`）：下推只能过滤那一侧的读取，在 SQL 里那却是在过滤联接结果，两者含义不同，本服务不猜。
- `LIMIT <n>` 是唯一必须写在最后的子句，括号里只能是一个整数（其余形式按名拒绝，`TABLE_QUERY_LIMIT_FORM`——被静默忽略的 `LIMIT` 会用另一个行数回答另一个问题）。它**约束答案、不约束读取**：读取次数与读取上界都不变，切片发生在 `ORDER BY` **之后**（顺序决定取哪几行），因此 `ORDER BY ... LIMIT n` 是真正的"前 n 名"。它也不能把不完整的读取变成完整的：聚合与 `ORDER BY` 的完整性判据在切片之前、针对整个匹配集判定，截断即拒绝。`querySource.limit` 回报实际生效的上界，无该子句时为 `null`。
- 投影里的**算术项**（2026-09-30 用户裁定路线 A 起）：`+ - * /`、括号、一元负号，操作数是本表字段与整型/打包型字面量，形式形如 `SELECT MSEHI, ZAEHL / 2 FROM T006`。本平台没有任何渠道能替服务端求值（原生数据预览端点在此版本不可用、方言只下推 `FIELDS+OPTIONS`、读取器只按标识符取列），因此这一项由服务端自己算——**但计算规则不是服务端定的，是 SAP 官方文档定的**（`arith_exp - Calculation Type and Calculation Rules`）：操作数类型取自 `DD03L` 的 `DATATYPE`（`INTTYPE` 不能用来分类：`INT4` 的 `INTTYPE` 也是 `X`，与字节字段无法区分），据此决定计算类型——整型按"每个非整数小计商业舍入"（`7/2=4`、`5/2=3`），打包型保留声明小数位（`1.10+2.2=3.30`、`0.1+0.2=0.3`），`d`/`t` 按 `i` 参与运算（`DATS+1` 得 `20260931`，是文档的答案而不是"日期加一天"），`c`/`n`/`string` 按 `p`。**算不出来就按名拒绝，绝不近似**：非数字值（`TABLE_QUERY_EXPRESSION_NOT_NUMERIC`，指名是哪个字段、哪个值）、浮点操作数（`_FLOAT`）、十进制浮点（`_DECFLOAT`）、打包除法（`_DIVISION_SCALE`：没有目标字段就无法确定结果小数位）、除零（`_DIVISION_BY_ZERO`）、超过 31 位内部精度（`_OVERFLOW`：ABAP 会在此处商业舍入，本层不做）、非整数结果（`_NOT_INTEGER`）、字典没有给出该字段的类型（`_TYPE_UNKNOWN`）、未传类型（`_TYPE_UNAVAILABLE`）、字典读取本身没完成（`_DICTIONARY_UNAVAILABLE`，**这不能写成"字典说没有这个字段"**）。每个项按投影位置发布一个派生列 `EXPR_1`、`EXPR_2`…，由 `querySource.expressionColumns` 给出"表达式→列名"映射；`ORDER BY EXPR_n` 可用（求值发生在排序之前）；只为算术而读的字段会在算出结果后从行里删掉，所以答案里的列**恰好**是语句选中的列。仅读常量的项（`_CONSTANT`）与"项与聚合或 `GROUP BY` 同时出现"（`_GROUPED`：那里没有任何一行能定义这个项）按名拒绝；`SUM(ZAEHL * 2)`、`COUNT(*) + 1` 这类**聚合之内/之外**的算术仍按形式拒绝（`TABLE_QUERY_AGGREGATE_FORM_UNSUPPORTED`）。**本能力已于 2026-09-30 在 w200 上取得只读读数**：`.cache/r29-verify.mjs` 6/6 全过（旧构建基线 1/6），细节见本文末「验收状态」段与 `.doc/code-update-20260930-193631.md`。
- `WHERE` 里的**算术项**（2026-09-30 第二切片起）：比较的左侧可以是一个算术项，例如 `WHERE ZAEHL / 2 = 3`。读取器的结构化筛选只收「一个字段名 + 运算符 + 字面量」，**这项没有字段名可给**，因此它不进下推条件，而由服务端在该分支读回的行上判定——用的仍是投影那一套：类型取自 `DD03L`、按 SAP 计算类型求值、算不出来按名拒绝，**比较走精确十进制而不是二进制浮点**（`ZAEHL / 2 = 3.0` 与 `= 3` 是同一个数）。随之而来的是一条与 `ORDER BY` 同源的纪律：**带算术项的分支必须读完**，否则它的匹配集只是样本的匹配集——被行上界截断即整体拒绝（`TABLE_QUERY_WHERE_EXPRESSION_INCOMPLETE`，附分支序号与上界），绝不用样本冒充匹配集。术语一侧的 `WHERE` 算术项作用于**过滤**，因此它先于 `GROUP BY`/聚合生效（`SELECT COUNT(*) FROM T006 WHERE ZAEHL / 2 = 3` 数的是匹配的那几行）。与数字以外的值比较（`ZAEHL / 2 = 'x'`）按名拒绝（`TABLE_QUERY_WHERE_EXPRESSION_LITERAL`）；只读常量的项仍按 `_CONSTANT` 拒绝（它要么滤掉全部行要么一行都不滤）。哪个分支带了哪个项由 `querySource.whereExpressions` 给出（每项含 `expression`/`operator`/`value`/`disjunct`）。只为谓词而读的字段同样会在算完后从行里删掉。**只在本方言的单表路径**：写成 `别名.列` 的项由联接方言按下面那条规则处理，不由单表路径认领。
- 联接投影里的**算术项**（2026-09-30 第三切片起）：`SELECT A.ZAEHL / 2, B.BUTXT FROM T006 A INNER JOIN T001 B ON A.MANDT = B.MANDT`。项的每个列引用都按联接的既有规则写成 `别名.列` 并逐一对别名校验（未限定 `_COLUMN_UNQUALIFIED`、别名不存在 `_ALIAS_UNKNOWN`），求值发生在**联接之后**、以联接行为输入；操作数类型按**别名各自表**的 `DD03L` 解析，且只解析项真正读到的那几个别名——`A` 上的项不会因为无关的 `B` 字典读取失败而不可用，也不会向 `B` 多问一次字典。操作数列被读入但不发布（输出仍只含语句选中的列），派生列与单表路径同名同序（`EXPR_1`…，由 `querySource.expressionColumns` 给出映射），因而**发布面与单表路径一致**。两条额外语义：`ORDER BY` 在联接方言里每个键都必须限定，因此**不能**用 `EXPR_n` 排序（该语句不被认领，落回平台原生错误，不会被静默换成别的排序）；外联接未匹配的一侧按读取器口径是空串，项一旦读到它即按 `_NOT_NUMERIC` 指名拒绝该行——**不把它读成 0**。项与聚合/`GROUP BY` 同时出现仍按 `_GROUPED` 拒绝；被截断的一页**可以**带项（每行自己的值是精确的，`truncated` 说明这不是整个匹配集），这与 `WHERE` 项必须读完的要求是同一条纪律的两面：**决定成员资格才需要完整，逐行取值不需要**。**本能力已于 2026-09-30 在 w200 上取得只读读数**：`.cache/r33-verify.mjs` 5/5 全过（旧构建基线 1/5），细节见本文末「验收状态」段与 `.doc/code-update-20260930-193631.md`。
- `WHERE` 里的**集合测试** `IN (SELECT ...)`（2026-09-30 第四切片起）：`WHERE MSEHI IN (SELECT MSEHI FROM T001)`，`NOT IN` 取补集。内层语句由**同一套方言**解析（恰好一列、可选 `WHERE`；聚合、算术项、`*`、`GROUP BY`、`ORDER BY`、`LIMIT` 一律按名拒绝——`TABLE_QUERY_SUBQUERY_PROJECTION`：**一页不是集合**；内层语句本身不被翻译时按 `TABLE_QUERY_SUBQUERY_UNSUPPORTED` 拒绝，嵌套超过 3 层按 `TABLE_QUERY_SUBQUERY_DEPTH` 拒绝），读取时走**同一个读取器与同一读取上界**。读取器的结构化筛选没有集合运算符，因此整个测试由服务端判定，并沿用两条同源纪律：**两侧都必须读完**——内层集合被截断即整体拒绝（`TABLE_QUERY_SUBQUERY_INCOMPLETE`，且在读外表之前就拒绝，一行都还没滤），带该测试的外层分支被截断同样整体拒绝（`TABLE_QUERY_WHERE_SUBQUERY_INCOMPLETE`）；「集合外的样本」不等于「集合外」。**比较的是值，不是文本**：类别由两侧字段的 `DD03L` 类型决定——字符类（`CHAR`/`NUMC`/`DATS`/`TIMS`/`LCHR`/`STRG`/`SSTRING`/`VARC`/`CLNT`/`UNIT`/`CUKY`/`LANG`）按**忽略尾随空格**比较，所以同一值从两个声明长度不同的字段读出来仍然相等；数值类（`INT1/2/4/8`、`DEC`、`CURR`、`QUAN`、`ACCP`、`PREC`）按**精确十进制**比较，所以 `007.50` 与 `7.5` 是同一个值、`7.5` 与 `7.05` 不是。本层无法复刻的比较一律按名拒绝而不退化成文本比较：两侧类别不同或类型不在两类之内（`TABLE_QUERY_SUBQUERY_TYPE`——SAP 会先把两侧转成公共类型再比，本层不复刻这个转换）、浮点字段（`_FLOAT`）、值不是精确十进制（`_VALUE`，**空串数值字段属于此列**：初值在本层没有可放置的值）、类型未取到（`_TYPE_UNKNOWN` / `_TYPE_UNAVAILABLE`）、内层集合无法读取（`_SUBQUERY_UNAVAILABLE`）。只为该测试而读的字段同样在出答案前删掉；`querySource.whereSubqueries` 给出「哪个分支带了哪个测试、测哪一列、集合几个值」（集合本身是内层语句的答案，不重复发布）。内层语句里的 `LIMIT` 归属内层而**不会**被当成外层语句的 `LIMIT`（切分时计括号深度）；联接方言不认领集合测试（该语句落回平台原生错误，不被误读）。**相关子查询**（内层引用外层的行）不在本层方法内——见 `docs/ops-coverage.md` 的边界段。
- `WHERE` 里的**标量子查询** `X = (SELECT ...)`（2026-09-30 第五切片起，也是 `query` 族最后一项声明缺口）：`WHERE ZAEHL = (SELECT COUNT(*) FROM T001)`，六种比较运算符都收。内层语句由**同一套方言**解析，且**必须恰好答出一行**：无 `GROUP BY` 的单个聚合（`COUNT`/`SUM`/`MIN`/`MAX`），或单个普通列而其读取恰好返回一行。除这两种形式外一律按名拒绝而不猜：多行（`TABLE_QUERY_SCALAR_ROWS`——**本层绝不挑其中一行**，挑一行就是回答另一个问题）、零行（同一个码：SQL 里那是 NULL、判定为"未知"，三值逻辑本层不复刻）、投影既非单聚合也非单列（`TABLE_QUERY_SCALAR_PROJECTION`，`SELECT *` 亦在此列）、内层带 `ORDER BY`/`LIMIT`（`TABLE_QUERY_SCALAR_PAGE`——一页不是值，`LIMIT 1` 会把本层拒绝挑选的那几行藏起来）、内层语句不被翻译（`TABLE_QUERY_SCALAR_UNSUPPORTED`）、嵌套超过 3 层（`TABLE_QUERY_SCALAR_DEPTH`，与集合测试共用深度上限）。两条同源纪律照旧：**内层必须读完**——被行上界截断即整体拒绝（`TABLE_QUERY_SCALAR_INCOMPLETE`），且**在读外表之前**就拒绝，一行都还没滤；**带该比较的外层分支也必须读完**——被截断即整体拒绝（`TABLE_QUERY_WHERE_SCALAR_INCOMPLETE`），绝不用样本冒充匹配集。**比较仍是值的比较，与集合测试同一套**：类别由两侧字段的 `DD03L` 类型决定，字符类按**忽略尾随空格**比较、数值类按**精确十进制**比较；本层无法复刻的比较一律按名拒绝而不退化成文本比较——浮点字段（`TABLE_QUERY_SCALAR_FLOAT`）、两侧类别不同或类型不在两类之内（`_TYPE`）、值不是精确十进制（`_VALUE`，空串数值属于此列）、类型未取到（`_TYPE_UNKNOWN` / `_TYPE_UNAVAILABLE`）；**字符值的大小比较另按名拒绝**（`TABLE_QUERY_SCALAR_ORDER`：SAP 字符字段的排序规则本层说不清，只判定 `=` 与 `<>`，数值类的六种运算符都可判定）。内层值的类型：`COUNT` 是本层算出的 `INT4`，`SUM`/`MIN`/`MAX` 取被聚合列的字典类型；内层语句与外表走**同一个读取器、同一读取上界**。`querySource.whereScalars` 给出「哪个分支带了哪个比较、比哪一列、用什么运算符、内层答出的值、内层取值列」——**内层是聚合时该取值列为 `null`**（聚合答的是值、不命名列；内层是单列时才命名单列，已由真机读数确认）——集合不重复发布（可能很大），标量**发布这一个值**（它是调用方问的那一半）；只为比较而读的字段同样在出答案前删掉。**真机读数已取得**（w200 只读，2026-09-30 20:34，用户重启 4849 至当前构建后）：`.cache/r38-verify.mjs` **13/13**（脚本里 12 处正向与按名拒绝断言，加 1 处读取器旁证），五切片合计 22 + 13 = **35 项**，输出 `.cache/r38-verify.json`。读数顺带确认两件事：一是上面那条取值列在聚合内层下为 `null`；二是 **`T006` 的整行读会被解码守卫按名拒绝**——不带过滤地对它做聚合（聚合必读整行）即报 `SAP_TABLE_QUERY_FAILED: TABLE_QUERY_NUMERIC_OVERFLOW`，所以该脚本的内层语句要么单列投影、要么过滤到小匹配集。**该成因已用只读探针查清（`.cache/r39-probe1|3|4|6|7.mjs`，2026-09-30）**：该表 276 行里 274 行可解码（273 行 `ADDKO=0.000000`、1 行 `9.000000`，文本宽度全为 8 字符），不能解码的**恰好两行**——`MSEHI='GC'`（摄氏）与 `'FA'`（华氏）；两行的 `DIMID` 都是 `TEMP`，`ZAEHL/NENNR` 分别是 1/1 与 5/9（华氏的 5/9 换算因子），且 `EXP10`/`EXPON`/`DECAN`/`TEMP_VALUE` 全为 0 ⇒ 它们携带的加法换算常数只能落在 `ADDKO`。`ADDKO` 是 `DEC 9/6`，读取器自报的字符宽度是 **9**，而摄氏 273.15 与华氏 255.372222 的十进制文本需要 **10** 个字符 ⇒ 该文本不可能是纯十进制数，守卫按名拒绝；且守卫**接受**该宽度下任何以数字开头的十进制文本（274 行读数即为证），所以"被静默截断成合法数字"这条路径不存在——那会是读数成功而不是报错。**结论：守卫不改（拒绝是正确的），把边界写清而不是放宽**；调用方按字符列过滤掉这两个键即可读该表其余部分，而整行读（`SELECT *`、无过滤聚合）必然包含它们，按名拒绝属预期行为。**残留**：这两行 `ADDKO` 的原始文本在本服务内不可观测（凡投影 `ADDKO` 且覆盖这两行的语句都在出任何输出之前被拒，这正是该守卫的设计行为），因此**守卫两条子句里究竟是哪条命中**（带星号的替代文本，还是守卫不认作纯十进制的形状）并未由这些读数判定；但判定不依赖它——宽度论证已经说明这两行携带的值根本印不进该字段的字符位。要闭合这一细节需在 SE16N 侧人工只读看一眼这两行。
- 仍不翻译：列别名、相关子查询、分号与注释，以及联接方言里 `ORDER BY` 一个派生列（**标量子查询自 2026-09-30 起已实现，不再是本清单的一项**）。子查询属"要么实现要么拒绝"，未实现的形式（相关子查询）一律落回平台原生错误；普通字段比较仍**下推给 SAP**，服务端只在写下的确实是一个算术项、一个集合测试或一个标量比较时才自己判定——这正是本方言要避免在服务端重写 SAP 类型语义（NUMC/DATS/PACKED 的取值与比较）的地方；集合测试与标量比较之所以能自己做，是因为它们比较的两侧都被字典定型、且类别不同即拒绝。
- 返回保留原data结构，并以querySource记录方法、原生错误、字段类型及snapshot=false，另附 `disjuncts`、`deduplicatedRows`、`repeatedProjectedRows`、`incompleteBranches`、`orderByApplied`、`aggregated`、`groupCount`、`aggregateColumns`、`expressionColumns`（无算术项时为空数组）、`whereExpressions`（`WHERE` 里由服务端判定的项，无则为空数组）、`whereSubqueries`（`WHERE` 里的集合测试，无则为空数组）、`whereScalars`（`WHERE` 里的标量比较，无则为空数组；含内层答出的值）。不改变既有ZTPMC_BZWL限定helper路径。

## 输出语义

- `status=ok` 表示本次读取成功，包括真正零行；失败为 `unavailable`、`data=null`，不能解释成没有数据。
- `method` 区分 `adt_query`、`rfc_read_table`、`bbp_rfc_read_table`；后备保留 `nativeCode`。`definitionSource`区分`adt_ddic`与`rfc_metadata`；后者同时返回`tableClassVerified=false`。`definitionFingerprint` 是读取到的ADT表定义或两次一致RFC元数据指纹，不是事务快照凭证。
- `representation=adt_decoded` 使用现有 ADT 数值和日期解码；`sap_text_trimmed` 返回 SAP 文本并移除 CHAR 填充，保留标识符前导零，不进行数值或业务单位推断。
- `returnedCount` 仅统计返回行，`truncated` 表示多取到了一行；失败时 `truncated=null`。
- `order=unspecified`、`snapshot=false`。不得把连续调用当作稳定分页或一致性导出，也不得把返回首行当作某个业务排序的第一条。
- `clientHandling=sap_session_default`：两条路径都使用当前 SAP 会话的隐式客户端规则，不开放 CLIENT SPECIFIED。跨客户端表仍为跨客户端表，不能声称所有返回行都归属于当前客户端。
- 固定错误码和阶段可用于诊断；`TABLE_QUERY_TABLE_NOT_FOUND`表示名称未解析为活动DDIC透明表，不代表同名仓库对象类型不存在。`SXCI`兼容投影返回`compatibilityProjection=true`、`tableClassVerified=false`及`method=classic_badi_repository_helper`，避免把仓库结果伪装为物理表读取。不返回底层异常正文、过滤值或生成的 SQL。
- 投影被拒时回执照实给出证据（2026-09-21 17:10 事件后新增）：`TABLE_QUERY_FIELD_INVALID` 附带 `invalidColumns`（请求或过滤中不存在的字段）、`validColumns`（该表真实字段，最多 64 个样本）与 `validColumnCount`（真实字段总数），使调用方一次即可改正；`TABLE_QUERY_DEFINITION_INCOMPLETE` 专表字段字典本身不可用（无可用字段／超过 1024／存在重名），属字典侧缺陷而**不是**调用方入参问题，并附 `definitionFieldCount`。两处都在任何 SAP 数据访问之前判定，`data=null` 不表示对象不存在。
  - 实例：`DD02L` 共 31 个字段且**不含** `DDLANGUAGE`（该字段在 `DD02V`）；请求 `["TABNAME","AS4LOCAL","AS4VERS","TABCLASS","SQLTAB","CONTFLAG","MAINFLAG","DDLANGUAGE"]` 现在返回 `invalidColumns:["DDLANGUAGE"]` 与 31 个有效字段名。读取非活动表头属性请直接用 `DD02L` 的有效列（`TABCLASS`/`CONTFLAG`/`MAINFLAG`/`AS4USER`/`AS4DATE`/`AS4TIME` 等）。
- 完整布局元数据已取得但后续拒绝时，`layoutSummary`仅返回字段数、总外部长度及类型集合，不含业务行或筛选值；用于区分运行时类型、长度和投影边界。

能力报告将此工具列为目标相关能力；仅注册工具或 ADT 探针通过不等于具体表或后备路线已经可用。

## 验收

正常启动 0.36.17 并在配置中心安全输入本次密码后，从项目目录执行：

```powershell
node scripts/probe-table-query.mjs
```

并行测试可通过 `ABAP_MCP_URL` 指向本机空闲端口，不需停用旧服务。脚本先验证部署版本，再读取 T000/client 200 和 CVERS/SAP_BASIS，检查矛盾条件零行、截断及无效参数拒绝。只读取系统元数据，不创建业务样本。

唯一验收证据写到工作区根 `.doc`。失败退出码为 1，不重写历史失败记录。跨系统、复杂 SQL、深类型及RFC后备数值输出仍需独立实施或评估；未发布补丁不覆盖旧ZIP或旧服务。

### 算术项、集合测试与标量子查询的验收状态（2026-09-30）

- **本地已过**：`npm test` 1275 项全绿（`test/table-expression.test.ts`、`test/table-expression-projection.test.ts`、`test/table-expression-wiring.test.ts`、`test/table-query-where-expression.test.ts`、`test/table-join-expression.test.ts`、`test/table-subquery.test.ts`、`test/table-scalar.test.ts`），格式、静态、类型、两个矩阵闸门退出码零。证伪：`.cache/r27-falsify.mjs` 对投影接线做 6 处退回（不求值 / 不发布派生列 / 无类型也计算 / 不读字典 / 字典读取失败被误报成"字典没这个字段" / 只为算术读的列被带进答案），`.cache/r30-falsify.mjs` 对 `WHERE` 项做 8 处退回（把项当普通字段下推 / 截断不拒绝 / 类型不查字典 / 比较退化成字符串相等 / 不删只为算术而读的列 / 不算就放行该行 / 不发布 `whereExpressions` / 工具层只看投影决定是否读字典），`.cache/r32-falsify.mjs` 对联接投影项做 9 处退回（操作数不读 / 不求值 / 不发布派生列 / 把裸限定列当成项 / 项的引用不校验别名 / 与聚合或 `GROUP BY` 同放行 / 不回报 `expressionColumns` / 工具层不给联接项取类型 / 给无关别名也读字典），`.cache/r34-falsify.mjs` 对集合测试做 15 处退回（不被语法认领 / 内层集合截断不拒绝 / 外层分支截断不拒绝 / 数值集合退化成文本比较 / 字符集合不忽略尾随空格 / `NOT IN` 答成 `IN` / 类别不同仍比较 / 浮点仍比较 / 类别不识别仍比较 / 被测列不读 / 不发布 `whereSubqueries` / 内层 `LIMIT` 被当成外层 `LIMIT` / 内层列类型不解析 / 外层列类型不解析 / 集合测试被当普通条件下推），`.cache/r37-falsify.mjs` 对标量子查询做 22 处退回（不被语法认领 / 零行不拒绝 / 多行不拒绝 / 内层截断不拒绝 / 外层分支截断不拒绝 / 按文本而非按值排序 / 字符不忽略尾随空格 / 类别不同仍比较 / 浮点仍比较 / 两类皆不可放置仍比较 / 字符大小比较放行 / 非精确十进制值仍比较 / `SELECT *` 当单列 / 内层 `ORDER BY`/`LIMIT` 不拒绝 / 嵌套深度不拒绝 / 被测列不读 / 不发布 `whereScalars` / 标量比较被当普通条件下推 / `COUNT` 类型改成字符 / 工具层不读字典 / 内层列类型不解析 / 内层值类型不解析）——全部 FALSIFIED，复原后绿。
- **真机读数（w200，2026-09-30 19:24-19:36，用户重启 4849 至当前构建后取得）**：`.cache/r29-verify.mjs` 6/6（投影算术项，旧构建基线 1/6）、`.cache/r31-verify.mjs` 5/5（`WHERE` 项，旧构建基线 0/5）、`.cache/r33-verify.mjs` 5/5（联接投影项，旧构建基线 1/5）、`.cache/r35-verify.mjs` 6/6（集合测试，旧构建基线 0/6——旧构建把 `IN (SELECT ...)` 落回 `SAP_DATA_QUERY_RESPONSE_INVALID`，`whereSubqueries` 尚不存在），合计 **22/22**。四份读数落在 `.cache/r29-verify.json`、`r31-verify.json`、`r33-verify.json`、`r35-verify.json`，判据与处置写在 `.doc/code-update-20260930-193631.md`；此前那轮 16/22 的六处未过已定位为**验收脚手架缺陷**（不是服务缺陷），诊断记录 `.doc/code-update-20260930-192647.md` 与探针 `.cache/r36-probe.json`。**第五切片（标量子查询）同批取得读数**：`.cache/r38-verify.mjs` **13/13**（w200 只读，2026-09-30 20:34，用户重启 4849 至当前构建后），输出 `.cache/r38-verify.json`；五切片合计 **35/35**。
- **五切片真机读数已齐（`query` 族声明的五项能力各有一份 w200 只读读数）**：标量切片由 `.cache/r38-verify.mjs` 的 13 项覆盖——`COUNT(*)`、`COUNT(*)` 全表计数、单列单行、`MIN` 取被聚合列类型的四处正向比较，字符大小比较、类别不同、多行、零行、`SELECT *`、两列、带 `ORDER BY` 内层的七处按名拒绝，无标量时报空映射，以及读取器对整行读的溢出拒绝（旁证）。**`T006` 整行读被拒的成因已判定**（只读探针 `.cache/r39-probe1|3|4|6|7.mjs`）：276 行里只有 `MSEHI='GC'` 与 `'FA'` 两行不可解码，二者是 `DIMID='TEMP'` 的摄氏/华氏行（`ZAEHL/NENNR` 为 1/1 与 5/9，其余数值列为 0），其加法换算常数只能落在 `ADDKO`；该字段的字符宽度是 9，而这两行的十进制文本需 10 个字符 ⇒ 守卫**按名拒绝而不是误读**，且"静默截断成合法数字"这条路径已被 274 行读数排除。**结论：守卫保留不改、边界写清**（调用方按字符列过滤这两个键即可读其余行）；残留仅剩"原始文本在本服务内不可观测"——守卫两条子句（带星号的替代文本 / 不是纯十进制的形状）究竟是哪条命中未判定，但不影响判定，SE16N 人工只读可闭合该细节。**读数覆盖的边界照旧**：只覆盖 T000/T001/T006/TBTCO 等少数已批准表，不代表整个 D5-2 白名单的类型。
