# r64：依据真实 SCPR 类型完成官方 CUNI 保存与恢复候选

2026-10-06T14:25:28.180+08:00，Asia/Shanghai。承接 r63 实际源码入口修复与[review](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-type-owner-review-20261006-142528-r63.md)，继续原 CFG01–08/API-only；不把源码读取完成算作全部 SPRO 自动化完成。原有本地开发/测试和只读分析授权持续，具体客户对象部署、配置写入及 CTS 清理仍按完整候选范围审批。

## 目标与最小交付

完成可逐行审阅的标准 API 保存/恢复客户桥、MCP 命令接入及预算/恢复/接管验收包，不再围绕已解决的 SCPR 类型缺失增设只读桥。固定首个闭环仍为 EHS_CUNI_KNM/N、w200/GR2/200、配置 GR2K923429/任务 GR2K923430，开发 GR2K923472/任务 GR2K923492。真实 nine-table/19-key 前态此前为8现存/11缺行；主要五表11候选键包含已存在且受保护 PRESS，最多10新增行，不能把11键全写一遍。锁内重新读取现态，不能用历史8/11代替 fresh。

## 实施任务及依赖顺序

1. 标准 typed 参数与 owner：用实际 %_CSCPR 中 SCPR_RECORD2/RECORDS/RAW2、SCPR_DESCR 和真实描述器工厂建立身份完整的参数；检查工厂未赋 OBJNAME/OBJTYPE/ACTIVITY 及 TABLE_UNSUITABLE 被忽略的分支，必须显式核对完整布局和固定 CUNI/T。读取其实际调用依赖，不猜字段/偏移/常量，不直接给外部 RFC 暴露深参数。
2. 写入所有权选择：从固定 CUNI 可达分支列出配置、正式 BC Set 关联/变量、CTS、协议、after-import、分发的必要效果。以实际 owner 契约选择高层或叶节点组合；不通过 NO_COMMIT/无对话假设消除独立提交，不擅自跳过标准必要效果。若不可补偿，明确阶段及人工接管条件，不能返回假的自动恢复。
3. 锁及 fresh：E_TABLE/E_TABLEE 同为 RSTABLE，复用实际 TABNAME/VARKEY 保护，不重复无意义 enqueues。证明 BC Set、九表/client/link分配及429/430锁的准确所有权和跨阶段持有范围；检查标准内部默认scope3 dequeue，失败清理只释放本命令锁。锁内再次核对全部 source/target/candidate/metadata/guard/CTS/effects 版本、用户/client、任务状态及所有者。
4. APPLY 与回执：复用不可变 format1/2 关联引用和 WriteOperationReceiptStore，预约后仅一次 native 执行；保护8键（包括应继续不存在的 OIB），逐字段核对全部19键及标准必要效果/CTS。超时或未知结果进入只读 RECONCILE，禁止新 operationId 盲重放。
5. RECOVER：使用 SAP 原生 typed 前态经官方 owner 恢复字段/FLTP/语言及缺行，精确恢复关联记录、header、variables、links；CTS 仅精确本次新增delta并保护既有 TDAT/CUNI/E071/K/K_STR。标准独立提交分段记录并读回，日志/分发/after-import不可补偿部分形成具体接管清单。非空共享 profile owner 尚缺，不自动声称支持；必要时明确首个实测的严格前态限制并保留该能力为后续需求。
6. 完成客户源、MCP合同/错误/并发/未知结果回归及实际候选差异后，才申请具体客户对象部署及10新增/恢复/CTS范围的业务测试授权。公开 EFFECTS 的真实SDK集成验收另定最小读取预算，不复用已经结束的 r59 原生验收预算。

## 验收条件

本地能检出缺失/异用户/交叉前态、标准源/接口/布局漂移、保护键改动、锁丢失、已有CTS误删、阶段失败、未知结果与重复调用；真实SAP经公开MCP入口证明标准官方保存、19键完整读回、保护8键、关联效果、准确CTS、释放本命令锁、持久化回执及恢复后的字段/缺行/链接/CTS对账。不以mock、编译或干净诊断代替真实配置写验收。

## 依赖与范围

已解决：SCPR 声明真实读取、DDIC行定义、真实描述器工厂与CUNI锁参数来源。P1依赖：完整无对话 owner/阶段语义、变量恢复 owner、锁跨提交证明及最终具体SAP写批准。P2：共享profile/跨用户并发与CFG07/08业务域。继续本地已授权实施无需重复申请；没有完整候选前不把计划当已实现，不提前发布命令或写占位分支。每阶段结束继续规划下一阶段，直到文档要求有对应实现与验收证据。
