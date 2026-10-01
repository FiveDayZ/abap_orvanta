# 发布与打包流程

- 适用范围：`abap-mcp-standalone` 便携包（Windows x64）
- 目标：**每个交付物都能由一个 git 提交重建**，并且能回答「这个包里到底是哪份代码」

## 1. 版本号

一次发布只允许存在一个版本号，三处必须一致：

| 位置                | 说明                                                        |
| ------------------- | ----------------------------------------------------------- |
| `src/version.ts`    | `PRODUCT_VERSION`，运行时与 MCP `server.version` 的唯一来源 |
| `package.json`      | `version`，打包目录名与 `BUILD-INFO.json` 的来源            |
| `package-lock.json` | 根部与 `packages[""]` 两处 `version`                        |

打包脚本会用包内自带的 node 执行 `PRODUCT_VERSION` 并与 `package.json` 比对，不一致直接失败（`-SkipRuntimeCheck` 可跳过，仅用于明确知道原因的排查）。

## 2. 构建前

```powershell
npm run format:check
npm run typecheck
npm run matrix:check        # 工具注册表与 docs/tool-index.md、contracts/tool-index.json 一致
npm test                    # 由人工执行
```

自动化测试、SAP 验收脚本与运行时回归按人工优先原则由测试人员执行；没有人工测试证据时，不得把本次变更描述为「验证通过」。

## 3. 打包

```powershell
pwsh -NoLogo -NoProfile -File scripts/package-windows.ps1
# 候选包：-CandidateSuffix rc1
# 覆盖同名产物：-ReplaceExisting（需先人工确认旧产物可以丢弃）
```

- **工作树必须干净**。存在未提交改动时脚本会拒绝打包并列出前 10 项改动，因为这样的产物无法由任何提交重建。
- 只有在明确不需要复现的临时候选包场景下才使用 `-AllowDirty`；此时包内 `BUILD-INFO.json` 会记录 `standaloneSourceDirty = true`，该标记不得在评审中被忽略。
- 脚本不会修改 SAP，也不会创建或释放传输。

## 4. 产物

```text
release/
  orvanta-mcp-<version>[-<suffix>]-win-x64/      # 解压后的便携目录
  orvanta-mcp-<version>[-<suffix>]-win-x64.zip   # 交付归档
  orvanta-mcp-<version>[-<suffix>]-win-x64.zip.sha256
  INDEX.md                                       # 归档索引（脚本追加，不纳入版本控制）
```

包内 `BUILD-INFO.json` 是权威溯源信息：

| 字段                                   | 含义                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `version` / `platform` / `nodeVersion` | 版本与运行时                                                                      |
| `runtimeVersionCheck`                  | 包内 `PRODUCT_VERSION` 与 `package.json` 的一致性检查结果                         |
| `standaloneSourceCommit`               | 打包所用提交                                                                      |
| `standaloneSourceDirty`                | 该提交之外是否还有未提交改动                                                      |
| `fileSha256`                           | 除 `node_modules` 外全部打包文件的 SHA-256（依赖由 `app/package-lock.json` 固定） |
| `builtAt`                              | 构建时间（本地时区偏移）                                                          |

`release/` 不纳入版本控制；`INDEX.md` 只是本地横向比对用的便利索引，不是证据。**证据是 `BUILD-INFO.json` 与对应的 git 提交/标签。**

## 5. 归档保留

保留窗口是最近 **5** 个 `orvanta-mcp-*-win-x64*.zip` 产物。窗口外的产物**不再只是警告**：打包脚本在写完索引后调用

```powershell
pwsh -NoLogo -NoProfile -File scripts/quarantine-release-artifacts.ps1            # 只报告计划
pwsh -NoLogo -NoProfile -File scripts/quarantine-release-artifacts.ps1 -Apply     # 执行
```

把窗口外的 `.zip`、同名 `.zip.sha256` 与对应解包目录，以及**没有对应 zip 的散落解包目录与历史遗留目录**，**移动**（绝不删除）到 `release/quarantine/`。这样做的原因有两个：解包目录里的 `connections.json` 携带真实内网主机与用户名，长期散落在 `release/` 会扩大泄露面；而移动是可逆的，产物仍然可回溯。

