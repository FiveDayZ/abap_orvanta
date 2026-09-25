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

`execute_data_query`仅在已知空HTML错误后，将有限语法`SELECT *`或逗号分隔字段、单表、WHERE比较条件（`=`、`<>`、`<`、`<=`、`>`、`>=`，最多8项AND连接，值为单引号字面量或裸数字）交给同一读取器；要求显式maxRows不超过500。可翻译的比较运算符集合与`read_abap_table`完全一致——降级路径不该拒绝它所调用的读取器本就能表达的比较。值超过读取器40字符上界、或运算符不属于该方言（如C式`!=`）时不予翻译，仍返回原生ADT错误。不翻译JOIN、OR、表达式、别名、排序、聚合或任意SQL。返回保留原data结构，并以querySource记录方法、原生错误、字段类型及snapshot=false。不改变既有ZTPMC_BZWL限定helper路径。

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
