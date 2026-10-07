# ORVANTA 工具索引（生成文件，请勿手工编辑）

- 矩阵版本：2026-09-17
- 工具总数：208
- 只读工具：137
- 数据来源：`src/tool-registry.ts`（单一事实源）+ `src/contracts.ts`
- 重新生成：`npm run matrix:generate`；一致性校验：`npm run matrix:check`

## 概览

| 维度 | 值 |
| --- | --- |
| profile: readonly | 137 |
| profile: platform | 12 |
| profile: dev | 140 |
| profile: config | 80 |
| profile: ops | 61 |
| profile: full | 208 |
| 分组: data | 38 |
| 分组: ddic | 26 |
| 分组: debug | 6 |
| 分组: enhancement | 27 |
| 分组: form | 7 |
| 分组: function | 8 |
| 分组: message | 4 |
| 分组: ops | 44 |
| 分组: platform | 12 |
| 分组: quality | 4 |
| 分组: source | 20 |
| 分组: ui | 12 |

## 平台边界：默认隐藏的工具

| 工具 | 原因 |
| --- | --- |
| `abap_debug_breakpoint` | Withheld from the dev/config/ops profiles: ADT discovery on w200 advertises no debugger collection, so the capability report reports debuggerCapability=platform_unsupported and the six abap_debug_* tools cannot succeed. Registered and still callable through the full profile; not deleted. |
| `abap_debug_session` | Withheld from the dev/config/ops profiles: ADT discovery on w200 advertises no debugger collection, so the capability report reports debuggerCapability=platform_unsupported and the six abap_debug_* tools cannot succeed. Registered and still callable through the full profile; not deleted. |
| `abap_debug_stack` | Withheld from the dev/config/ops profiles: ADT discovery on w200 advertises no debugger collection, so the capability report reports debuggerCapability=platform_unsupported and the six abap_debug_* tools cannot succeed. Registered and still callable through the full profile; not deleted. |
| `abap_debug_status` | Withheld from the dev/config/ops profiles: ADT discovery on w200 advertises no debugger collection, so the capability report reports debuggerCapability=platform_unsupported and the six abap_debug_* tools cannot succeed. Registered and still callable through the full profile; not deleted. |
| `abap_debug_step` | Withheld from the dev/config/ops profiles: ADT discovery on w200 advertises no debugger collection, so the capability report reports debuggerCapability=platform_unsupported and the six abap_debug_* tools cannot succeed. Registered and still callable through the full profile; not deleted. |
| `abap_debug_variable` | Withheld from the dev/config/ops profiles: ADT discovery on w200 advertises no debugger collection, so the capability report reports debuggerCapability=platform_unsupported and the six abap_debug_* tools cannot succeed. Registered and still callable through the full profile; not deleted. |

## 工具清单

