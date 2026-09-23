# 发布与打包流程

- 适用范围：`abap-mcp-standalone` 便携包（Windows x64）
- 目标：**每个交付物都能由一个 git 提交重建**，并且能回答「这个包里到底是哪份代码」

## 1. 版本号

一次发布只允许存在一个版本号，三处必须一致：

| 位置                | 说明                                                        |
| ------------------- | ----------------------------------------------------------- |
| `src/version.ts`    | `PRODUCT_VERSION`，运行时与 MCP `server.version` 的唯一来源 |
| `package.json`      | `version`，打包目录名与 `BUILD-INFO.json` 的来源            |
| `package-lock.json` | 根部与 `packages[""]` 两处 `version`                        |

打包脚本会用包内自带的 node 执行 `PRODUCT_VERSION` 并与 `package.json` 比对，不一致直接失败（`-SkipRuntimeCheck` 可跳过，仅用于明确知道原因的排查）。

## 2. 构建前

```powershell
npm run format:check
npm run typecheck
npm run matrix:check        # 工具注册表与 docs/tool-index.md、contracts/tool-index.json 一致
npm test                    # 由人工执行
```

自动化测试、SAP 验收脚本与运行时回归按人工优先原则由测试人员执行；没有人工测试证据时，不得把本次变更描述为「验证通过」。

## 3. 打包

```powershell
pwsh -NoLogo -NoProfile -File scripts/package-windows.ps1
# 候选包：-CandidateSuffix rc1
# 覆盖同名产物：-ReplaceExisting（需先人工确认旧产物可以丢弃）
```

- **工作树必须干净**。存在未提交改动时脚本会拒绝打包并列出前 10 项改动，因为这样的产物无法由任何提交重建。
- 只有在明确不需要复现的临时候选包场景下才使用 `-AllowDirty`；此时包内 `BUILD-INFO.json` 会记录 `standaloneSourceDirty = true`，该标记不得在评审中被忽略。
- 脚本不会修改 SAP，也不会创建或释放传输。

## 4. 产物

```text
release/
  orvanta-mcp-<version>[-<suffix>]-win-x64/      # 解压后的便携目录
  orvanta-mcp-<version>[-<suffix>]-win-x64.zip   # 交付归档
  orvanta-mcp-<version>[-<suffix>]-win-x64.zip.sha256
  INDEX.md                                       # 归档索引（脚本追加，不纳入版本控制）
```

包内 `BUILD-INFO.json` 是权威溯源信息：

| 字段                                   | 含义                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `version` / `platform` / `nodeVersion` | 版本与运行时                                                                      |
| `runtimeVersionCheck`                  | 包内 `PRODUCT_VERSION` 与 `package.json` 的一致性检查结果                         |
| `standaloneSourceCommit`               | 打包所用提交                                                                      |
| `standaloneSourceDirty`                | 该提交之外是否还有未提交改动                                                      |
| `fileSha256`                           | 除 `node_modules` 外全部打包文件的 SHA-256（依赖由 `app/package-lock.json` 固定） |
| `builtAt`                              | 构建时间（本地时区偏移）                                                          |

`release/` 不纳入版本控制；`INDEX.md` 只是本地横向比对用的便利索引，不是证据。**证据是 `BUILD-INFO.json` 与对应的 git 提交/标签。**

## 5. 归档保留

保留窗口是最近 **5** 个 `orvanta-mcp-*-win-x64*.zip` 产物。窗口外的产物**不再只是警告**：打包脚本在写完索引后调用

```powershell
pwsh -NoLogo -NoProfile -File scripts/quarantine-release-artifacts.ps1            # 只报告计划
pwsh -NoLogo -NoProfile -File scripts/quarantine-release-artifacts.ps1 -Apply     # 执行
```

把窗口外的 `.zip`、同名 `.zip.sha256` 与对应解包目录，以及**没有对应 zip 的散落解包目录与历史遗留目录**，**移动**（绝不删除）到 `release/quarantine/`。这样做的原因有两个：解包目录里的 `connections.json` 携带真实内网主机与用户名，长期散落在 `release/` 会扩大泄露面；而移动是可逆的，产物仍然可回溯。

被服务占用而无法移动的路径会逐条报告，脚本以非零码退出，需要人工处理后重跑。

## 6. 标签

发布完成后对打包所用提交打附注标签：

```powershell
git tag -a v<version> -m "<一句话说明>"
git rev-list -n 1 v<version>   # 应与 BUILD-INFO.json 的 standaloneSourceCommit 相同
```

标签与 `standaloneSourceCommit` 不一致时，不得声称该产物对应该标签。

## 7. SAP 侧助手部署（人工 F8）

服务侧代码可以先发布，但**依赖新操作码的工具在助手部署前一律不可用**：助手的处理分支运行在 SAP 内，未部署时调用返回 `OPERATION_NOT_SUPPORTED`。因此助手部署是发布清单中的正式步骤，不是收尾杂事。

