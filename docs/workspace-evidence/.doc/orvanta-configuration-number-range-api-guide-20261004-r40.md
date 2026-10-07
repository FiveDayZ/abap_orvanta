# 号码范围公开 MCP API（r40）

适用基线：2026-10-04，w200 / GR2 / client 200，ECC 7.31。状态：本地接口和回执集成已实现；客户 RFC 未部署，真实正例未验收。只读缺失路径已实际验证。本文不代替 SAP 权限、具体配置写批准或原生验收。

## 调用顺序和结果解释

1. `read_configuration_number_range_api` 输入仅 connectionId=w200 与客户 objectName。它检查 TNRO/NRIV 完整布局、客户 reader 实现/接口和哈希标准 API，返回完整 snapshot。仅成功时的 `snapshot.EV_VERSION` 可用于下一步；缺失或失败不提供版本。旧定义 SHA-1 和其他投影指纹不能替代。
2. `apply_configuration_number_range` 输入下表全部 11 个字段。创建/修改单个间隔；所有间隔共用对象级完整版本和保护目标。实际业务保存前须有具体授权，schema 中两个 acknowledgment 不代表用户已授予项目执行权限。
3. 初始响应和后续 `reconcile_configuration_number_range` 使用同一个 operationId。对账只观察当前完整版本并保留历史回执，不能通过当前值推断某次提交或恢复成功。

| 保存字段 | 规则 |
| --- | --- |
| connectionId | 固定 w200；client 必须 200 |
| objectName | 大写客户 Z/Y 名，1—10 字符；必须确属获准对象 |
| expectedVersion | 读取 API 的 64 位小写十六进制完整原生版本 |
| action | create 或 update；不得通过缺字段推断 |
| intervalNumber | 2 位大写字母/数字 |
| fromNumber、toNumber | 各为 20 位十进制字符串，前者严格小于后者；不能用 JS Number；不与其他区间重叠 |
| external | boolean；更新不允许切换内部/外部模式 |
| operationId | 1—64 字符 A—Z/a—z/0—9/点/下划线/冒号/连字符；不得重用派发后的操作号 |
| acknowledgeConfigurationWrite | true |
| acknowledgeLocalClientOnly | true；间隔仅当前 client，不录制/迁移 CTS |

只支持未使用、全部 NRLEVEL 为零、无缓冲、数值 NUMC20、非年度、无子对象/分组/文本/远程/ASCII 特性客户对象。不会取号、删除间隔或重置 level，不写标准表，不操作 GUI，不释放传输请求。当前拒绝范围不代表今后已有支持。

## 保存状态

| status | MCP isError | 含义与后续 |
| --- | --- | --- |
| completed | false | 原生保存结果及完整回读匹配，提交、会话清理和解锁满足当前契约；实际 SAP 正例仍待验收 |
| no_changes | false | 原生无改值且完整回读匹配 |
| declined | true | 条件拒绝；结合 sapInvocationStarted、原生结果及 operationReceipt 判断是否曾派发，不能仅由错误推断 SAP 无写入 |
| protection_refused | true | 重复操作、目标忙或本地保护拒绝，本次不派发；原始操作状态仍需查看 |
| unknown | true | 原生返回/提交/完整读回/清理/回执持久化未确定；停止写入并只读对账，不自动重试或回滚 |

## 对账

输入为 connectionId、objectName、operationId 三字段，拒绝其他字段。回执须匹配工具名、操作 ID 哈希、完整对象保护目标及记录的前版本。

- receipt_unavailable：没有回执，跳过 SAP，不证明历史状态。
- not_dispatched：回执明确 sapInvocationStarted=false，跳过 SAP。
- partial：已派发或无法确定派发历史时只读现值；same_as_before、changed_since_before、before_version_unavailable 都不解决历史 unknown。读失败或回执在观察期间变化则 withholding snapshot，输出 SNAPSHOT_UNAVAILABLE 或 RECEIPT_CHANGED。

对账不修改回执、不解锁、不保存、不分配号码，不执行 CTS。`locks=unverified` 明确表示当前未证明 SAP 锁释放。原始未知回执即使当前值等于计划值也保持未知。

## 部署依赖

本地公开工具不自动部署客户函数。新 r40 清单包含经契约核对的创建步骤，源码两份最大行宽均为 RSSOURCE 的 72 字符界限。执行前需具体对象/数据批准及实时来源、请求、权限、诊断和原生接口复核。现有共享服务未重启；需在专用固定构建中验收后再按正常部署流程切换。
