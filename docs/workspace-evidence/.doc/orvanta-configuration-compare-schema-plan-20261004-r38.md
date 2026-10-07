# r38 下一阶段：跨系统计量单位比较的 MCP 参数契约

- 规划时间：2026-10-04T14:48:55+08:00；状态 planned_not_executed。完整 SPRO API 自动配置仍未结束。

## 当前证据与目标

r37 的实际 loopback MCP tools/list 在23个配置命名工具中确认 compare_configuration_unit 唯一缺少预期顶层参数。其 src/contracts.ts:2282 仍将带 from/to 跨字段 refine 的 ZodEffects 交给 SDK，实际 properties={}；应有 from、to、unitKey、language、ignoreFields。没有执行该工具或 SAP 调用，本观察 sapCalls=0。此 Medium 参数曝光缺陷影响客户端发现和自动编排，优先于构造新的配置写场景。

## 最小交付

1. 参照 r37 读取工具的修正，在 src/configuration-compare.ts 提供严格对象 input schema，保留原服务 schema 的不同系统规则；只调整本工具契约，不修改公共注册包装器、比较算法或其他功能。
2. 补充真实 MCP 协议回归：五字段可发现、from/to/unitKey/language 必需、ignoreFields 默认空、额外 execute/写控制拒绝、同系统/非法忽略字段/缺语言在 SAP 读取前拒绝；正常请求参数完整传递，失败侧不能输出无差异。
3. 增加23配置工具顶层参数契约检查，防止后续 refine 包装造成空 schema。使用当前实际对象契约和 SDK tools/list，不以 mock 单层业务结果替代真实接口元数据。

## 验收与依赖

- 本地隔离编译、格式、相关比较/读取/协议回归和索引/矩阵通过；保留其他任务暂存和默认 dist。
- 如安排真实跨系统验收，固定只读构建后在 w200/GR2/client200/WYS 和现有 w300/GR3/client300/GRIT 上读取 KG、ZH，同业务键比较；双方实际范围、版本、采样时间、差异及失败/截断状态留证。用户原有只读 AI 测试授权延续，当前两个独立实例都已关闭，需要手工输入各自口令，不保存或复用旧口令。
- 缺登录时实现可独立完成，真实跨系统行为保持 Partially Verified；不把本地 fixture 当当前两侧 SAP 数据验收。共享部署与其他工作流整合另核对，不主动重启服务。
- 本阶段不包含配置改值、native writer、CTS追加/清理/释放/导入、SAP源/DDIC变更或GUI。后续 CFG-02 已释放容器拒绝、权限/并发/API故障与完整rollback另找安全场景和具名授权；不释放429/430制造测试。

## 仍需推进的原任务

CFG-02 正例保存/恢复与本次 stale 拒绝已有具名证据，但真实并发及故障矩阵未齐；CFG-03/04/07/08 的专用 API 维护、业务效果与目标导入仍有缺口。只有对应真实验收完成才关闭原 backlog 项目。
