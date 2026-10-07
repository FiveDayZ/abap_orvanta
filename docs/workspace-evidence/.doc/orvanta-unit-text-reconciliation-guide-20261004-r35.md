# 计量单位文本 API 只读对账接口（r35）

- 时间：2026-10-04T04:42:54.879Z；目标 w200 / GR2 / client 200，ECC SAP_BASIS 7.31。
- 工具：reconcile_configuration_unit_text。仅读取，不执行配置维护、重试、恢复、CTS 追加/删除/释放、锁获取/删除或回执修改。
- 本说明基于当前主机实现和 r33/r34 的真实源回执；真实 r35 对账验收单独记录，不以本说明代替实时元数据、权限或集成验收。

## 调用前保存的信息

通过 read_configuration_unit(includeApiSnapshot=true) 取得并保留 apiSnapshot.data 的完整 T006A 行、textVersion 和原读投影 readFingerprint。保存后保留原 apply_configuration_unit_text 的输入及 operationId。未知结果时先调用本工具，不能重新调用 apply 猜测是否成功。

## 输入

| 字段 | 要求 | 规则 |
| --- | --- | --- |
| connectionId | 必填 | 仅 w200，实际连接 client 必须为 200 |
| operationId | 必填 | 原操作 ID；本地服务状态根必须存在其原回执，工具不接收调用方自造回执 |
| originalInput | 必填 | 原 apply 输入去掉 connectionId/operationId 后的完整内容，包括 unitKey、ISO language、expectedReadFingerprint、expectedTextVersion、patch、requestNumber、taskNumber 及历史 acknowledgeConfigurationWrite=true；该历史字段不授权新写入 |
| beforeText | 必填 | 原生 API 当时返回的七字段完整旧行：MANDT、SPRAS、MSEHI、MSEH3、MSEH6、MSEHT、MSEHL；必须与回执旧版本一致，不用当前行冒充旧行 |
| includeLocks | 可选 | 默认 false。true 通过既有维护诊断审批读取配置用户名/当前 client 的 T006 和请求任务参数过滤；不自动复制、创建或放宽审批 |

身份核验复用原写请求的 canonical inputHash，检查 operationIdHash/targetKeyHash、预变更版本/读指纹/请求任务，并核对旧行 SHA-256。单位大小写保留，省略的 patch 字段不删除。空 patch、额外字段、错误请求任务、修改旧行或其他 client 在 SAP 读取前拒绝。没有完整原请求、旧行或已记录预变更证据时拒绝对账，不推测缺失数据。

编码限定于已核实 GR2 原生读取体：SYST-SYSID→SYSYSID→SYCHAR08（实际 CHAR8）以及 T006A 七字段 CHAR 宽度 3/1/3/3/6/10/30、UTF-8 SHA-256。已对比 r34 的中文原值、英文、临时描述、恢复后四个真实 native version；每个新现值也独立核对该编码，未知布局或行/版本不符不产生值判断。

## 输出与解释

| 字段/状态 | 含义 |
| --- | --- |
| value.status=observed_original | 两次可信完整行版本与原版本一致；不能证明原操作从未写入，后续恢复也会产生相同现值 |
| value.status=observed_requested | 完整当前行版本与原旧行加明确 patch 的目标版本一致；不能据此单独证明哪一次操作提交了它 |
| value.status=observed_conflicting | 完整当前行与原值及目标值都不同，包括省略字段/别名变化；不能据此覆盖现值 |
| value.status=unknown | 原生读回不可用、类型/布局/语言不符、值变化或回执在观察期间变化等，无法可信分类 |
| status=unknown | 整体观察还可能因 CTS 未知、重复/错误容器键或所请求锁观察不可用而降级；value.status 可以仍提供有限的当前值事实 |
| historicalOutcome | receipt_completed / not_invoked / unresolved 与原 outcomeMayBeUnknown。保留原回执与第一错误的 hash；不改成新的提交/rollback 判决 |
| cts | approved task 内具名目标裁剪投影的观察、计数和完整 inspector 数据；target_projection_not_observed 不证明无通配录制或历史录制。exactRowRecording=not_verified，importStatus=not_checked |
| locks | 未请求、观察成功或不可用；configured-user/client 的有限覆盖，不证明系统无竞争，不释放任何锁 |
| evidence | 各 reader 的开始/结束时间、原回执复读、两次 unit / 一次 CTS / 可选三次锁查询计数；不是原子 SAP snapshot |

description 字段相同而其他字段变化会判 conflicting。原 r33 失败未知回执对账到当前原值后仍为 unresolved，不能据此盲目使用新 operationId 重写。本工具不为修复/恢复发放写权限，也不解除原本地锁。

## 真实历史调用示例

以下为已记录 r34 保存操作的只读对账输入，原值当时“千克”，请求目标“千克（API验收）”；随后已恢复。该输入不执行新写入；如果本地实例没有该原回执，会在 SAP 读取前拒绝。

```json
{
  "connectionId": "w200",
  "operationId": "spro-unit-save-20261004-r34",
  "originalInput": {
    "unitKey": "KG",
    "language": "ZH",
    "expectedReadFingerprint": "b8a07ec8b032180d027f9f8edc7f4ab15a7c9902cb516bbfcfbd14cb25614c72",
    "expectedTextVersion": "42a282a178d6bf505fa25a2883ab727c11914746623d0b3c86845f1fa70c6734",
    "patch": {
      "MSEHL": "千克（API验收）"
    },
    "requestNumber": "GR2K923429",
    "taskNumber": "GR2K923430",
    "acknowledgeConfigurationWrite": true
  },
  "beforeText": {
    "MANDT": "200",
    "SPRAS": "1",
    "MSEHI": "KG",
    "MSEH3": "KG",
    "MSEH6": "公斤",
    "MSEHT": "公斤",
    "MSEHL": "千克"
  },
  "includeLocks": false
}
```

需要核对值读取的原始拒绝原因时，可另调用只读 read_configuration_unit(includeApiSnapshot=true) 查看 native API status/code；对账 schema 不把不可验证的返回行作为当前值使用。请求释放、导入、原生并发/故障回滚和其他配置对象的维护须另按其实际 API、授权及验收处理。
