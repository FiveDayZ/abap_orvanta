// D5-2 表白名单：既有 `read_abap_table`（含 RFC 回退）路径的权威允许集。
//
// 依据 2026-09-20 的 W1–W4 裁定（见 .doc/d5-2-query-whitelist-draft.md §5）：
//   W1 采纳 A/B/C/X 四档划分
//   W2 KNA1 / LFA1 排除
//   W3 白名单**同时**约束既有 read_abap_table 路径（本模块即为此落地）
//   W4 单次返回行数上限 500，超时上限 30 秒
//
// 设计原则是**默认拒绝**：只有显式登记的表可读；未登记 = 拒绝。X 档除了不登记之外还单独
// 记录，以便错误信息能说明"这是被明确排除的敏感表"，而不是笼统的"未知表"。
//
// 本模块是只读白名单，不做任何 SAP 访问、不缓存业务数据。

import { SCOPED_QUERY_TABLE } from "./customer-scope.js"

/** 允许集分层，键为档位，值为该档的表名。 */
export const TABLE_TIERS = {
  /**
   * A 档：资源库 / 元数据。只读、无业务与个人数据。
   *
   * DD30L/DD31S/DD32S/DD33S 是搜索帮助的**物理存储表**（表头、成员、参数、字段分配），属于与
   * DD02L/DD03L 同类的纯 DDIC 元数据，无业务与个人数据。Q6 已提议纳入 A 档；D6-1h 进一步证明它是
   * **必需**的：`upsert_search_help` 写入后，只有直接查表才能判定"DD31S/DD33S 为空"究竟是
   * **写入丢弃**还是**读取过滤**——`read_search_help` 本身无法区分，仅凭它会把缺陷归因到错误的一侧。
   *
   * DD30V/DD31V/DD32P/DD33V 是 DDIF 的**接口结构体**（经 `read_ddic_structure` 证实 `DD31V` 5 字段、
   * `DD32P` 29 字段、`DD33V` 8 字段，`package=SDSH`），**不是存储表**，`read_abap_table` 读它们必然
   * 失败；登记它们无害（既非业务数据也不敏感），但真正有用的是上面那四张表。DD30V 例外：它在 w200
   * 确实是一张可读的表，且是本轮推翻"DDTEXT 只有 35 宽"这一错误结论的关键证据（该列实为 C60，且表内
   * 存在 145 条超过 35 字符的描述）。
   */
  metadata: [
    "DD02L",
    "DD03L",
    "DD04L",
    "DD01L",
    "DD07L",
    "TADIR",
    "TFDIR",
    "E070",
    "E071",
    // E07T holds the CTS request/task **texts** (TRKORR + LANGU + AS4TEXT). E070 carries no
    // description column, so without E07T a request number can be read back but its short text
    // cannot - and the text is the only human-meaningful key when several requests exist. It is
    // the same class of pure transport metadata as E070/E071, with no business or personal data.
    "E07T",
    "DD30L",
    "DD30V",
    "DD31S",
    "DD31V",
    "DD32P",
    "DD32S",
    "DD33S",
    "DD33V"
  ],
  /** B 档：定制 / 组织架构。低敏感。 */
  customizing: ["T000", "T001", "T001W", "T005", "T005T", "TSTC", "TSTCT", "T002", "T006", "T006A"],
  /** C 档：业务主数据 / 凭证。**逐表批准**，此处仅登记已获批准者。 */
  business: [SCOPED_QUERY_TABLE],
  /**
   * 产品必需档：由 `src` 调用点清点得出，**不是** D5-2 取证候选表的子集。
   *
   * D5-2 的 35 张候选表来自人工选取，并未清点"产品自己读哪些表"。启用默认拒绝后，清点发现
   * 三个既有功能依赖的读目标不在候选表内，若不登记就会被新白名单打断：
   *   SXCI  —— Classic BAdI 定义投影（contracts.ts 明确其"仓库投影"语义）
   *   VARID —— 报表变体读取（report-variants.ts）
   *   TBATG —— DDIC 激活日志读取（tools.ts）
   *   （DD04L 亦为产品必需，但已在 A 档。）
   *
   * 这一档的存在本身即是发现：**白名单必须同时覆盖"产品必需"，否则安全加固会变成功能回退。**
   */
  productRequired: ["SXCI", "VARID", "TBATG"],
  /**
   * 格式与文本载体档：D7 规格 §8.2 的**间接访问门禁登记**（2026-09-24 用户逐项授权后登记）。
   *
   * 这些表**已经**被 SAP 侧助手在 ABAP 内间接读取：`read_smartstyle` 经 `SSF_READ_STYLE`/
   * `SSF_READ_SAPSCRIPT_STYLE` 读 `STXS*` 族，`read_adobe_form` 经
   * `cl_fp_db_wrapper=>sel_lt_by_name_lang` 读 `FPLAYOUTT`。既然它们事实上已被读取，登记它们
   * 是把这条既有读取路径**变得可审计**，而不是新增能力——规格明确要求"不得以'白名单没报错'
   * 推断没读"，因此登记本身即是门禁声明。
   *
   * 分类依据：`STXS*`/`FPLAYOUT*`/`FPINTERFACE*` 是格式定义（段落、字符格式、制表位、XDP 布局），
   * `STXH`/`STXL` 是 SAPscript 文档文本载体。均为客户可读的文本/格式元数据，不含口令、个人数据
   * 或财务凭证明细（对照 X 档）。
   *
   * 登记后的直接用途：① 用 `read_abap_table` 独立核对助手返回的条数（D7 §3 的可选一致性判据）；
   * ② 从服务侧发现既有对象名，而不必依赖调用方提供。**未登记 `SSF*` 运行时结构**——那些是接口
   * 结构体而非存储表，登记它们只会制造误导。
   */
  indirectFormatReads: [
    "STXSHEAD",
    "STXSPARA",
    "STXSCHAR",
    "STXSTAB",
    "STXH",
    "STXL",
    "FPLAYOUT",
    "FPLAYOUTT",
    "FPINTERFACE",
    "FPINTERFACET"
  ]
} as const