被服务占用而无法移动的路径会逐条报告，脚本以非零码退出，需要人工处理后重跑。

## 6. 标签

发布完成后对打包所用提交打附注标签：

```powershell
git tag -a v<version> -m "<一句话说明>"
git rev-list -n 1 v<version>   # 应与 BUILD-INFO.json 的 standaloneSourceCommit 相同
```

标签与 `standaloneSourceCommit` 不一致时，不得声称该产物对应该标签。

## 7. SAP 侧助手部署（人工 F8）

服务侧代码可以先发布，但**依赖新操作码的工具在助手部署前一律不可用**：助手的处理分支运行在 SAP 内，未部署时调用返回 `OPERATION_NOT_SUPPORTED`。因此助手部署是发布清单中的正式步骤，不是收尾杂事。

### 7.1 为什么必须人工

仓库助手族（`Z_ORVANTA_MCP_EXECUTE` / `Z_ORVANTA_MCP_DYNPRO_API`）位于函数组 `ZORVANTA_MCP_CORE` 内，而该函数组带有自写保护：服务不得修改自己的助手（否则一次错误写入就能让服务失去修复自身的能力）。**该自写保护只覆盖核心组**：`Z_ORVANTA_MAINT_READ`（`ZORVANTA_MAINT`）与 `Z_ORVANTA_OPS_READ`（`ZORVANTA_LOG`）都在组外——服务侧契约对它们仍然只读，且 SAP_BASIS 7.31 上对函数模块自身 `source/main` 的 ADT 写入一律被拒（HTTP 423；2026-09-18 到达写入阶段的 12 次尝试全部失败，无一成功），因此它们同样只能经载体部署。每次助手变更都必须由人在 SAP 内执行：

1. 仓库内用生成器产出**载体程序**（`scripts/generate-*-carrier*.mjs` / `generate-*-deploy-report.mjs`），得到 `.doc/deploy-*.abap` 与逐字**部署报告**。报告必须包含 `SOURCE|HASH`、操作码清单、`PROTOCOL|MIN/MAX`、载体修订号（`rNN`）、正文行数与 digest。
2. 人工用 SE38 执行该载体程序**并运行（F8）**生成助手主体，回传 `OK: generated and activated.` 级别的回执。
3. 用 `verify-*-carrier-deployed.mjs` 之类的校验脚本核对线上 include 行数、marker 与特征字符串，再用 `get_capability_report` 复核 `PROTOCOL|MAX` 与操作码清单。

载体带有**基线守卫**：对同一个载体重复 F8 会以 `deployed include is not the reviewed baseline` 失败。**这是保护，不是部署失败**——它阻止把已更新的对象按旧基线覆盖。看到该错误时先核对 include 行数（应为「正文行数 + 32」），不要重新生成载体。

### 7.2 两条不可混淆的刻度

| 助手族                                                             | 协议刻度 | 载体                               |
| ------------------------------------------------------------------ | -------- | ---------------------------------- |
| DDIC（`Z_ORVANTA_MCP_DDIC_API`）                                   | `1.x`    | 独立载体                           |
| repository（`Z_ORVANTA_MCP_EXECUTE` / `Z_ORVANTA_MCP_DYNPRO_API`） | `2.x`    | 独立载体                           |
| maintenance（`Z_ORVANTA_MAINT_READ`）                              | `1.x`    | 独立载体（仅正文，接口段原样保留） |

两个刻度互相独立，**不得互相换算或混用**。能力报告中的 `helpers` 与 `helperAttestation` 按族分别自述，判断可用性时必须看对应族。

### 7.3 载体顺序不变量

载体必须**针对上一载体 F8 成功后的实际线上源码**重新生成；否则基线守卫会拒绝，或更糟——把别人的改动当作自己的基线覆盖掉。因此：一次只部署一个载体，部署成功并复核后再生成下一个。

### 7.4 指纹重钉

- **仅函数体变更**：`interfaceFingerprint` 不变，无需重钉，也无需重新审批接口。
- **接口签名变更**：必须重新钉 `interfaceFingerprint`，并重新走接口审批；此时该载体涉及的所有工具都必须重新验收。