### 7.1 为什么必须人工

所有 `ZORVANTA_MCP_*` 助手都位于函数组 `ZORVANTA_MCP_CORE` 内，而该函数组带有自写保护：服务不得修改自己的助手（否则一次错误写入就能让服务失去修复自身的能力）。因此每次助手变更都必须由人在 SAP 内执行：

1. 仓库内用生成器产出**载体程序**（`scripts/generate-*-carrier*.mjs` / `generate-*-deploy-report.mjs`），得到 `.doc/deploy-*.abap` 与逐字**部署报告**。报告必须包含 `SOURCE|HASH`、操作码清单、`PROTOCOL|MIN/MAX`、载体修订号（`rNN`）、正文行数与 digest。
2. 人工用 SE38 执行该载体程序**并运行（F8）**生成助手主体，回传 `OK: generated and activated.` 级别的回执。
3. 用 `verify-*-carrier-deployed.mjs` 之类的校验脚本核对线上 include 行数、marker 与特征字符串，再用 `get_capability_report` 复核 `PROTOCOL|MAX` 与操作码清单。

载体带有**基线守卫**：对同一个载体重复 F8 会以 `deployed include is not the reviewed baseline` 失败。**这是保护，不是部署失败**——它阻止把已更新的对象按旧基线覆盖。看到该错误时先核对 include 行数（应为「正文行数 + 32」），不要重新生成载体。

### 7.2 两条不可混淆的刻度

| 助手族                                                             | 协议刻度 | 载体     |
| ------------------------------------------------------------------ | -------- | -------- |
| DDIC（`Z_ORVANTA_MCP_DDIC_API`）                                   | `1.x`    | 独立载体 |
| repository（`Z_ORVANTA_MCP_EXECUTE` / `Z_ORVANTA_MCP_DYNPRO_API`） | `2.x`    | 独立载体 |

两个刻度互相独立，**不得互相换算或混用**。能力报告中的 `helpers` 与 `helperAttestation` 按族分别自述，判断可用性时必须看对应族。

### 7.3 载体顺序不变量

载体必须**针对上一载体 F8 成功后的实际线上源码**重新生成；否则基线守卫会拒绝，或更糟——把别人的改动当作自己的基线覆盖掉。因此：一次只部署一个载体，部署成功并复核后再生成下一个。

### 7.4 指纹重钉

- **仅函数体变更**：`interfaceFingerprint` 不变，无需重钉，也无需重新审批接口。
- **接口签名变更**：必须重新钉 `interfaceFingerprint`，并重新走接口审批；此时该载体涉及的所有工具都必须重新验收。

部署记录按工作区规范写入 `.doc/code-update-YYYYMMDD-HHmmss.md`，并同步更新 `contracts/verification-registry.json` 中对应条目的 `status`、`lastAttemptAt` 与 `evidence`——**只有真实调用成功才能从 `unverified` 升为 `verified`**（见 `docs/helper-capabilities-protocol.md` 与验收登记表设计）。

### 7.5 `unsupported` 不是发布缺陷（`remedy` 字段）

安装、重打包或重启 MCP 服务**不会**改变 SAP 侧助手协议——助手正文在 SAP 内。因此版本检查得出的 `unsupported` 是关于 SAP 的陈述，不是关于本次发布包的缺陷。

为免这一区别被误读（曾发生：新包安装后仍报 `unsupported`，被当作发布包坏了），能力报告的版本类判定会附带 `remedy` 字段，写明需要执行的 SAP 侧步骤与载体程序名：

```json
{
  "availability": "unsupported",
  "reason": "The Z_ORVANTA_MCP_DDIC_API helper self-described protocol 1.12, which is below the required capability version 1.13.",
  "remedy": "Repackaging, reinstalling or restarting the MCP service cannot change the SAP-side helper protocol: the helper body lives in SAP. To satisfy this requirement, run the 1.13 carrier program ZORVANTA_MCP_DDIC_LOCK_DEPLOY in SE38 and press F8, then restart the MCP service and re-read the capability report."
}
```

载体程序名由 `src/helper-carriers.ts` 记录，并由 `test/helper-carriers.test.ts` 回读生成器脚本核对，改载体名会让测试失败而不是产出指向不存在程序的 `remedy`；尚未生成载体的助手族不臆造程序名，只指向本节。

## 8. 禁止事项

- 不得用未提交的工作树产出发布版（唯一例外是显式 `-AllowDirty` 的临时候选包，且必须如实标注）。
- 不得手工修改包内 `BUILD-INFO.json`、`.sha256` 或 `INDEX.md`。
- 不得把 `release/` 提交进仓库（`.gitignore` 已排除，根目录 `*.zip` 同样排除）。
- 不得在没有 SAP 侧授权的情况下用打包脚本或安装脚本执行任何 SAP 操作。
