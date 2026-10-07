# r50：九表 19 个固定键的 API 激活预检

实际时间：2026-10-05T13:33:45.242+08:00（Asia/Shanghai）。计划依据实际验收和原 backlog，不构成未授权配置执行。

## 进度复盘
CFG-04 已有内容/影响分析、五表原生完整前态、USE 转换预览、真实 CUNI 九成员零方法路线；本次 C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-guard-acceptance-20261005-r49-repair.json 又完成四关联表八键正例与缺失观察。r49 状态 Passed 限 w200/GR2/200 WYS、EHS_CUNI_KNM/N 固定只读范围：7 行存在、T006_OIB/KNM 缺失，原生保护版本 1c4e09257f3b2699e7cb25834b3f398291706757008a6087f8d4118e1cc4ab9f，source/target/metadata 前后相同。登记只有 read_configuration_bc_guard 由 unverified 提升 verified，其余条目未改；没有激活/模拟/方法调用或配置写。

## 目标与最小交付
形成一个可审阅的只读预检契约，统一绑定 READ/PREVIEW/ROUTE/GUARD：五表 11 个源键与四表 8 个关联键合计 19 个固定键。输出完整 before、原生候选 after、将变化的五表行、需保持的共享 PRESS/KPA 关联行、client/语言、当前存在/缺失、source/target/candidate/metadata/guard 版本与源码/接口身份。不是整个 CUNI 的全部记录，不把 missing 解释为可以创建。

用最小本地模块及真正 MCP 契约测试完成编排，保留既有工具和公共输入兼容性；任一读失败、字段不全、身份/布局/键集/版本变化撤回整个预检。保持 executable/activationAvailable=false，直到标准 API、锁、配置 CTS、日志和恢复契约均有证据并取得具体业务操作授权。新 SAP 客户命令只准备可审阅源码/接口候选，不能自动部署未批准对象。

## 验收条件
1. 从最新实际数据前后复读，19 个固定键、完整字段、named missing、语言 1/D/E 和来源 client 001→200 都可追踪；五表候选与八关联键保护分开展示，不删 omitted 字段或覆盖共享配置。
2. 组合身份和所有原生版本须一致，变更任一来源/目标/候选/元数据/保护版本、少表少字段、重复键、方法新增或范围变化均拒绝；顺序复读仍明确 snapshot=false，不声称锁内原子快照。
3. 针对源码实际调用链继续确认 SCPR_ACTIV_MN_REMOTE_SUB → SCPR_ACTIV_MN_ACTIVATE → SCPR_PRSET_CT_IMPORT_INDUSTRY 的无对话路线、权限、锁、更新任务、CTS、独立日志提交和状态清理。完整源码取得不等于完整审查，NO_COMMIT 不代表所有分支原子。当前 OBJM=0，后续执行前仍重查。
4. 输出一次精确可审批的执行/恢复申请：系统/client/BC Set、值模式/语言、真实前后差异、准确 Customizing 请求/任务/业务键、标准提交点、超时/部分/未知结果的只读对账与恢复预算。不得继承 KG 临时描述测试授权作为整包激活授权，不释放请求。
5. 本地测试覆盖组合漂移、拒绝部分成功、未知结果处理及公开 schema；在真实接口完成后以固定构建验收，不把本次 r49 成功冒充新工具可用。

## 依赖与剩余风险
- P1：标准整包激活可能存在独立日志提交和部分结果；配置 CTS/日志/恢复操作未有本阶段具体预算。原生 GUARD 只有固定八键保护，不能保证 CUNI 全部影响范围。
- P2：本次 T006_OIB 行缺失，真实 populated 数值/FLTP 精度、非 WYS 权限不足和并发/ABA 未实测。本地拒绝测试不替代这些实证。
- P2：本次完整只读流程耗时约 625.5 秒；metadata/native 子调用多。后续核对重复读取成本，优化须保留所有前后绑定和拒绝条件，不用跨请求缓存掩盖漂移。
- P2：CFG-06 双侧变化/失败实证与 CFG-07 独立启用/业务触发仍待补；P3：CFG-08 需明确首个业务域和组织键，再依据真实标准 API 扩展。

继续 API-only；保留共享 MCP、默认 dist、原暂存和其他功能。不要求重复批准本地常规实现；只有具体新增 SAP 客户对象或真实配置操作超出现有授权时，先准备完整可审阅结果再确认。
