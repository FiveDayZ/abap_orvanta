# M6.1 系统信息准确性

0.36.16 实现 `get_sap_system_info` 的固定范围只读兼容路径。实现和本地测试不代表已完成 w200 真实验收。

## 输出契约

- 保留摘要加 JSON、既有字段及 `includeComponents` 参数。
- `status`：`ok`、`partial`、`unavailable`；查询失败不解释成没有组件、没有客户端或没有时区。
- `configuredClient` 是连接配置；只有 `currentClient` 表示 SAP 实际回读。
- `sources` 逐表返回读取方式、状态、返回数量、固定错误代码；后备读取附带原生失败代码。
- `componentsComplete` 表示组件集合是否完整；`componentsIncluded=false` 表示调用方没有请求输出数组，不表示组件不存在。
- `sapRelease` 来自 `CVERS` 中的 `SAP_BASIS.RELEASE`，不再使用不确定的 `SVERS` 首行。不将 `EXTRELEASE` 自动解释为 SP。
- `S4CORE` / `S4COREOP` 优先判为 S/4HANA；完整组件集合含 `SAP_APPL` 才判 ECC。仅有 SAP_BASIS 返回 Unknown，不猜产品。
- `timezone.utcOffset` 来自 `TTZR.UTCSIGN/UTCDIFF`，`offsetKind=standard_time`。这是不含夏令时的标准偏移，不是查询时刻的实际偏移；`dstRule` 保留规则代码。
- 兼容字段 `timezone.rawOffset` 仍保留 ZONERULE 原值，它是规则名而非时差。缺英文描述时保留时区和偏移并标记部分可用。
- 客户端保留原始 `categoryCode`、`changeProtectionCode`；变更保护文字依据 w200 域 `CCNOCLIIND` 修正，范围仅为仓库对象及跨客户端配置，不能解释为账户权限或传输放行状态。
- 摘要（`SAP System:` 文本）除客户端号与名称外，另起一行给出客户端角色与变更保护（`- Client role: <角色> (<代码>); change protection: <文字> (<代码或 blank>)`）。这两项此前只存在于 JSON 载荷里，基线自检无须再解析载荷。判定文字仍以 JSON 中的原始代码为准。
- `softwareComponents[].extRelease` 按 `CVERS.EXTRELEASE` 原样输出、逐组件给出；它**不是**支持包级别，工具也不把它换算成 SP 名称（换算需要本工具不读的 SPAM 数据）。组件数组仅在 `includeComponents=true` 时输出，`extRelease` 不会单独提升为摘要行。

## 有界读取

仅允许以下表与字段：

| 表    | 字段                                         | 范围                              |
| ----- | -------------------------------------------- | --------------------------------- |
| T000  | MANDT, MTEXT, CCCATEGORY, LOGSYS, CCNOCLIIND | 配置客户端                        |
| CVERS | COMPONENT, RELEASE, EXTRELEASE, COMP_TYPE    | 最多返回 500 条，多取一条检测截断 |
| TTZCU | CLIENT, TZONESYS, FLAGACTIVE                 | 当前客户端、FLAGACTIVE=X          |
| TTZZ  | CLIENT, TZONE, ZONERULE, DSTRULE             | 当前客户端、回读时区              |
| TTZR  | CLIENT, ZONERULE, UTCDIFF, UTCSIGN           | 当前客户端、回读规则              |
| TTZZT | CLIENT, LANGU, TZONE, DESCRIPT               | 当前客户端、E、回读时区           |

单行查询最多读取两条用于拒绝歧义；无跨客户端读取、通用 SQL 扩展、业务数据写入或新增 SAP Helper。

只有已经复现的 HTTP 200 / text/html / 零字节数据预览错误允许转到标准 `RFC_READ_TABLE`。权限错误、404、其他响应、空结果均不触发后备读取。后备调用前每次工具请求核验一次已审阅函数定义：

- `remoteEnabled=true`，`updateTask=false`。
- 源码指纹：`7b9a603493673d26f75e555616b24d150e407ce03eff57e9c68f0b30b1ba0c2d`。
- 接口指纹：`d06cc5c1ce05960bde526ecf27e38606134146474cc8da19f93ac2abd3e48074`。
- 指纹不同则关闭后备路径，不放宽为任意标准 RFC 执行。
- 标准源码包含表读取权限检查；不修改账号权限，不绕过 SAP 拒绝结果。
- 请求仅含固定字段和过滤条件；响应核验字段顺序、行数、客户端、重复组件及分隔符数量。分隔符碰撞或格式不符时拒绝解析，不猜测。

不同系统的标准函数指纹可能不同，需要重新只读审阅，不能直接宣称跨系统可用。

## 真实验收

在正常配置中心安全输入本次密码后，运行新版本服务。不要为读取旧进程内存中的密码而启用调试器。

```powershell
node scripts/probe-system-info.mjs
```

并行测试服务可使用空闲端口：

```powershell
$env:ABAP_MCP_URL = "http://127.0.0.1:4849/mcp"
node scripts/probe-system-info.mjs
Remove-Item Env:ABAP_MCP_URL
```

脚本先核对服务版本，再检查 w200/client 200 的完整组件与隐藏组件两种调用。输出唯一证据到工作区根 `.doc`，未通过返回退出码 1，不改变当前服务或配置。实际时区还需与原生系统配置核对；脚本不使用电脑时区猜测 SAP 时区。
