# ORVANTA 工具索引（生成文件，请勿手工编辑）

- 矩阵版本：2026-09-17
- 工具总数：126
- 只读工具：75
- 数据来源：`src/tool-registry.ts`（单一事实源）+ `src/contracts.ts`
- 重新生成：`npm run matrix:generate`；一致性校验：`npm run matrix:check`

## 概览

| 维度 | 值 |
| --- | --- |
| profile: readonly | 75 |
| profile: platform | 12 |
| profile: dev | 110 |
| profile: config | 28 |
| profile: ops | 35 |
| profile: full | 126 |
| 分组: data | 5 |
| 分组: ddic | 16 |
| 分组: debug | 6 |
| 分组: enhancement | 22 |
| 分组: form | 4 |
| 分组: function | 6 |
| 分组: message | 4 |
| 分组: ops | 18 |
| 分组: platform | 12 |
| 分组: quality | 4 |
| 分组: source | 17 |
| 分组: ui | 12 |

## 工具清单

| 工具 | 分组 | profile | 风险 | 路由 | SAP 助手（最低协议） |
| --- | --- | --- | --- | --- | --- |
| `abap_activate` | source | dev | 写 | native-adt | — |
| `abap_debug_breakpoint` | debug | dev | 写 | native-adt | — |
| `abap_debug_session` | debug | dev | 写 | native-adt | — |
| `abap_debug_stack` | debug | dev | 只读 | native-adt | — |
| `abap_debug_status` | debug | dev | 只读 | native-adt | — |
| `abap_debug_step` | debug | dev | 写 | native-adt | — |
| `abap_debug_variable` | debug | dev | 只读 | native-adt | — |
| `abap_download` | source | dev | 写 | target-specific | — |
| `activate_smartform` | form | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_SMARTFORM_API |
| `adt_discovery_export` | platform | platform | 写 | native-adt | — |
| `analyze_abap_dumps` | ops | dev, ops | 只读 | native-adt | — |
| `analyze_abap_traces` | ops | ops | 只读 | native-adt | — |
| `analyze_change_impact` | source | dev | 只读 | target-specific | — |
| `append_ddic_transparent_table_fields` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.7) |
| `cleanup_transport_entries` | ops | ops | 破坏性写 | native-adt | — |
| `correlate_sap_logs` | ops | ops | 只读 | target-specific | — |
| `create_abap_message_class` | message | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.7) |
| `create_ddic_transparent_table` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.5) |
| `create_enhancement_hook_implementation` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `create_function_module_with_interface` | function | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.3) |
| `create_module_pool` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `create_new_badi_implementation` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `create_object_programmatically` | source | dev | 写 | target-specific | — |
| `create_report_transaction` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.2) |
| `create_smartform` | form | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_SMARTFORM_API |
| `create_test_include` | source | dev | 写 | native-adt | — |
| `create_transaction_code` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `delete_abap_message_class` | message | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.9) |
| `delete_abap_source_object` | source | dev | 破坏性写 | native-adt | — |
| `delete_ddic_object` | ddic | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.6) |
| `delete_enhancement_implementation` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `delete_module_pool` | ui | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `delete_transaction_code` | ui | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `diagnose_sap_failure` | ops | dev, ops | 只读 | native-adt | — |
| `discover_application_logs` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_LOG_READ |
| `execute_data_query` | data | dev, config, ops | 只读 | target-specific | — |
| `find_where_used` | source | dev | 只读 | target-specific | — |
| `get_abap_diagnostics` | quality | dev | 只读 | native-adt | — |
| `get_abap_object_info` | source | dev | 只读 | target-specific | — |
| `get_abap_object_lines` | source | dev | 只读 | target-specific | — |
| `get_abap_object_url` | platform | platform | 只读 | local | — |
| `get_abap_object_workspace_uri` | platform | platform | 只读 | local | — |
| `get_abap_sql_syntax` | platform | platform | 只读 | local | — |
| `get_batch_lines` | source | dev | 只读 | target-specific | — |
| `get_capability_report` | platform | platform | 只读 | target-specific | — |
| `get_connected_systems` | platform | platform | 只读 | local | — |
| `get_customer_function_call_status` | platform | platform | 只读 | local | — |
| `get_object_by_uri` | source | dev | 只读 | target-specific | — |
| `get_runtime_info` | platform | platform | 只读 | local | — |
| `get_sap_system_info` | ops | dev, config, ops | 只读 | target-specific | — |
| `get_version_history` | source | dev | 只读 | target-specific | — |
| `get_write_operation_status` | platform | platform | 只读 | local | — |
| `inspect_customer_function_exits` | enhancement | dev | 只读 | target-specific | — |
| `inspect_customer_screen_menu_exits` | enhancement | dev | 只读 | target-specific | — |
| `inspect_enhancement_framework` | enhancement | dev | 只读 | target-specific | — |
| `inspect_fico_rule_exit_program` | enhancement | dev, config | 只读 | target-specific | — |
| `inspect_repository_assignment` | function | dev, config | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.3) |
| `inspect_source_enhancements` | enhancement | dev | 只读 | target-specific | — |
| `invoke_customer_function_module` | function | dev | 写 | target-specific | — |
| `list_write_recovery_operations` | platform | platform | 只读 | local | — |
| `manage_classic_badi_implementation` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `manage_enhancement_implementation_state` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `manage_text_elements` | source | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.7) |
| `manage_transport_requests` | ops | dev, config, ops | 只读 | target-specific | — |
| `patch_abap_gui_definition` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.5) |
| `patch_abap_screen` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.4) |
| `patch_ddic_transparent_table_fields` | ddic | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.7) |
| `patch_ddic_transparent_table_settings` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.7) |
| `patch_function_module_interface` | function | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.0) |
| `prepare_enhancement_configuration_workflow` | enhancement | config | 只读 | target-specific | — |
| `preview_configuration` | data | config | 只读 | target-specific | — |
| `preview_source_changes` | source | dev | 只读 | target-specific | — |
| `read_abap_gui_definition` | ui | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.5) |
| `read_abap_message_class` | message | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.7) |
| `read_abap_screen` | ui | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `read_abap_table` | data | dev, config, ops | 只读 | target-specific | — |
| `read_application_log` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_LOG_READ |
| `read_background_job_details` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_OPS_READ |
| `read_background_job_log` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_OPS_READ |
| `read_background_job_spool` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_OPS_READ |
| `read_bte_configuration` | enhancement | dev, config | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.3) |
| `read_classic_badi_definition` | enhancement | dev, config | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.4) |
| `read_customer_exit_definition` | enhancement | dev, config | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.2) |
| `read_customer_exit_project` | enhancement | dev, config | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.2) |
| `read_ddic_data_element` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `read_ddic_domain` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `read_ddic_structure` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `read_ddic_table_conversion_status` | ddic | dev, ops | 只读 | target-specific | — |
| `read_ddic_table_type` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `read_ddic_transparent_table` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.5) |
| `read_enhancement_implementation` | enhancement | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `read_failed_update` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_MAINT_READ |
| `read_function_module_interface` | function | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.3) |
| `read_report_parameters` | data | dev, config, ops | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API |
| `read_report_variants` | data | dev, config, ops | 只读 | target-specific | — |
| `read_smartform` | form | dev | 只读 | sap-helper-fallback | Z_ORVANTA_SMARTFORM_API |
| `read_system_logs` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_OPS_READ |
| `read_transaction_code` | ui | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `recover_ddic_table_conversion` | ddic | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.7) |
| `release_write_operation_lock` | platform | platform | 写 | local | — |
| `replace_string_in_abap_object` | source | dev | 写 | native-adt | — |
| `run_atc_analysis` | quality | dev | 写 | target-specific | — |
| `run_sci_analysis` | quality | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_SCI_API |
| `run_unit_tests` | quality | dev | 写 | native-adt | — |
| `sap_helper_status` | platform | platform | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_EXECUTE (≥1.0) |
| `save_smartform` | form | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_SMARTFORM_API |
| `search_abap_object_lines` | source | dev | 只读 | native-adt | — |
| `search_abap_objects` | source | dev | 只读 | native-adt | — |
| `search_application_logs` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_LOG_READ |
| `search_background_jobs` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_OPS_READ |
| `search_badi_objects` | enhancement | dev | 只读 | native-adt | — |
| `search_bte_dispatchers` | enhancement | dev, config | 只读 | native-adt | — |
| `search_customer_exit_objects` | enhancement | dev, config | 只读 | native-adt | — |
| `search_enhancement_objects` | enhancement | dev | 只读 | native-adt | — |
| `search_failed_updates` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_MAINT_READ |
| `search_sap_locks` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_MAINT_READ |
| `test_remote_function_module` | function | dev | 写 | target-specific | — |
| `update_abap_message_class` | message | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.8) |
| `update_enhancement_hook_implementation` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `update_new_badi_implementation` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `upsert_abap_screen` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `upsert_ddic_data_element` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `upsert_ddic_domain` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `upsert_ddic_structure` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `upsert_ddic_table_type` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `validate_dynpro_application` | ui | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.4) |

