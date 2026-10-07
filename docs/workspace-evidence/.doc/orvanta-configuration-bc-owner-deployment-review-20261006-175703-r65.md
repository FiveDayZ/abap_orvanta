# r65：BC Set原生执行、恢复与对账部署审阅

时间：2026-10-06T17:57:03.737+08:00，Asia/Shanghai。状态：**Partially Verified**。本文件是具体候选审阅，不是新增SAP写入授权。

## 1. 交付与边界

本地已接入 apply_configuration_bc_set、recover_configuration_bc_set、reconcile_configuration_bc_execution。仅 EHS_CUNI_KNM/N、w200/GR2/client200、当前认证用户、Customizing GR2K923429/任务GR2K923430。前态/effects必须由服务端捕获并绑定用户。原生API、Include及标准依赖源/接口/布局首次与提交回应后再次检查；所有十九键在原生锁内完整比较。候选注册保持 unverified，尚未部署、编译或执行SAP原生命令。

API-only。十个新增行：T006 KNM一行；T006A SPRAS=1/D/E、MSEHI=KNM三行；T006B SPRAS=1/D/E、MSEH3=KNM三行；T006C SPRAS=1/D/E、MSEH6=kN/m2三行。完整值来自固定BC Set的SAP原生转换预览，不能从聊天示例造值。九个保护键：T006D PRESS一行、T006I KPA一行、T006J语言1/D/E KPA三行、T006T语言1/D/E PRESS三行、T006_OIB KNM一行（包含原缺行）。现有相关profile的任何记录/header/variables/link非空均拒绝；不覆盖已有配置。

## 2. 完整部署候选

开发包ZABAP；请求GR2K923472/任务GR2K923492。确切对象与全源如下。

- [ZORVANTA_CFG_BC_RECORD_KERNEL](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-record-kernel-20261006-175703-r65.abap) — PROG/I，698行，SHA256 ebbb5c52d63170864eb16009a1b76b721a0f11471279bfd00649a27b41fe0c22。
- [LZORVANTA_BC_CFGF65](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-owner-20261006-175703-r65.abap) — FUGR/I，1258行，SHA256 9fe3a887a5e7cceebb2533720230a880271bb5e05f5e09a37e2e94adefb03ec4。
- [Z_ORVANTA_CFG_BC_APPLY](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-apply-20261006-175703-r65.abap) — FUGR/FF，43行，SHA256 b91ec4b7604d03f84e3f91e80f63297c83daa9b26c12b618b7e09e604a65aa51。
- [Z_ORVANTA_CFG_BC_RECOVER](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-recover-20261006-175703-r65.abap) — FUGR/FF，43行，SHA256 db783e03e88e9800cb17b6fb05f3cb6947cf39d816197aafa1cbdd166b351a0b。
- [Z_ORVANTA_CFG_BC_RECONCILE](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-reconcile-20261006-175703-r65.abap) — FUGR/FF，43行，SHA256 73f5b6dd77f37357eaad0b2fae11b5fd9d96aa848b4a3c1acded8ad266697139。
- [LZORVANTA_BC_CFGTOP](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-top-after-20261006-175703-r65.abap) — FUGR/I，6行，SHA256 a02f3eb54accdb689f524883d97ad2ebb3776dc540df3a1f4d20598154514cb8。

[完整接口/源/指纹/预算JSON](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-owner-deployment-candidate-20261006-175703-r65.json)；[TOP原态](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-top-before-20261006-175703-r65.abap)。2026-10-06T09:50:14.746Z读取TOP完整3行、UXX完整20行及8个现有函数Include。TOP仅追加两个INCLUDE；不得手工编辑SAP自动生成UXX。新RFC创建时由SAP函数库管理新Uxx；现有8个RFC正文/接口不得改变。记录内核为普通PROG/I Include，owner为父组下FUGR/I，读取使用实际source/main URI。

部署顺序：重读父组全源/锁/任务及6个目标对象是否已有他人草稿，保存不可变基线；先创建完整内核与owner Include，添加TOP的唯一匹配补丁，再创建3个STRING参数remote-enabled RFC，统一激活父组及依赖。因新owner引用已有8个reader，必须复查它们的激活源和接口不变。出现语法/激活失败时记录原错并仅修正上述获批客户对象；不静默覆盖其他开发，不把未激活草稿当成功。

## 3. 权限、锁和真实标准路线

SCPR_AUTHORITY_CHECK TASK=ACTIVATE（实际源码要求S_TCODE SCPR20及S_BCSETS ACTVT07），每表S_TABU_DIS/S_TABU_NAM读权限，可写配置/关联表另查02。固定BC Set用ENQUEUE_E_SCPR scope1；25张表用真实ENQUEUE_E_TABLE/RSTABLE、空VARKEY的整表范围；429/430用ENQUEUE_E_TRKORR scope1。遇到相关既有锁拒绝，不等待或接管；只释放自己成功取得的锁，再用ENQUEUE_READ复核。整表范围意味着需要避开其他配置维护窗口；不代表没有并发成本。标准内部锁、缓存和scope释放必须在真实SAP验收中证明。

