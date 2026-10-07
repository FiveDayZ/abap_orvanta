FUNCTION Z_ORVANTA_CFG_BC_APPLY.
DATA: ls_args TYPE ty_orv_bc_args, ls_result TYPE ty_orv_bc_result.
ls_args-operation_hash = iv_operation_hash.
ls_args-before_reference = iv_before_reference.
ls_args-state_base64 = iv_state_base64.
ls_args-state_version = iv_state_version.
ls_args-source_version = iv_source_version.
ls_args-target_version = iv_target_version.
ls_args-candidate_version = iv_candidate_version.
ls_args-metadata_version = iv_metadata_version.
ls_args-guard_version = iv_guard_version.
ls_args-cts_version = iv_cts_version.
ls_args-effects_base64 = iv_effects_base64.
ls_args-effects_version = iv_effects_version.
ls_args-cts_base64 = iv_cts_base64.
ls_args-frame_base64 = iv_frame_base64.
ls_args-frame_version = iv_frame_version.
ls_args-command = 'A'.
PERFORM orv_bc_owner USING ' ' ls_args CHANGING ls_result.
ev_code = ls_result-code.
ev_system = ls_result-system.
ev_client = ls_result-client.
ev_user = ls_result-user.
ev_operation_hash = ls_result-operation_hash.
ev_before_reference = ls_result-before_reference.
ev_commit = ls_result-commit.
ev_phase = ls_result-phase.
ev_configuration = ls_result-configuration.
ev_protected = ls_result-protected.
ev_cts = ls_result-cts.
ev_effects = ls_result-effects.
ev_locks = ls_result-locks.
ev_protocol = ls_result-protocol.
ev_act_id = ls_result-act_id.
ev_frame_base64 = ls_result-frame_base64.
ev_frame_version = ls_result-frame_version.
ev_msgid = ls_result-msgid.
ev_msgno = ls_result-msgno.
ev_msgv1 = ls_result-msgv1.
ev_msgv2 = ls_result-msgv2.
ev_msgv3 = ls_result-msgv3.
ev_msgv4 = ls_result-msgv4.
ENDFUNCTION.