部署记录按工作区规范写入 `.doc/code-update-YYYYMMDD-HHmmss.md`，并同步更新 `contracts/verification-registry.json` 中对应条目的 `status`、`lastAttemptAt` 与 `evidence`——**只有真实调用成功才能从 `unverified` 升为 `verified`**（见 `docs/helper-capabilities-protocol.md` 与验收登记表设计）。

### 7.5 `unsupported` 不是发布缺陷（`remedy` 字段）

安装、重打包或重启 MCP 服务**不会**改变 SAP 侧助手协议——助手正文在 SAP 内。因此版本检查得出的 `unsupported` 是关于 SAP 的陈述，不是关于本次发布包的缺陷。

为免这一区别被误读（曾发生：新包安装后仍报 `unsupported`，被当作发布包坏了），能力报告的版本类判定会附带 `remedy` 字段，写明需要执行的 SAP 侧步骤与载体程序名：

```json
{
  "availability": "unsupported",
  "reason": "The Z_ORVANTA_MCP_DDIC_API helper self-described protocol 1.12, which is below the required capability version 1.13.",
  "remedy": "Repackaging, reinstalling or restarting the MCP service cannot change the SAP-side helper protocol: the helper body lives in SAP. To satisfy this requirement, run the 1.13 carrier program ZORVANTA_MCP_DDIC_LOCK_DEPLOY in SE38 and press F8, then restart the MCP service and re-read the capability report."
}
```

载体程序名由 `src/helper-carriers.ts` 记录，并由 `test/helper-carriers.test.ts` 回读生成器脚本核对，改载体名会让测试失败而不是产出指向不存在程序的 `remedy`；尚未生成载体的助手族不臆造程序名，只指向本节。

### 7.6 读助手的 RFC 载体通道（2026-09-28 实测更正，按族区分）

§7.1 的"人工 F8"是**默认**通道，不是唯一通道：判断一个载体能否由服务侧自己跑起来，看的是**载体要生成的目标函数模块位于哪个函数组**，与该助手的工具是读还是写无关。

| 载体目标                                                                                                    | 通道                                                     | 依据                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标函数模块在 `ZORVANTA_MCP_CORE` 之外的助手（如只读助手 `Z_ORVANTA_MAINT_READ`，函数组 `ZORVANTA_MAINT`） | **可经 RFC 运行载体**（服务侧自行执行，无需操作员按 F8） | `Z_ORVANTA_RUN_PROGRAM` 位于**独立函数组**，因此能运行目标在他组的程序；2026-09-28 实测以此通道完成 `Z_ORVANTA_MAINT_READ` 正文部署（载体 `ZORVANTA_MAINT_DEPLOY_R02` / `R04`） |
| 仓库族助手（ `Z_ORVANTA_MCP_EXECUTE` / `Z_ORVANTA_MCP_DYNPRO_API`，函数组 `ZORVANTA_MCP_CORE`）             | **人工 SE38 + F8**                                       | 该函数组带自写保护（§7.1）；2026-10-01 实测确认了本行结论（见下表后的「RFC 通道对仓库族的实测结果」），故此组仍走 F8                                                            |

两条通道的后续步骤相同：部署后用 `get_capability_report` 复核 `PROTOCOL|MAX` 与操作码清单，并按要求更新 `contracts/verification-registry.json`。**通道选择不改变验收标准**——无论谁按下运行键，`verified` 仍需一次真实调用与一份耐久 `.doc` 证据。

#### RFC 通道对仓库族的实测结果（2026-10-01）

对仓库族又试过一次 RFC 通道，结论与上表一致，且这次留下了读数而不是推断：

