# r74 最终计划：先部署独立只读原生控制块 API

时间 2026-10-07T16:36:48.836+08:00；依据 [r73 实际只读验收](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-maintenance-route-acceptance-20261007-163648-r73.md) 和原 SPRO backlog，沿用 API-only、单代理及脏工作区保护。

## 当前进度

r73 已在 w200/200/WYS 实际识别 BF24→SM30→TBE24→BFTM0090；完整客户产品清单含 ZFICHK、ZWMS_MM。ZFICHK 停用预览只列 AKTIV 差异，真实事件00001025及 handler接口已读，没有实际停用或业务执行。CFG-07 仍缺产品保存/恢复、关联写、规则及业务生效链；CFG-08 无具体目标域/组织键/目标值。全 SPRO 自动配置未完成。r72 的 KNM 恢复及最终 STATE 收口保持限定域历史证据，不复用已耗尽 r71 写预算。

## 目标与最小交付

1. 按 [已备完整审阅包](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bte-native-meta-deployment-review-20261007-163320-r74.md) 准备对象级部署：新 ZORVANTA_BTE_CFG 与 Z_ORVANTA_CFG_BTE_META（含本组自动生成 TOP/UXX 依赖）。完整源155行、全部ABI、标准源/结构/type证据已保存。对象批准后先核实真实存在性/草稿/锁、ZABAP、开发472/任务492状态及依赖版本，不覆盖其他工作。
2. 创建/激活后回读全部源与真实ABI、diagnostics及实际质量能力；构建固定并仅最多两次 native META 正常只读验收。读前后核对配置/关联/各语言文本和CP_INFO缓存（先确认其实际DDIC读路径），没有新增配置CTS。父组与当前BC组独立。失败/未知部署回执先对账，不重放。
3. 新API只暴露TBE24的VIMDESC/VIMNAMTAB/TVIMF；EV_FRESH为空，明确标准缓存和非原子性。接入一个专用只读MCP工具，钉住真实source/ABI和结构，调用前后元数据匹配；不得变成任意维护对象或通用函数执行器。
4. 据真实控制块和所有实际回调继续准备产品AKTIV保存/恢复完整候选：锁内完整前态/版本、显示与修改权限区分、标准API无对话/单提交、产品文本/关联保持、键级CTS归属、TCONT缓存更新、异常/未知对账。证据不够则执行保持关闭，不能为了“全自动”跳过标准副作用。

## 验收条件与依赖

- 准确活动SOURCE/ABI、声明92/33字段的实际RFC序列化、真实native控制块与回调源；仅readOnly证明，不把缓存头当新鲜写许可。
- 配置/文本/关联/CP_INFO前后保持原值，最多两次正常原生命令及明确read-only回包，无产品SAVE、BC Set、handler、CTS配置写/清理或释放。标准权限审计可以产生安全日志，单独声明。
- 最小源/接口/MCP规则有区分力的测试和真实公开调用；当前质量工具支持范围按实际结果，不把语法诊断当业务验证。
- 产品实际启用/停用、配置录制/恢复及业务触发仍需完整实际值和独立批准预算。

新客户对象尚未获具体部署批准；本任务开发/AI测试和只读调查授权继续有效，不要求重复通用批准。审批问题限定这两个新客户对象及只读验收，不能扩大到产品写。共享服务不自动升级、请求不释放、口令不持久化。阶段结束继续主动规划下一步。
