# r57：标准 API 保存、恢复及精确CTS补偿

时间 2026-10-06T07:42:19+08:00。规划以[r56实际部署](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261006-074219.md)、[新读标准owner证据](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-recovery-check-deployment-20261006-074219-r56.json)和原SPRO CFG-01～08任务为基线，不代表SAP写命令已实现或获准运行。API-only，保持单代理及既有接口；原生RCHECK验收是当前依赖。

## 目标与最小交付

先完成 r56 固定只读验收并保留原生转换/十九行 proof。随后交付一个固定 CUNI / EHS_CUNI_KNM / 九表十九键的完整标准命令候选和审阅包：明确 APPLY/RECONCILE/RECOVER 输入、动作、当前版本、锁所有者、提交责任、精确CTS录制/补偿、首根因及未知写回执。不新增通用SQL写、不创建第二套workflow/operation锁，不把当前只读检查器当写许可。

## 准确实施工作

1. 深入当前低层 SCPR_PRSET_CT_ONE_TABLE_LOAD 的真实owner：已确认591行中存在官方DELETE/MODIFY、不存在外层业务授权/锁/COMMIT，且更新后调用SCPR_HI_SCPRACTR_FILL。继续读取该callee、记录读取和CTS生成/追加/删除真实源码，确认全局激活链接、保护字段、语言和日志的必要语义，不能删掉必要标准效果以换取伪原子性。
2. 按当前真实9DDIC键确定表锁参数、排序与作用域，明确 E_TABLEE/E_TRKORR 的所有权和每条释放路径。已读 ENQUEUE_SCOPE=2、DEQUEUE_SCOPE=3；IMPORT_INDUSTRY使用仅TABNAME的解锁，不能假定外层锁持续。候选若无法证明必须先拒绝，不能先保存后补锁。
3. 锁内重新读取完整前态和版本，核对转换证据对应的新鲜native缓冲，校验所有字段与标准保护策略；固定记录逐行使用标准维护API，覆盖11个缺行的删除补偿、8个现存行的全字段复原；省略内容不得暗示删除。
4. 分离整包 IMPORT_INDUSTRY 的独立协议、日志、分发及解锁效应。已读 SCPR_ACTIV_PROTOCOL_WRITE 的 R/3*独立提交及 SCDC_GET_WORKPLACE 的SCDTSYNC写/远程调用；只有逐项真实可达性和恢复策略闭合才能选路线，不以 NO_COMMIT 宣称全回滚。
5. CTS只补偿本次精确新增对象/键，保留历史2对象和所有无关行，包括固定空格和字符串键；绑定开放Customizing任务/所有者/client。超时先读值/CTS/锁/日志和历史提交，再按已有WriteOperationReceiptStore对账；未知写不得重放。

## 验收条件

先本地完整候选及针对失锁、过期前态、部分写/CTS失败、重复operationId、保护字段、恢复中断的有效测试；静态及编译通过后给出准确SAP客户对象、完整源码、配置前后值、原生命令次数、提交/独立效果预算和恢复清单。真实保存及恢复测试仅按新的准确批准执行，不能沿用过去KG单字段临时测试或号码区间预算。最终持久化值、旁路键、CTS、日志/激活链接、锁释放必须逐项证明。

## 依赖、阻塞及累计缺口

P1：r56原生验收待登录；完整低层标准调用的锁/日志/提交所有权及CTS精确补偿未闭合。P2：FLTP非零/极值/负零、初始D/T和真实字符串CTS键仍需原生样例。沿用开发、只读和本地测试授权，不自动扩大SAP对象或业务写范围。

CFG-01/05对象及IMG导航已有早期交付/人工核对；CFG-02计量单位单字段曾保存恢复但整域链路不等同已完成；CFG-03专用号码对象/区间曾做受控验收；CFG-04本轮只关闭客户检查器部署，标准激活/恢复仍未运行；CFG-06已有跨系统读取和比较，完整失败/稳定键矩阵仍需复核；CFG-07逐业务动作和真实触发、CFG-08领域配置仍有任务。以上早期结果来源于同一会话及已有记录，未在本轮全部复验，不据此声明总体完成。