- 载体 `ZORVANTA_MCP_DYN221` 由 `create_object_programmatically` 创建成功（10514 行、非活动/活动均无语法诊断），经 `test_remote_function_module(IV_PROGRAM=ZORVANTA_MCP_DYN221)` 运行后返回 `status=passed`、`outputs.EV_SUBRC="0"`。
- 但助手**没有变化**：`PROTOCOL|MAX|2.18` 仍是活动源码中的唯一刻度行，`'JOB_CREATE'` / `'JOB_MODIFY_HEADER'` / `'JOB_MODIFY_STEP'` / `'PROTOCOL|MAX|2.21'` 全部零命中，`get_version_history` 没有今天的新版本，载体的自述行 `PROTOCOL|MAX` 与线上仍是 `2.18`。
- 该载体自己的守卫不可能造成这次空转：payload 追加语句 9461 条，与守卫 `IF lv_count <> 9461` 逐字相等；线上 include 行数 8373 与基线守卫 `c_lines` 相等；线上正文既不含 2.21 的 marker 也不含 `fdd287...` 哈希前缀，幂等守卫不会提前返回。
- **根因判据**：`Z_ORVANTA_RUN_PROGRAM` 的实现是 `SUBMIT (lv_program) EXPORTING LIST TO MEMORY AND RETURN.` 后取 `sy-subrc`。因此 `EV_SUBRC = 0` 只说明「报告正常结束」，**不说明它写入了任何东西**；报告的 `WRITE` 列表留在 ABAP 内存里不回流，任何早期 `RETURN` 或 `INSERT REPORT`/`GENERATE REPORT` 的失败都对外完全不可见。这也解释了为什么本族的部署证据必须来自活动源码复读（`sourceHash` / `PROTOCOL|MAX` / 操作码命中），而不能来自载体回执。
- 附带更正一处事实：运行器 `Z_ORVANTA_RUN_PROGRAM` 位于**独立函数组 `ZORVANTA_RUNNER`**，与本族助手所在的 `ZORVANTA_MCP_CORE` 并不同组（依据：`/sap/bc/adt/functions/groups/zorvanta_runner/fmodules/z_orvanta_run_program/source/main`）。所以本族必须走 F8 的原因不是「同组」，而是该函数组的自写保护与上述不可见失败面——**不得**据此把运行器改成支撑仓库族。

#### 人工 F8 首次失败的根因：`CHANGING` 段不能与 `TABLES` 段同用（2026-10-01）

2.21 载体 `ZORVANTA_MCP_DYN221` 首次人工 F8 返回 `GENERATE failed: 无法解释 "JOB_READ_STEPLIST"`。定位、根因与修法如下，均取自同系统实测而非推断：

- **定位**：载体用 `GENERATE REPORT ... MESSAGE lv_msg LINE lv_msg_line WORD lv_msg_word` 取 SAP 自己的语法诊断，因此行号与词都是编译器的输出。include 行 7060 − 保留接口 73 行 − 1 空行 = payload 第 6986 行，即 `TABLES` / `job_read_steplist = lt_job_read_steps`。FM 接口的两份独立读数都确认该参数存在（`JOB_READ_STEPLIST STRUCTURE TBTCSTEP OPTIONAL`，与 `SPOOL_ATTRIBUTES` 同段），参数名、参数类别、内部表声明（`TYPE STANDARD TABLE OF tbtcstep`，与既有可用调用同形）均无误。
- **根因**：本批新增的 4 处调用是全文**仅有**同时给出 `CHANGING` 与 `TABLES` 的调用（两处 `BP_JOB_READ`、两处 `BP_JOB_MODIFY`）；其余 8 处 `TABLES` 调用以及 SAP 自带调用（`LBTCHFXX` 第 4491 行起）都只有 `EXPORTING / IMPORTING / TABLES / EXCEPTIONS`。**本版本 ABAP 不接受「`CHANGING` 段 + `TABLES` 段」的组合**：编译器把 `TABLES` 视为 `CHANGING` 段的续接，于是报出紧随其后的参数名而非 `TABLES` 本身，消息的「拼写错误或逗号错误」提示具有误导性。
- **编译仲裁（可复用）**：用 `create_object_programmatically` 建一个 31 行的临时报表，只放这段 `CALL FUNCTION`：带 `CHANGING` 时同一句报同样的 `无法解释 "JOB_READ_STEPLIST"`；去掉 `CHANGING` 后回执为 `Saved, unlocked, and activated`。该工具返回 SAP 自己的激活/语法裁定，可作为**部署前的编译预言机**，不必每次都占用操作员的 F8。
- **修法**：这 4 处调用的 `ret` 全程只写不读（`CLEAR` 之后从未被引用），故删除 `CHANGING` 段与 `lv_job_read_ret` 声明；正文由 9461 行降到 9452 行，sha256 变为 `e2f1913b4e6c52169e28ca2ad10974627b773be4969d8ef03d1a18323d6208f1`，`maxProtocol` 仍为 **2.21**（本次只改正文，不动协议刻度）。SAP 自带调用同样不传 `ret`。
- **载体**：修复后的 2.21 载体 `ZORVANTA_MCP_DYN223`（payload 9452 行、digest `893140fb141cc1be`、基线守卫 `c_lines 8373`、幂等 marker `ORVANTA REPO DYNPR 2.21 E2F1913B`）已在包 `ZABAP` / 传输 `GR2K923472` 创建并激活。**F8 是否成功一律以活动源码复读为准**（`sourceHash` / `PROTOCOL|MAX` / 操作码命中），不以载体自述或列表回执为准。

