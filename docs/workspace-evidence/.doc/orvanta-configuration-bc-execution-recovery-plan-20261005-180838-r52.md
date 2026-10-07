# r52：完整 CTS 验收、标准激活副作用与恢复命令

实际时间：2026-10-05T18:08:38+08:00（Asia/Shanghai）。承接 r51 已部署 Z_ORVANTA_CFG_BC_CTS 和本地只读 MCP 接口；完整 SPRO API 自动配置未完成。当前对象部署/只读验收批准有效，不再请求重复批准。用户 API-only 要求优先于历史 GUI 建议。

## 目标、最小交付与验收

1. 在现有固定 CTS 登录窗口完成输入后立即执行两次公开 read_configuration_bc_cts_snapshot，核对连续结果/完整原生字节长度和SHA、scope/user/源/接口/5表布局，再执行4个非法schema无后台派发，核对已准备的4个原生 INPUT_INVALID 且其他输出清空。保存真实回执，成功后才能把验证登记从 unverified 改为 verified。验收限定 WYS/200/429/430；补充原生侧 EXPORT→IMPORT 往返及准确键空格/非空 string-key 实例时仍保持不写配置，不把未实测字段称为已验证。
2. 完成原240文件冻结预检的真实读次数/耗时验证，逐字段对照已验收 r50 9表19键、四API及五版本。真实数据及原生命令不缓存，全部定义独立收尾复读；不得仅用合成11000次读取测试宣布性能比例。账号拒绝不自动重复登录，等待用户确认真实登录结果。
3. 固化已实读的 S_TRANSPRT/S_SYS_RWBO 权限FORM、FRAME、LOCAL_START、VB/分发、工程映射链，进一步审查清理、日志独立连接与所有 commit/polling/远端副作用条件。验证固定429/430没有工程/分发条件的真实元数据，选取可支持无GUI契约的标准入口；不擅自关闭项目分发或改标准代码。验收须明确所有事务边界与对外错误契约，不能用 NO_COMMIT 代替证明。
4. 在原生CTS前态和9表19键前态基础上实现独立完整 APPLY/RECONCILE/RECOVER 候选及持久回执。范围仍 EHS_CUNI_KNM/N：10候选创建、共享PRESS保持、8保护键；按原生类型保存全部 before-state，按精确变更归属补偿新建/修改行与完整CTS关联行，保护两容器其他条目。状态涵盖准备/开始/成功/部分/失败/未知/恢复，各分支保存日志，任何timeout/未知先读回对账再决定，不自动重放激活。最小本地矩阵覆盖故障、重复、stale/concurrent、部分CTS、未知提交和保护字段；成功验证后形成精确客户对象/包/开发任务以及业务19键差异、锁、日志分发副作用、预算和恢复清单供审批。

## 授权与依赖

当前只需 CTS 窗口口令输入；已有用户批准允许此准确只读验收。禁止读取/复制其他进程口令。新的 APPLY/RECOVER 客户对象部署、激活/模拟/配置写入、配置CTS追加/清理/恢复和请求释放不包含在本次只读授权内：先完成完整可审阅候选与验收清单，后按具体操作申请，不能把泛泛继续当业务写入权限。

共享服务和默认dist继续保留，所有构建隔离，不影响其他开发。通用 STRING execution-contract 兼容性修复为独立明确缺陷，不通过削弱鉴权或元数据规则绕过；当前CTS专用工具按受限源身份调用准确只读API。

## 全项目剩余

主线仍 CFG-04 整包标准API激活/日志/异常/补偿；CFG-06双侧变化/单侧失败、CFG-07业务启用和真实触发、CFG-08明确业务域与组织键仍需逐项实证。既有成功阶段证据沿用原记录，不把重复本地通过算作新业务验收。每个阶段完成后继续自动规划，不宣称全项目完成。

[本阶段记录](C:/My/Workplace/Coding/vscode-abap/.doc/code-update-20261005-180838.md)；[实际部署](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-configuration-bc-cts-deployment-20261005-180838-r51.json)；[原实施backlog](C:/My/Workplace/Coding/vscode-abap/.doc/orvanta-mcp-spro-configuration-implementation-backlog-20261002.md)。
