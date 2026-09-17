# 第三批候选版 0.36.36

状态：Partially Verified。日期：2026-09-11。

0.36.36增加TPMODE域固定值校验：核对ZPMCDO_TP_MODE定义后允许S、E及空值；单空格规范化为空串，非法提案在配置行读取前拒绝。返回domainMetadata和有效预览的domainValueValidation；validation改为structural_and_domain。调用方若严格判断旧structural_only值，需要更新。新增源码已由用户完成471项回归及9项入口检查，真实合法/非法模式提案验收待完成。

0.36.35的10项有效类型、长度、小数位和域关联检查已通过人工真实预览与指纹拒绝验收。新版本保留该检查并增加一次域读取，不缓存、不保证事务快照。模式域值合法不代表809P适合切换业务模式；ACTIVE业务规则、模式切换条件和配置保存仍未验证或提供。

人工验收使用源码目录test-mvp-batch3-sap.cmd：mode-valid仅预览809P的TPMODE从S到E，mode-invalid提案为?，仅准确域值错误算预期拒绝；每次单独选择、输入READ，不自动重试、不保存。先核对运行版本和产物指纹。报告可能包含配置值，分享前脱敏。

0.36.34的Unit正反断言、未知耗时兼容及有限SCI预检查/执行已获得人工报告。SCI零发现不等于代码质量通过，也没有逐规则完成证明。

## 交付内容

- preview_configuration：固定 w200/200、ZTPMC_TPCFG、准确四位工厂，读取和提案差异预览，不保存。ACTIVE/TPMODE仅结构校验，不证明业务值合法；不接受主键、CFGVERS或审计字段修改。
- run_unit_tests：新增 outputFormat=json，区分 passed、failed、no_tests、not_executed。后台异常仍返回工具错误。
- 源码静态注册91个工具，注册数量不是实际SAP功能验收结果。

## 启动与配置

保留旧安装包和现有状态目录。在旧设置中心停止服务；若提示忙，等待操作完成，不强制结束进程。然后打开本包 open-settings.cmd，核对连接、语言和端口，通过安全页面重新输入密码并启动。不要同时让新旧服务争用4847。

不要清空状态目录、操作回执或诊断授权文件。包内connections.json是出厂配置，不代表旧服务的实际配置；特别注意语言设置。不要将密码写入配置文件或回传日志。

本候选包的构建采用 SkipRuntimeCheck，不自动运行测试，也不自动替换正在运行的服务。

## 人工验收

本地回归入口位于源码工作区：test-mvp-batch3.cmd，或 npm run test:mvp-batch3。它测试当前编译源码，不验证运行中的安装包。回传 Report 所示的 result.json 和必要日志。安装包不包含开发依赖或本地回归入口。

真实SAP断言对象 ZCODEX_MVP3_UNIT 已于2026-09-11创建并激活，包ZABAP，请求GR2K923421、任务GR2K923422，语法检查无错误警告；尚未运行测试。人工执行 run_unit_tests，connectionId为w200，objectName为ZCODEX_MVP3_UNIT，outputFormat为json。

预期 ADDITION_PASSES 正常，INTENTIONAL_FAILURE 故意断言失败，整体failed。这是对照验收的预期，不可据此宣布全部回归通过。若无方法、未执行或整体passed，则不能通过此项验收。

配置预览需要用户指定允许读取的真实工厂。先changes={}，预期唯一行、空差异、行指纹、saveAvailable=false；读取错误不可伪装不存在。不要为验收创建配置或猜测工厂。

## 未交付边界

不包含配置保存、SM30业务事件验证、完整ATC或所有SCI规则完成证明。不自动执行测试、不释放请求、不清理故意失败的测试方法。所有实际验收结果与本次构建证据分别保存。
