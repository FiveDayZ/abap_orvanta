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

脚本对 `release/` 中超过保留窗口（最近 5 个 `orvanta-mcp-*-win-x64*.zip`）的产物给出警告，但**不会自动删除发布物**。清理前需人工确认该产物没有被外部引用，且已有可回溯的提交与标签。

## 6. 标签

发布完成后对打包所用提交打附注标签：

```powershell
git tag -a v<version> -m "<一句话说明>"
git rev-list -n 1 v<version>   # 应与 BUILD-INFO.json 的 standaloneSourceCommit 相同
```

标签与 `standaloneSourceCommit` 不一致时，不得声称该产物对应该标签。

## 7. 禁止事项

- 不得用未提交的工作树产出发布版（唯一例外是显式 `-AllowDirty` 的临时候选包，且必须如实标注）。
- 不得手工修改包内 `BUILD-INFO.json`、`.sha256` 或 `INDEX.md`。
- 不得把 `release/` 提交进仓库（`.gitignore` 已排除，根目录 `*.zip` 同样排除）。
- 不得在没有 SAP 侧授权的情况下用打包脚本或安装脚本执行任何 SAP 操作。
