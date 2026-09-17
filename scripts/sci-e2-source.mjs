import assert from "node:assert/strict"
import { sciV2Source } from "./sci-v2-source.mjs"

// Keep the deployed V2 body immutable; every E2 delta must match exactly once.
let body = sciV2Source.join("\n")
function replace(before, after) {
  assert.equal(body.split(before).length, 2, `Ambiguous SCI-E2 source delta: ${before}`)
  body = body.replace(before, after)
}
replace(
  "  DATA lo_test TYPE REF TO cl_ci_test_root.",
  "  DATA lo_nested TYPE REF TO cl_ci_test_select_nested.\n  DATA lo_test TYPE REF TO cl_ci_test_root."
)
replace(
  "ev_program, ev_package, ev_syntax, ev_critical.",
  "ev_program, ev_package, ev_syntax, ev_critical, ev_nested."
)
replace("ev_version = '2.0'.", "ev_version = '3.0'.")
replace("ev_variant = 'SYNTAX_CRITICAL_V1'.", "ev_variant = 'SYNTAX_CRITICAL_SQL_V1'.")
replace(
  "      CREATE OBJECT lo_critical.",
  "      CREATE OBJECT lo_critical.\n      CREATE OBJECT lo_nested."
)
replace(
  "      IF ev_syntax <> '001' OR ev_critical <> '002'.",
  "      ev_nested = lo_nested->version.\n      IF ev_syntax <> '001' OR ev_critical <> '002'\n         OR ev_nested <> '000'."
)
replace(
  "      ev_code = 'RULE_LOAD_FAILED'.",
  `      ls_rule-testname = 'CL_CI_TEST_SELECT_NESTED'.
      ls_rule-version = lo_nested->version.
      INSERT ls_rule INTO TABLE lt_variant.
      ev_code = 'RULE_LOAD_FAILED'.`
)
replace("      IF lv_count <> 2.", "      IF lv_count <> 3.")
replace(
  "      DESCRIBE TABLE lo_inspect->scirestps LINES ev_count.",
  `      " Inspect all results before applying the return-row cap.
      LOOP AT lo_inspect->scirestps INTO ls_finding.
        IF ls_finding-test = 'CL_CI_TEST_SCAN'.
          ev_code = 'SCAN_FAILED'.
          IF ls_finding-code = '0011'.
            ev_code = 'SCAN_INCLUDE_MISSING'.
          ENDIF.
          RETURN.
        ENDIF.
        IF ls_finding-objtype <> iv_object_type OR
           ls_finding-objname <> iv_object_name.
          ev_code = 'RESULT_OBJECT_MISMATCH'.
          RETURN.
        ENDIF.
        IF ls_finding-test <> 'CL_CI_TEST_SYNTAX_CHECK' AND
           ls_finding-test <> 'CL_CI_TEST_CRITICAL_STATEMENTS' AND
           ls_finding-test <> 'CL_CI_TEST_SELECT_NESTED'.
          ev_code = 'RESULT_RULE_MISMATCH'.
          RETURN.
        ENDIF.
        IF ls_finding-test = 'CL_CI_TEST_SELECT_NESTED'.
          IF ( ls_finding-code = '0002' AND ls_finding-kind = 'W' )
             OR ( ( ls_finding-code = '0001' OR
                    ls_finding-code = '0003' )
                  AND ls_finding-kind = 'N' ).
            CONTINUE.
          ENDIF.
          ev_code = 'RESULT_RULE_MISMATCH'.
          RETURN.
        ENDIF.
      ENDLOOP.
      DESCRIBE TABLE lo_inspect->scirestps LINES ev_count.`
)
replace(
  `        ELSE.
          ev_code = 'RESULT_RULE_MISMATCH'.`,
  `        ELSEIF ls_finding-test = 'CL_CI_TEST_SELECT_NESTED'.
          CALL METHOD lo_nested->get_message_text
            EXPORTING p_test = ls_finding-test p_code = ls_finding-code
            IMPORTING p_text = lv_text.
          REPLACE ALL OCCURRENCES OF '&1' IN lv_text
            WITH ls_finding-param1.
          IF lv_text IS INITIAL.
            ev_code = 'RESULT_MESSAGE_MISSING'.
            CLEAR ev_count.
            REFRESH et_results.
            RETURN.
          ENDIF.
        ELSE.
          ev_code = 'RESULT_RULE_MISMATCH'.`
)

export const sciE2Source = body.split("\n")
