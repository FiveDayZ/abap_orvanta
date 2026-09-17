# ORVANTA 配置中心

## Register

product

## Platform

web

## Users

不熟悉无头服务和手工配置文件的 ABAP MCP 用户。

## Product Purpose

为独立 ABAP MCP 服务提供本地配置界面，让用户管理连接、输入本次凭据并启动服务。

## Design Principles

- 中文表单与明确的服务状态。
- 保留现有无头入口，不依赖桌面开发工具。
- 区分连接配置、服务运行和真实 SAP 连通性。
- 不把密码写入配置文件，不擅自修改远程 SAP 对象。