#### 类型 `T` 字段的 `IS INITIAL` 把「午夜」判成「没给」（2026-10-01 真机验收暴露）

部署成功不等于行为正确：2.21 落库后真机 `create_background_job`（`startTime = 2030-01-01T00:00:00`）返回 `JOB_START_TIME_INVALID` / “Start date and time are required”，而请求行里 `H|1|START_DATE|20300101` 与 `H|1|START_TIME|000000` 两条都在。

- **根因**：`JOB_CREATE` 臂用 `lv_job_start_time IS INITIAL` 判断调用方有没有给开始时间，而该变量是 `TYPE tbtcjob-sdlstrttm`——`TBTCO-SDLSTRTTM` 在 DDIC 里是**报表类型 `T`**（`read_abap_table` 的 `fieldMetadata` 读数：`SDLSTRTTM TYPE=T LEN=000006`，同表的 `SDLSTRTDT TYPE=D`）。类型 `T` 的初始值就是 `'000000'`，于是**午夜与「未提供」在字段内容上完全同形**，合法的午夜排程被守卫拒绝。`JOB_MODIFY_HEADER` 臂同病：配对守卫与「是否应用新排程」的判定同样用 `IS INITIAL`，会把 `00:00:00` 读成「只给了日期」。
- **判据**：对类型 `D`/`T`/`NUMC`/`INT`/`DEC` 这类字段，**不得用 `IS INITIAL` 判断「调用方是否提供」**——`00000000` / `000000` / `0` 都是合法值。提供与否要另存标志位（本次为 `lv_job_start_date_given` / `lv_job_start_time_given TYPE c`），值本身继续走原有的数值校验（`CN '0123456789'`）。
- **扫描面**：全文按「数值/日期/时间类型变量的 `IS INITIAL` 测试」扫描后，其余命中都属于查找结果或计数器（`lv_enh_extid`、`lv_fm_body_start`、`lv_fm_verify_mismatch`），其 0 值确实等于「未找到」，无同类缺陷。
- **修法**：生成器 `scripts/bootstrap-sap-helper.ps1` 增加两个存在标志；create 臂 1 处守卫、modify-header 臂 3 处判据（配对守卫、应用排程、读回比对）全部改用标志；正文由 9452 行增到 **9460 行**，sha256 `4f3d94e2080df5a1beb9b8e59db4ed9d9b02c0accc0f8eb9f6c6f2c735e0b2a3`，`maxProtocol` 仍为 **2.21**（只改正文）。
- **服务侧同批钉住**：新增回归测试断言 `jobStartTime("2030-01-01T00:00:00") === {date:"20300101", time:"000000"}` 且 `jobSourceRows` 原样发出 `H|1|START_TIME|000000`，即服务不得把午夜归一化成「缺省」。
- **载体**：修复后的载体 `ZORVANTA_MCP_DYN224`（payload 9462 行、digest `28432a0d18caf399`、包 `ZABAP` / 传输 `GR2K923472`）已创建并激活。

## 8. 禁止事项

- 不得用未提交的工作树产出发布版（唯一例外是显式 `-AllowDirty` 的临时候选包，且必须如实标注）。
- 不得手工修改包内 `BUILD-INFO.json`、`.sha256` 或 `INDEX.md`。
- 不得把 `release/` 提交进仓库（`.gitignore` 已排除，根目录 `*.zip` 同样排除）。
- 不得在没有 SAP 侧授权的情况下用打包脚本或安装脚本执行任何 SAP 操作。
