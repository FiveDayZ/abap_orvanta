# 传输交付（D9）与 `readyToRelease` 判定来源

本文件收口 D9-4：**说清 `readyToRelease` 这个字段到底是谁算出来的**。答案是：没有人算它——它是固定字面量。这一条如果不写下来，调用方很容易把 `comparison: "exact_key_match"` 与"可以释放"混为一谈。

## 1. 现状：`prepare_delivery`（只读）

入口是 `manage_transport_requests` 的 `prepare_delivery` 动作（**不是**独立工具），要求 `transportNumber` + 1–200 条精确 `expectedObjects`（CTS 的 `pgmid`/`type`/`name`），可选 `inactiveTargets`（≤100 条精确源码 URI + `objectName`）。

它在**一次** `transport details` 读的范围内，把调用方给的期望清单与 SAP 返回的对象清单做**精确键**比对，并给出：

- `objects` / `missingFromObservedList` / `unexpectedInObservedList` / `duplicateOccurrences`
- `comparison`：`exact_key_match` 或 `differences`
- `inactiveCheck`：一次会话可见的非活动对象清单（与 CTS 键比对**相互独立**）
- `fingerprint`：对 `{connectionId, headers, expected, entries}` 做 sha256，可用作"同一份观测"的凭据
- `coverage`：**这条读到底覆盖了什么**
- `warnings`：逐条写明它**没有**证明什么

`coverage` 才是这个工具的可信度所在，它的每一项都是"未覆盖"：

| 字段                 | 值                                             | 含义                            |
| -------------------- | ---------------------------------------------- | ------------------------------- |
| `source`             | `single_adt_transport_details_response`        | 全部结论来自**一次**响应        |
| `repositoryComplete` | `false`                                        | 没有比对仓库侧对象是否齐全      |
| `atomicSnapshot`     | `false`                                        | 读取期间的并发改动无法排除      |
| `inactiveObjects`    | `explicit_source_targets_only` / `not_checked` | 只查调用方点名的对象            |
| `dependencies`       | `not_checked`                                  | 依赖（如表键、DDIC 依赖）未检查 |
| `tableKeys`          | `not_checked`                                  | 表内容键未检查                  |
| `otherRequests`      | `not_searched`                                 | 其他请求未搜索                  |

## 2. `readyToRelease` 的判定来源（D9-4 收口）

`src/transport-delivery.ts` 里该字段是**写死的**：

```ts
readyToRelease: "not_determined"
```

它**不是**由 `comparison`、`missing`、`duplicateOccurrences` 或任何其他字段推导出来的。全仓库仅此一处赋值，没有第二个写入点。

**为什么不计算**（每条都是上面 `coverage` 的直接后果）：

1. 一次 `transport details` 读**不覆盖仓库完整性**（`repositoryComplete: false`）——请求"看起来齐"不等于对象真的齐。
2. 它**不是原子快照**（`atomicSnapshot: false`）——读的瞬间无法排除并发写入。
3. **依赖与表键未检查**（`dependencies`/`tableKeys: not_checked`）——交付可用性取决于这些，而它们不在本次读取范围内。
4. **释放本身不在服务范围内**（见 §3，D9-3 明确不实现）——既然没有释放动作，给出"可释放"的判定只会制造无法兑现的承诺。

**调用方必须这样理解**：

- `comparison: "exact_key_match"` 只意味着**你给的清单与这次观测到的清单精确匹配**，不意味着可发布；
- `missingFromObservedList` 里的对象是"**不在这次返回的清单里**"，不是"未分配"或"不存在"；
- 同一条目在父任务与子任务清单里各出现一次是**合法的**，`duplicateOccurrences` 不自动等于缺陷；
- 任何"可以释放了"的结论都必须由**人**在 SAP 内（SE01/SE09/SE10）依据完整检查得出，服务不代替这个判断。

## 3. D9 其余项的状态

| 项       | 内容                       | 状态                                                             |
| -------- | -------------------------- | ---------------------------------------------------------------- |
| **D9-1** | `create_transport_request` | **走助手路线**（见 §4）。高风险：默认关闭、独立确认串、写后回读  |
| **D9-2** | `add_objects_to_transport` | 同上；要求对象清单指纹与位置，写后回读证明"纳入且其他条目不变化" |
| **D9-3** | `release_transport_task`   | **明确不实现**——释放不可逆，服务不提供该动作                     |
| **D9-4** | 只读侧收口                 | 本文件                                                           |

两条不可违反的约束：

1. **原生创建拒绝必须保留**。`src/adt-backend.ts` 的 `createObject` 路径在请求 `transportRequest.type === "new"` 时直接抛出：

   > `Creating transport requests is not supported. Use $TMP or provide an existing transport request.`

   这段拒绝是**刻意保留**的：原生 ADT CTS 端点探测未通过（见 `.doc/d9-cts-endpoint-probe-20260922.md`），因此在原生路径上"装作支持"只会产生半成品。助手路线是**另一条**路径，不通过这里。

2. **不得复用或释放 `GR2K923472`**。它是本项目的部署载体请求，任何自助传输功能都不得把它当作可用请求，也不得释放它。

## 4. 为什么走助手路线

原生 ADT 的 CTS 端点在 `w200` 上探测未通过（证据：`.doc/d9-cts-endpoint-probe-20260922.md`），因此 D9-1/D9-2 由 **repository 助手**（共享正文，`2.8` 起）实现，与服务侧的原生拒绝互不冲突。助手侧改动随 repository `2.8` 载体一次性部署，需**人工 F8**（流程见 `docs/release-process.md` §7）。

在助手部署并对该连接完成写后回读验收之前，D9-1/D9-2 的状态一律按**未验证**记录，不得因为代码已合并而描述为可用。

## 5. 诚实边界（汇总）

- 精确键比对**只**覆盖 CTS 的 `pgmid/type/name`；`R3TR` 容器与 `LIMU` 子对象**不**互相替代。
- "不在非活动清单里"**从不**证明对象是活动的，也不证明覆盖了其他用户。
- 非活动观测与传输指纹是**两个独立**证据，不得互相引证。
- 本工具不做分配、激活、创建请求、释放、也不下载 SAP 源码。