四张可写表均先经r64 lossless prepare，再用SCPR_PRSET_CT_ONE_TABLE_LOAD暂存；全部十行准备后才进入维护。正式links使用SCPR_HI_ACTLINKS_UPDATE，actlinks=W、task blank，写本地正式关联及完整header；变量本试点为空，非空拒绝。恢复用SCPR_HI_ACTLINKS_DELETE_UPD精确删除本次证明的links；标准API负责无记录profile的header/variables删除。完整allocation在锁内读回，必须仅新增十行；不复写他人profile。

CTS沿TR_REQ_CHECK_OBJECT/KEY与TRINT_APPEND_TO_COMM_ARRAYS无对话路线，只复用430已有R3TR/TDAT/CUNI、OBJFUNC=K对象，追加十个R3TR/TABU精确键。不新建、清理对象。全量E070/E070C/E071/E071K/E071K_STR保护，只有E070最后变更日期/时间允许变化；其他字段、既有键与字符串键逐字段保留。精确delta含完整E071K行，不仅TABKEY字符串。

TBD05 CONDAT、TBD72 CUNI、OBJM CUNI或当前client SCDTSYNC任何存在均拒绝。读取发现SCDC_DISTRIBUTE_TABLE_KEYS为updateTask，SCDC_GET_WORKPLACE可改变SCDTSYNC并调用远端/对话，因此本试点不跳过必要策略；不支持的策略在写入前明确拒绝。需要这些策略的配置活动仍未实现。

## 4. 提交、恢复与回应丢失

正式协议SCPR_ACTIV_PROTOCOL_WRITE在独立R/3*连接提交；历史协议保留，不能与配置rollback合并。B=开始、C=配置commit阶段完成、E=全部阶段读回完成；标准writer仅E flag更新ACTOPTIONS，因此C/E marker均调用E flag；以marker阶段区分，不以ACT_END非空独自证明成功。ACTOPTIONS CHAR80保存operation SHA256前32hex及frame SHA256前32hex（各128bit），本地保存完整SHA256与原生frame。该标准字段限制明确保留。

配置顶层仅一次COMMIT WORK AND WAIT，之前任何错误ROLLBACK；协议开始后失败仍保留历史并按未知保护目标。恢复先证明当前完整十九键、正式effects和CTS仍为本次候选，再删除十行、恢复原缺行/值并commit；随后TRINT_DELETE_COMM_KEYS内部独立DB_COMMIT清理本次十个精确delta。这个分段恢复不能声称单一原子rollback；任一阶段不明/失败都保留目标保护。

持久化顺序：保留目标→完整attestation→不可变intent及before/effects证据→再次attestation→持久化sapInvocationStarted→唯一原生调用→不可变native result→回应后attestation→最终回执。intent失败不派发；result/回执失败、故障、绑定错误、保护/CTS/effects/协议/锁证明缺项均unknown，不新建operationId绕过。只读RECONCILE以原回执hash和intent核对协议、完整现态/effects/CTS；丢失APPLY回应时可从标准协议marker重构frame并比较摘要。它不重写原回执、不释放目标保护、不执行恢复。未知原执行的自动恢复权限仍不开放，需人工明确接管方案。

## 5. 具体待批范围

A. 部署以上6个客户对象并激活，使用472/492；随后只读源/接口、诊断、可用ATC和8个旧reader回归。B. 独立固定构建中最多一次APPLY与一次RECOVER：KNM上述十行新增并读回后删除恢复原缺行，九保护键不变；使用429/430录制十键并在恢复commit后仅清理确定delta。正式本地links/header随试点创建/删除，独立历史协议保留，请求不释放。正常之外的拒绝路径先用本地测试和只读RECONCILE，不增加原生写预算。

当前仅开发/本地测试/只读SAP授权有效；A和B尚未获得具体授权。授权来源规则为项目AGENTS.md第6节“Modify only an explicitly approved Z* or Y* customer object”及第10节“Do not write business data merely to test unless the user explicitly authorizes it”。以前KG文本临时改值和r51/r59部署预算不覆盖本试点。

## 6. 验证与未覆盖

累计291项相关本地测试全部通过：第一次综合291项中3项因隔离运行根未映射历史证据失败，原断言未修改；补入原历史文件后对应66项全过，最终新增26项含SDK HTTP→真实ToolService→持久化→mock原生命令再次通过。TypeScript私有编译、格式、headless、204工具索引（133只读）、15族operations矩阵均过。实际SAP只读46调用、42成功、4次错误DDIC对象类型已用正确transparent reader修正；没有SAP命令、配置、CTS或协议写入。原始证据：[evidence](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-owner-evidence-20261006-175703-r65.json)。

P0：原生ECC7.31语法/激活/运行、scope锁跨commit、标准全局缓存/真实分配、事务/update-task效果以及实际配置/CTS读回未完成；需A/B具体许可和独立登录。P1：标准直接源/ABI及两个Include指纹不是整个传递调用图的证明，部署前继续检查必要写链；分发/ALE/after-import和非空profile明确不支持；未知原命令虽可只读对账，仍须人工接管，不能自动恢复。P2：CFG-07/08业务域/API及跨系统迁移/传输发布未完成。