/**
 * X 档：**永不列入**。仅供错误信息解释拒绝原因，不参与允许判定。
 *
 * 单独列出这些表是因为它们一旦可读即为安全事故（口令哈希、HR 个人数据、财务凭证明细），
 * 值得在日志与错误里明确指认，而不是退化成一个普通的"表名不在白名单"。
 */
export const TABLE_NEVER_ALLOWED = [
  "USR02", // 用户主记录，含口令哈希与登录失败计数
  "USR01", // 用户主记录（个人设置）
  "PA0001", // HR 个人数据：组织分配
  "PA0008", // HR 个人数据：基本工资
  "BSEG", // 财务凭证明细行，且为簇表
  "CDHRS" // 变更凭证，含字段旧值与新值
] as const

/**
 * C 档中**已取证但尚未逐表批准**的表。W2 已明确排除 KNA1/LFA1。
 *
 * 单独列出是为了让拒绝信息可区分"等你批准"与"根本没考虑过"——两者对调用方的可操作性不同。
 */
export const TABLE_PENDING_APPROVAL = ["MARA", "MAKT", "MARC", "MARD", "EKKO", "VBAK"] as const

/** W4：单次返回行数上限。与既有 read_abap_table 的 maxRows 契约保持一致，避免两套上限。 */
export const ALLOWLIST_MAX_ROWS = 500

/** W4：超时上限（毫秒）。 */
export const ALLOWLIST_TIMEOUT_MS = 30_000

const allowed = new Set<string>([
  ...TABLE_TIERS.metadata,
  ...TABLE_TIERS.customizing,
  ...TABLE_TIERS.business,
  ...TABLE_TIERS.productRequired,
  ...TABLE_TIERS.indirectFormatReads
])

const neverAllowed = new Set<string>(TABLE_NEVER_ALLOWED)
const pendingApproval = new Set<string>(TABLE_PENDING_APPROVAL)

/** 规范化表名：去空白、转大写。调用方可能传入小写。 */
export function normalizeAllowlistTableName(tableName: string): string {
  return String(tableName ?? "")
    .trim()
    .toUpperCase()
}

/** 该表是否在允许集内。默认拒绝。 */
export function isTableAllowed(tableName: string): boolean {
  return allowed.has(normalizeAllowlistTableName(tableName))
}

/** 允许集的稳定有序快照，供 D5-3 的白名单清单能力使用。 */
export function listAllowedTables(): string[] {
  return [...allowed].sort()
}

/**
 * 判定被拒绝的原因。区分三档，便于调用方自助纠正而不是反复试错：
 *   `never_allowed`      —— X 档，明确永不开放
 *   `pending_approval`   —— C 档已取证但待逐表批准
 *   `not_allowlisted`    —— 从未纳入白名单
 */
export function describeAllowlistRejection(
  tableName: string
): "never_allowed" | "pending_approval" | "not_allowlisted" | null {
  const name = normalizeAllowlistTableName(tableName)
  if (allowed.has(name)) return null
  if (neverAllowed.has(name)) return "never_allowed"
  if (pendingApproval.has(name)) return "pending_approval"
  return "not_allowlisted"
}

/**
 * 允许集判定的稳定错误码。调用方按码分支，不要解析英文句子。
 */
export const TABLE_NOT_ALLOWED = "TABLE_NOT_ALLOWED"

/**
 * 语句里的表名无法静态枚举时的稳定错误码（动态表名、`FROM` 后不是标识符、逗号连接的多表清单）。
 *
 * 与 `TABLE_NOT_ALLOWED` 分开：前者是"表被拒"，这里是"根本说不清读的是哪张表"，后者必须同样
 * 拒绝并要求调用方改写成可枚举的形式，否则白名单可以被一句动态 SQL 绕过。
 */
export const TABLE_ALLOWLIST_UNVERIFIABLE = "TABLE_ALLOWLIST_UNVERIFIABLE"

/**
 * 断言表在允许集内，否则抛出带稳定码的错误。
 *
 * 抛错而非返回布尔值，是为了让调用点无法"忘记检查"——漏掉返回值会被类型系统或运行时挡住。
 */
export function assertTableAllowed(tableName: string): void {
  const reason = describeAllowlistRejection(tableName)
  if (reason === null) return
  const name = normalizeAllowlistTableName(tableName)
  const detail =
    reason === "never_allowed"
      ? "explicitly excluded as sensitive (D5-2 ruling W1/X tier)"
      : reason === "pending_approval"
        ? "collected but not yet individually approved (D5-2 ruling W1/C tier)"
        : "not present in the D5-2 allowlist (default deny)"
  throw new Error(`${TABLE_NOT_ALLOWED}: table ${name} is ${detail}`)
}
