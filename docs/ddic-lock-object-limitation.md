# DDIC lock object limitation (`UPSERT_LOCK_OBJECT` / `DELETE_LOCK_OBJECT`)

Status: **known limitation, not a defect in this repository.** Verified on SAP ECC / SAP_BASIS 7.31 SP04, system `w200`, client `200`, on 2026-09-23.

## What is limited

Registering a **customer lock object** (TADIR `R3TR ENQU`) into a **customer package** is rejected by SAP's own TADIR registration chain. The helper therefore cannot create the transportable registration for `UPSERT_LOCK_OBJECT`; `DELETE_LOCK_OBJECT` is unaffected only because it never needs that registration.

Tables (`TABL`), views (`VIEW`) and number ranges (`NROB`) are registered by the same helper code path and succeed — the rejection is specific to `ENQU`.

## What the caller sees

| Aspect | Behaviour |
| --- | --- |
| Stable code | `TADIR_ENTRY_FAILED` |
| Message | SAP's original message text, e.g. `SAP 对象 ENQU <NAME> 无法被分配到包 <PACKAGE>` |
| Short dump | none (the call is type-correct; see history below) |
| Partial persistence | none — no `TADIR` row is left behind for the rejected object |
| `ev_version` | `1.11` |

The operation fails closed: it does not report success and does not leave a half-registered object.

## Evidence

- Registration attempt with a pre-created TADIR entry and `RS_CORR_INSERT` (r19-r22) → `CALL_FUNCTION_CONFLICT_TYPE` short dump. ST22 full content named the cause: `WI_TADIR_SRCSYSTEM` requires `TADIR-SRCSYSTEM` (CHAR 10) but received `sy-sysid` (`SYSYSID`, CHAR 8). Fixed in r23; no dump occurs after that.
- Registration attempt after the fix (r23) and with `IV_NO_PAK_CHECK = 'X'` (r24) → both return the same clean rejection above. `IV_NO_PAK_CHECK` does **not** bypass this check.
- `TADIR` query for the rejected object name → 0 rows (no residue).
- `TADIR` query for `R3TR`/`ENQU` → many rows, all `SRCSYSTEM = SAP`. The system supports ENQU registration in general; it is the customer-package assignment of a customer lock object that is refused.

## Read-only source findings

- `TR_TADIR_INTERFACE` (function group `STRD`) forwards to `TRINT_TADIR_INTERFACE` and maps 24 named exceptions. Entry 6 is `OBJECT_RESERVED_FOR_DEVCLASS` ("object reserved for a devclass"), whose semantics match the message above.
- `IV_NO_PAK_CHECK` becomes `ls_tadir-paknocheck` and is only stored into the TADIR row (`TRINT_TADIR_INSERT`: `LS_TADIR-PAKNOCHECK = PAKNOCHECK`). It is a stored flag, not the switch that suppresses this rejection — consistent with the runtime result.
- The raise itself was not located in the function module main sources or the searched includes; the exact exception number is **not proven** (message table `T100` is not readable through the diagnostic allowlist).

## Operator guidance

1. Create the lock object manually in **SE11**, specifying the target package and transport request at creation time.
2. Do not retry `upsert_lock_object` in a loop for the same object: the outcome is deterministic.
3. Use the tool for reading/verification after the manual creation.

This limitation does not affect table, view, data element, domain or number-range operations.