| 工具 | 分组 | profile | 风险 | 路由 | SAP 助手（最低协议） |
| --- | --- | --- | --- | --- | --- |
| `abap_activate` | source | dev | 写 | native-adt | — |
| `abap_debug_breakpoint` | debug |  | 写 | native-adt | — |
| `abap_debug_session` | debug |  | 写 | native-adt | — |
| `abap_debug_stack` | debug |  | 只读 | native-adt | — |
| `abap_debug_status` | debug |  | 只读 | native-adt | — |
| `abap_debug_step` | debug |  | 写 | native-adt | — |
| `abap_debug_variable` | debug |  | 只读 | native-adt | — |
| `abap_download` | source | dev | 写 | target-specific | — |
| `activate_smartform` | form | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_SMARTFORM_API |
| `add_objects_to_transport` | ops | ops | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.8) |
| `adt_discovery_export` | platform | platform | 写 | native-adt | — |
| `analyze_abap_dumps` | ops | dev, ops | 只读 | native-adt | — |
| `analyze_abap_traces` | ops | ops | 只读 | native-adt | — |
| `analyze_change_impact` | source | dev | 只读 | target-specific | — |
| `append_ddic_transparent_table_fields` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.17) |
| `apply_configuration_bc_set` | data | config | 写 | target-specific | — |
| `apply_configuration_number_range` | data | config | 写 | target-specific | — |
| `apply_configuration_unit_text` | data | config | 写 | target-specific | — |
| `cancel_background_job` | ops | ops | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.14) |
| `cleanup_transport_entries` | ops | ops | 破坏性写 | native-adt | — |
| `compare_configuration_bc_set` | data | config | 只读 | target-specific | — |
| `compare_configuration_unit` | data | config | 只读 | target-specific | — |
| `compare_systems` | ops | ops | 只读 | local | — |
| `correlate_sap_logs` | ops | ops | 只读 | target-specific | — |
| `create_abap_message_class` | message | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.7) |
| `create_background_job` | ops | ops | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.19) |
| `create_ddic_transparent_table` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.17) |
| `create_enhancement_hook_implementation` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `create_function_module_with_interface` | function | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.3) |
| `create_module_pool` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `create_new_badi_implementation` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `create_object_programmatically` | source | dev | 写 | target-specific | — |
| `create_report_transaction` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.2) |
| `create_smartform` | form | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_SMARTFORM_API |
| `create_test_include` | source | dev | 写 | native-adt | — |
| `create_transaction_code` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `create_transport_request` | ops | ops | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.8) |
| `delete_abap_message_class` | message | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.9) |
| `delete_abap_source_object` | source | dev | 破坏性写 | native-adt | — |
| `delete_ddic_object` | ddic | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.6) |
| `delete_enhancement_implementation` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `delete_module_pool` | ui | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `delete_sap_lock` | ops | ops | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.15) |
| `delete_transaction_code` | ui | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `describe_configuration_object` | data | config | 只读 | target-specific | — |
| `diagnose_sap_failure` | ops | dev, ops | 只读 | native-adt | — |
| `discover_application_logs` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_LOG_READ |
| `evaluate_refactoring` | source | dev | 只读 | native-adt | — |
| `execute_data_query` | data | dev, config, ops | 只读 | target-specific | — |
| `find_configuration_activities` | data | config | 只读 | target-specific | — |
| `find_configuration_bc_sets` | data | config | 只读 | target-specific | — |
| `find_where_used` | source | dev | 只读 | target-specific | — |
| `format_abap_source` | source | dev | 只读 | native-adt | — |
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
| `get_quick_fix_proposals` | source | dev | 只读 | native-adt | — |
| `get_runtime_info` | platform | platform | 只读 | local | — |
| `get_sap_system_info` | ops | dev, config, ops | 只读 | target-specific | — |
| `get_version_history` | source | dev | 只读 | target-specific | — |
| `get_write_operation_status` | platform | platform | 只读 | local | — |
| `import_transport_queue` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.18) |
| `inspect_configuration_bc_impact` | data | config | 只读 | target-specific | — |
| `inspect_configuration_bc_route` | data | config | 只读 | target-specific | — |
| `inspect_configuration_bte_maintenance_route` | enhancement | dev, config | 只读 | target-specific | — |
| `inspect_configuration_bte_native_metadata` | enhancement | dev, config | 只读 | target-specific | — |
| `inspect_configuration_transport` | data | config | 只读 | target-specific | — |
| `inspect_customer_function_exits` | enhancement | dev | 只读 | target-specific | — |
| `inspect_customer_screen_menu_exits` | enhancement | dev | 只读 | target-specific | — |
| `inspect_enhancement_framework` | enhancement | dev | 只读 | target-specific | — |
| `inspect_fico_rule_exit_program` | enhancement | dev, config | 只读 | target-specific | — |
| `inspect_repository_assignment` | function | dev, config | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.3) |
| `inspect_source_enhancements` | enhancement | dev | 只读 | target-specific | — |
| `invoke_customer_function_module` | function | dev | 写 | target-specific | — |
| `list_write_recovery_operations` | platform | platform | 只读 | local | — |
| `manage_classic_badi_implementation` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.23) |
| `manage_enhancement_implementation_state` | enhancement | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.23) |
| `manage_text_elements` | source | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.12) |
| `manage_transport_requests` | ops | dev, config, ops | 只读 | target-specific | — |
| `modify_background_job` | ops | ops | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.21) |
| `patch_abap_gui_definition` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.5) |
| `patch_abap_screen` | ui | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.4) |
| `patch_ddic_transparent_table_fields` | ddic | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.17) |
| `patch_ddic_transparent_table_settings` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.16) |
| `patch_function_module_interface` | function | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_EXECUTE (≥2.28) |
| `preflight_configuration_bc_activation` | data | config | 只读 | target-specific | — |
| `prepare_configuration_bte_product_change` | enhancement | dev, config | 只读 | target-specific | — |
| `prepare_enhancement_configuration_workflow` | enhancement | config | 只读 | target-specific | — |
| `preview_configuration` | data | config | 只读 | target-specific | — |
| `preview_configuration_bc_native` | data | config | 只读 | target-specific | — |
| `preview_configuration_bte_product` | enhancement | dev, config | 只读 | target-specific | — |
| `preview_configuration_number_range` | data | config | 只读 | target-specific | — |
| `preview_configuration_unit_text` | data | config | 只读 | target-specific | — |
| `preview_source_changes` | source | dev | 只读 | target-specific | — |
| `promote_object` | ops | ops | 只读 | local | — |
| `read_abap_gui_definition` | ui | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.5) |
| `read_abap_message_class` | message | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.7) |
| `read_abap_screen` | ui | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `read_abap_table` | data | dev, config, ops | 只读 | target-specific | — |
| `read_adobe_form` | form | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.8) |
| `read_application_log` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_LOG_READ |
| `read_archive_status` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_MAINT_READ (≥1.1) |
| `read_authorization_trace` | ops | dev, config, ops | 只读 | target-specific | — |
| `read_background_job_details` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_OPS_READ |
| `read_background_job_log` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_OPS_READ |
| `read_background_job_spool` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_OPS_READ |
| `read_bte_configuration` | enhancement | dev, config | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.3) |
| `read_ccms_alerts` | ops | dev, config, ops | 只读 | target-specific | — |
| `read_classic_badi_definition` | enhancement | dev, config | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.4) |
| `read_configuration_activity` | data | config | 只读 | target-specific | — |
| `read_configuration_bc_before_state` | data | config | 只读 | target-specific | — |
| `read_configuration_bc_cts_snapshot` | data | config | 只读 | target-specific | — |
| `read_configuration_bc_dependencies` | data | config | 只读 | target-specific | — |
| `read_configuration_bc_effects` | data | config | 只读 | target-specific | — |
| `read_configuration_bc_guard` | data | config | 只读 | target-specific | — |
| `read_configuration_bc_logs` | data | config | 只读 | target-specific | — |
| `read_configuration_bc_native_snapshot` | data | config | 只读 | target-specific | — |
| `read_configuration_bc_set` | data | config | 只读 | target-specific | — |
| `read_configuration_documentation` | data | config | 只读 | target-specific | — |
| `read_configuration_fi_rule` | enhancement | config | 只读 | target-specific | — |
| `read_configuration_number_range` | data | config | 只读 | target-specific | — |
| `read_configuration_number_range_api` | data | config | 只读 | target-specific | — |
| `read_configuration_number_range_scope` | data | config | 只读 | target-specific | — |
| `read_configuration_unit` | data | config | 只读 | target-specific | — |
| `read_customer_exit_definition` | enhancement | dev, config | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.2) |
| `read_customer_exit_project` | enhancement | dev, config | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.2) |
| `read_db_activity` | ops | dev, config, ops | 只读 | target-specific | Z_ORVANTA_OPS_READ (≥1.1) |
| `read_ddic_data_element` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `read_ddic_domain` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `read_ddic_structure` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `read_ddic_table_conversion_status` | ddic | dev, ops | 只读 | target-specific | — |
| `read_ddic_table_type` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.2) |
| `read_ddic_transparent_table` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.5) |
| `read_enhancement_implementation` | enhancement | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.6) |
| `read_failed_update` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_MAINT_READ |
| `read_file_system_directory` | ops | dev, config, ops | 只读 | target-specific | Z_ORVANTA_OPS_READ (≥1.1) |
| `read_function_module_interface` | function | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.3) |
| `read_idoc_status` | ops | dev, config, ops | 只读 | target-specific | — |
| `read_lock_object` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.9) |
| `read_maintenance_view` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.11) |
| `read_number_range_object` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.11) |
| `read_performance_snapshot` | ops | dev, config, ops | 只读 | target-specific | Z_ORVANTA_OPS_READ (≥1.1) |
| `read_qrfc_queues` | ops | dev, config, ops | 只读 | target-specific | — |
| `read_report_parameters` | data | dev, config, ops | 只读 | sap-helper-fallback | Z_ORVANTA_OPS_READ |
| `read_report_variants` | data | dev, config, ops | 只读 | target-specific | — |
| `read_role_authorizations` | ops | dev, config, ops | 只读 | target-specific | — |
| `read_sapscript_form` | form | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.8) |
| `read_search_help` | ddic | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.8) |
| `read_smartform` | form | dev | 只读 | sap-helper-fallback | Z_ORVANTA_SMARTFORM_API |
| `read_smartstyle` | form | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.8) |
| `read_system_logs` | ops | ops | 只读 | sap-helper-fallback | Z_ORVANTA_OPS_READ |
| `read_system_parameters` | ops | dev, config, ops | 只读 | target-specific | — |
| `read_transaction_code` | ui | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.1) |
| `read_trfc_error_entries` | ops | dev, config, ops | 只读 | target-specific | — |
| `read_user_authorizations` | ops | dev, config, ops | 只读 | target-specific | — |
| `read_user_sessions` | ops | dev, config, ops | 只读 | target-specific | Z_ORVANTA_OPS_READ (≥1.1) |
| `read_work_processes` | ops | dev, config, ops | 只读 | target-specific | Z_ORVANTA_OPS_READ (≥1.1) |
| `read_workload_directory` | ops | dev, config, ops | 只读 | target-specific | — |
| `reconcile_configuration_bc_execution` | data | config | 只读 | target-specific | — |
| `reconcile_configuration_number_range` | data | config | 只读 | target-specific | — |
| `reconcile_configuration_unit_text` | data | config | 只读 | target-specific | — |
| `recover_configuration_bc_set` | data | config | 破坏性写 | target-specific | — |
| `recover_ddic_table_conversion` | ddic | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.7) |
| `release_background_job` | ops | ops | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.13) |
| `release_transport_task` | ops | ops | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥2.16) |
| `release_write_operation_lock` | platform | platform | 写 | local | — |
| `replace_string_in_abap_object` | source | dev | 写 | native-adt | — |
| `resume_ddic_table_activation` | ddic | dev | 破坏性写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.16) |
| `run_abap_program` | function | dev | 破坏性写 | target-specific | — |
| `run_atc_analysis` | quality | dev | 写 | target-specific | — |
| `run_sci_analysis` | quality | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_SCI_API (≥1.0) |
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
| `upsert_append_structure_fields` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.16) |
| `upsert_ddic_data_element` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.16) |
| `upsert_ddic_domain` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.16) |
| `upsert_ddic_structure` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.17) |
| `upsert_ddic_table_type` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.16) |
| `upsert_lock_object` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.16) |
| `upsert_maintenance_view` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.16) |
| `upsert_number_range_object` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.16) |
| `upsert_search_help` | ddic | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_DDIC_API (≥1.16) |
| `validate_dynpro_application` | ui | dev | 只读 | sap-helper-fallback | Z_ORVANTA_MCP_DYNPRO_API (≥1.4) |
| `write_function_module_source` | function | dev | 写 | sap-helper-fallback | Z_ORVANTA_MCP_EXECUTE (≥2.11) |

