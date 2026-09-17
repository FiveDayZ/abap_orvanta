# ORVANTA Windows 便携包

## 首次使用

1. 将 ZIP 完整解压到当前 Windows 用户可写的目录。
2. 双击 `open-settings.cmd`，将示例 SAP 地址和用户名改为自己的连接信息并启用连接。
3. 在配置中心输入本次密码并启动 MCP 服务。

MCP 默认地址为 `http://127.0.0.1:4847/mcp`。密码只保存在当前进程内存，不写入连接配置或浏览器存储。

## 一键更新

先停止 MCP 服务并关闭 ORVANTA 配置中心，然后双击 `update.cmd`。更新器会从 [ORVANTA GitHub Releases](https://github.com/FiveDayZ/abap_orvanta/releases) 下载按 `orvanta-mcp-<版本号>-win-x64.zip`命名的最新稳定版便携包，核对 SHA-256、版本、平台和包内文件清单后完成替换。

更新会保留当前目录中的 `connections.json`、`exports`，以及默认保存在 `%LOCALAPPDATA%\ABAP MCP Standalone\state` 的操作状态和回执。更新器不会安装或升级 SAP 助手，不修改 SAP 对象、业务数据或传输。

检测到 ORVANTA 仍在运行、下载或校验失败、包结构不符合要求时，更新会停止；若文件替换阶段失败，会恢复原版本。GitHub Release 提供的 SHA-256 用于下载完整性校验，不等同于发布者数字签名。

## 其他入口

- `open-settings.cmd`：打开本地配置中心。
- `start.ps1` / `start.cmd`：直接启动 MCP 服务。
- `setup.ps1`：执行助手预检、可选 Codex 注册并启动服务。
- `install-sap-helper.ps1`：经审查后单独管理 SAP 助手；它可能修改客户命名空间对象，不属于自动更新。

完整源码、Skill 和许可证信息见 [GitHub 仓库](https://github.com/FiveDayZ/abap_orvanta)。
