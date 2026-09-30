// Shared ABAP macro for the runtime and metrics branches.
//
// Every numeric DDIC column that reaches the reply has to be normalized first: assigning an
// INT1/INT4/DEC field to a string right-aligns it with leading blanks (w200 DD03L, 2026-09-30), so
// the raw concatenation would emit "     12717" instead of "12717". RT_NUM does the conversion and
// the CONDENSE NO-GAPS in one place and then defers the escaping to the base JSON_FIELD macro.
//
// It is emitted once per generated body (the generator adds it when any branch that needs it is
// included), never inside a branch module, so two branch modules cannot define it twice.
export const jsonNumMacro = String.raw`
DEFINE rt_num.
  lv_value = &1.
  CONDENSE lv_value NO-GAPS.
  json_field &2 lv_value.
END-OF-DEFINITION.
`.trim()