## 边界说明

- `abap_debug_breakpoint`：仅允许 Z/Y 源码断点；真实调试链路未验收。
- `abap_debug_session`：w200 调试端点曾返回 404；仅 Mock 验证，真实会话未验收。
- `abap_debug_step`：单步/继续会驱动被调试程序执行，可能存在业务副作用。
- `abap_download`：写入本地文件系统；程序不自动包含其 Include，需显式下载。
- `adt_discovery_export`：写入本地 Markdown 文件；w200 Discovery 未返回 template link / core entry。
- `analyze_abap_traces`：w200 上 ADT trace 端点返回 HTTP 404（能力报告判定 unsupported）；注册不等于可用。
- `apply_configuration_number_range`：Unused NUMC20 client-local interval create/update through attested customer API and protected whole-object receipt. Native deployment/acceptance pending; no allocator, CTS migration or GUI.
- `apply_configuration_unit_text`：CFG-02 API 保存：仅 w200/200 已有单语言 T006A 非空描述，必需双版本、明确 W/Q 请求任务及 operationId。客户 RFC 未部署/正文漂移即拒绝；注册不代表保存验收。锁内版本、同步 UPDATE_T006A、精确 CTS 和回滚仍待 SAP 实测，无 GUI 或通用写表回退。
- `cleanup_transport_entries`：移除 CTS 任务条目，不删除、不释放传输；w200 写端点尚未验证。
- `compare_configuration_bc_set`：CFG-04：BC Set 已存字符字段与 w200/200 单位/明确语言现值比较；变量/通配键、数值转换及语言覆盖不可推断，拒绝激活与写入。
- `compare_configuration_unit`：CFG-06：w200/200 与 w300/300 的单计量单位/语言投影比较；两侧元数据必须实读匹配，失败不可比较，当前 w300 登录验收待完成。
- `correlate_sap_logs`：固定来源的有界关联，不证明因果；各来源失败分别报告。
- `describe_configuration_object`：CFG-01：现有 customizing 白名单内至多 64 字段的平面透明表元数据；T006/T006A 可选复用 IMG 标题与局部路径读取。业务维护 API/CTS 未知，无配置值读取或写入。
- `diagnose_sap_failure`：只读 ST22 解析；时间关联是候选证据，不认定根因。
- `discover_application_logs`：需要管理员批准的只读助手；返回有界样本，不是完整日志清单。
- `execute_data_query`：w200 原生数据预览端点返回非 XML 响应；当前依赖受限只读后备。原生与后备两条路径都过 D5-2 白名单（默认拒绝），表名无法静态枚举即拒绝。
- `find_configuration_activities`：CFG-05：默认精确 S 类型查找；T006/T006A 可选解析 OBJS 关联、标题和局部物理路径。T 类型经 TSTC/CUS_ACTOBJ 导航，其他类型使用已审阅 RFC。完整 SPRO 可见性和业务维护 API 未验证，无写入。
- `find_configuration_bc_sets`：CFG-04：按获准 T006/T006A 和明确版本定向发现经典 BC Set 候选；有行数上限、复读与元数据保护，不能据候选认定可激活。
- `find_where_used`：w200 上原生引用映射曾超时并伴随 RIS 故障；失败不得解释为零引用。ECC 7.31 无 usageReferences 端点，只走 legacy RIS 通路，该通路覆盖函数模块、类、接口、程序的声明位置（0.50.5 起），不含片段检索。
- `inspect_configuration_bc_impact`：CFG-04：依赖图、T006/T006A 内容与现值差异的有界只读汇总；总单位读取限额和复读明确，不产生激活计划或整套配置结论。
- `inspect_configuration_transport`：CFG-01：w200/200 明确请求/任务的 W/Q 类型、归属、状态、客户端及目标复读；未知保持阻断，不认定 E071K/API 可写。
- `invoke_customer_function_module`：正式白名单调用，非只读；需一次性请求凭证与副作用确认。
- `manage_transport_requests`：只读：不创建、不释放、不导入传输。
- `preview_configuration`：仅服务 w200/200 的 ZTPMC_TPCFG 工厂行预览，属客户项目对象固化在通用服务中的待整改项。
- `preview_configuration_number_range`：CFG-03：精确数字区间候选的边界、重叠、缩容及模式风险只读预检；复读全部区间和已核实域/API 源码，不调用有会话副作用的维护函数，不认定可写。
- `preview_configuration_unit_text`：CFG-02 文本草案：仅 w200/200 已有单语言 T006A 描述 MSEHT/MSEHL；核对已读投影版本及字段元数据，保留省略字段。可选 expectedTextVersion 最后读取并比较 SAP 完整行版本，旧版本撤回草案；锁内检查及业务规则/API/CTS 未验证，不可执行，无保存 token 或写入。
- `read_abap_table`：最多 500 行、仅字符比较、无联接/聚合/排序；宽表按主键分块并二次复核。
- `read_application_log`：日志正文属不可信证据；分页需要 revision，变更后拒绝拼接。
- `read_background_job_details`：需要单独批准的 SM37_DETAILS scope；返回步骤元数据，不含变式值与 Spool 正文。
- `read_background_job_spool`：需要单独批准的 SP01 scope；仅文本，无 OTF/PDF 与打印，分页非原子快照。
- `read_ccms_alerts`：告警历史（ALALERTDB 持久化记录），不是 RZ20 实时监视；空结果不等于系统健康。行序未指定，非最新若干条；SEVERITY/STATUS/VALUE 为整数型，只展示不可筛选。
- `read_configuration_activity`：CFG-05：w200/200 按活动标识直接读取标题、局部节点路径与至多 16 个 CUS_ACTOBJ 维护对象关联；固定元数据读取与指纹复核，不扩展通用白名单，不执行配置维护。
- `read_configuration_bc_dependencies`：CFG-04：w200/200 N 版本子引用有界图；复读、缺节点、循环及边界明确，不推断激活顺序或目标表影响。
- `read_configuration_bc_logs`：CFG-04：经典 BC Set 历史选中消息与记录目标 client 200 的激活表头；不推断当前状态、整次成功或日志版本。
- `read_configuration_bc_native_snapshot`：CFG-04：EHS_CUNI_KNM/N 五表完整原生前态与 SAP 版本；别名按自身键查询冲突，缺失明确，来源和元数据复读，不激活或修改配置。
- `read_configuration_bc_set`：CFG-04：w200/200 精确 BC Set/版本的表头及 T006/T006A 内容投影；标志有依据，依赖和目标比较未覆盖，不执行激活。
- `read_configuration_fi_rule`：CFG-07：w200/200 精确 FI 规则头/步骤引用及公司代码/调用点启用等级、应用类回读；生成代码和业务效果未验证，无启停维护。
- `read_configuration_number_range`：CFG-03：w200/200 精确 Z/Y 对象、子对象和年度的 NRIV 区间投影；号码保持字符串，无分配与维护，复读变化和截断明确。
- `read_configuration_number_range_api`：Complete native customer TNRO/current-client NRIV version; pinned layout, reader and hash source. Deployment and positive SAP acceptance pending; no mutation.
- `read_configuration_number_range_scope`：CFG-03：精确子对象的跨年度 NRIV 投影与有效年度范围，区分空值和通配；复读子对象元素/域，来源表和存在性未知保持 unknown，不执行标准有状态接口。
- `read_configuration_unit`：CFG-02 读侧：仅 w200/200 内部 MSEHI 精确键，读取 T006 非浮点字段及单语言 T006A 文本；复核读值与定义，指纹仅覆盖已读文本投影，不能用于配置写入。
- `read_failed_update`：只读；不提供参数载荷或完整错误正文。
- `read_report_parameters`：依赖 Z_ORVANTA_OPS_READ 的 REPORT_PARAMETERS scope（须在批准文件中对该连接单独启用）；仅读取已编译 SSCR 元数据，不生成、不读变式内容。
- `read_report_variants`：通过受限单表读取当前 client 的 VARID 目录元数据；不读参数值，不合并 client 000。
- `reconcile_configuration_number_range`：Protected receipt and current full number range snapshot read-only comparison; no historical outcome promotion, retry, rollback or unlock. Native positive acceptance pending.
- `reconcile_configuration_unit_text`：CFG-02：原请求/旧行先绑定本地回执与原生版本，再只读复核现值、CTS 投影及可选获准锁观察；当前值与历史提交不等价，保留未知回执，不自动重试或恢复。
- `release_write_operation_lock`：仅解除本地目标锁，不触碰 SAP 锁；需人工确认与最新凭证哈希。
- `replace_string_in_abap_object`：函数模块改由仓库助手写入（SAP_BASIS 7.31 上 ADT 源码 PUT 一律 HTTP 423，2026-09-18 追踪 12/12），因此该目标额外依赖助手操作码 WRITE_FUNCTION_SOURCE（仓库助手协议 ≥2.9：该修订同时接受「接口骨架」与「接口留在函数模块参数表、正文紧随 FUNCTION 语句」两种 include 布局，旧助手对第二种报 SOURCE_MARKER_ERROR）；程序、类、接口等仍是原生 ADT。函数模块只能替换实现正文，接口段改动被拒绝并指向 patch_function_module_interface 或 SE37。
- `run_abap_program`：执行既有 Z/Y 程序本体，可能产生业务副作用；仅回 SUBMIT 返回码，列表输出不返回。
- `run_atc_analysis`：w200 原生 ATC 端点不可用，当前退化为语法报告；不得作为质量门禁通过依据。
- `run_sci_analysis`：非原生 ATC，规则范围固定且依赖指纹匹配的 SCI 助手；timeout 不等于取消。
- `run_unit_tests`：执行现有 ABAP Unit，测试代码可能有副作用；需先取得授权。
- `search_application_logs`：需要管理员批准的只读助手；未批准时返回不可用，不代表日志为空。
- `search_failed_updates`：只读；不执行更新重处理。助手已部署，2026-09-30 以真实失败更新样本取过调用。
- `search_sap_locks`：只读；不提供 SAP 解锁。本地凭证不能证明 SAP 锁归属。
- `test_remote_function_module`：执行客户 RFC，可能产生业务副作用；白名单与显式确认必需。