## 边界说明

- `abap_debug_breakpoint`：仅允许 Z/Y 源码断点；真实调试链路未验收。
- `abap_debug_session`：w200 调试端点曾返回 404；仅 Mock 验证，真实会话未验收。
- `abap_debug_step`：单步/继续会驱动被调试程序执行，可能存在业务副作用。
- `abap_download`：写入本地文件系统；程序不自动包含其 Include，需显式下载。
- `adt_discovery_export`：写入本地 Markdown 文件；w200 Discovery 未返回 template link / core entry。
- `analyze_abap_traces`：w200 上 ADT trace 端点返回 HTTP 404（能力报告判定 unsupported）；注册不等于可用。
- `cleanup_transport_entries`：移除 CTS 任务条目，不删除、不释放传输；w200 写端点尚未验证。
- `correlate_sap_logs`：固定来源的有界关联，不证明因果；各来源失败分别报告。
- `diagnose_sap_failure`：只读 ST22 解析；时间关联是候选证据，不认定根因。
- `discover_application_logs`：需要管理员批准的只读助手；返回有界样本，不是完整日志清单。
- `execute_data_query`：w200 原生数据预览端点返回非 XML 响应；当前依赖受限只读后备。
- `find_where_used`：w200 上原生引用映射曾超时并伴随 RIS 故障；失败不得解释为零引用。
- `invoke_customer_function_module`：正式白名单调用，非只读；需一次性请求凭证与副作用确认。
- `manage_transport_requests`：只读：不创建、不释放、不导入传输。
- `preview_configuration`：仅服务 w200/200 的 ZTPMC_TPCFG 工厂行预览，属客户项目对象固化在通用服务中的待整改项。
- `read_abap_table`：最多 500 行、仅字符比较、无联接/聚合/排序；宽表按主键分块并二次复核。
- `read_application_log`：日志正文属不可信证据；分页需要 revision，变更后拒绝拼接。
- `read_background_job_details`：需要单独批准的 SM37_DETAILS scope；返回步骤元数据，不含变式值与 Spool 正文。
- `read_background_job_spool`：需要单独批准的 SP01 scope；仅文本，无 OTF/PDF 与打印，分页非原子快照。
- `read_failed_update`：只读；不提供参数载荷或完整错误正文。
- `read_report_parameters`：依赖仓库助手的 REPORT_PARAMETERS scope；仅读取已编译 SSCR 元数据，不生成、不读变式内容。
- `read_report_variants`：通过受限单表读取当前 client 的 VARID 目录元数据；不读参数值，不合并 client 000。
- `release_write_operation_lock`：仅解除本地目标锁，不触碰 SAP 锁；需人工确认与最新凭证哈希。
- `run_atc_analysis`：w200 原生 ATC 端点不可用，当前退化为语法报告；不得作为质量门禁通过依据。
- `run_sci_analysis`：非原生 ATC，规则范围固定且依赖指纹匹配的 SCI 助手；timeout 不等于取消。
- `run_unit_tests`：执行现有 ABAP Unit，测试代码可能有副作用；需先取得授权。
- `search_application_logs`：需要管理员批准的只读助手；未批准时返回不可用，不代表日志为空。
- `search_failed_updates`：只读；不执行更新重处理，本地候选助手尚未部署验证。
- `search_sap_locks`：只读；不提供 SAP 解锁。本地凭证不能证明 SAP 锁归属。
- `test_remote_function_module`：执行客户 RFC，可能产生业务副作用；白名单与显式确认必需。
