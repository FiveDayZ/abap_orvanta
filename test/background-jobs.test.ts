import assert from "node:assert/strict"
import test from "node:test"
import {
  JOB_CONFIRMATIONS,
  JOB_CONTROL_CODES,
  cancelBackgroundJobSchema,
  jobCancelResult,
  jobControlCode,
  jobCount,
  jobName,
  jobPayloadRows,
  jobReleaseResult,
  jobStartTime,
  jobSteps,
  releaseBackgroundJobSchema
} from "../src/background-jobs.js"

/**
 * `release_background_job` (N3 / OP2) is the first action tool the jobs family has ever had, so the
 * properties worth pinning are the ones that would turn a wrong answer into a wrong action:
 *
 *  - the confirmation string is the only thing standing between a read's arguments and a scheduler
 *    change, so it must be exact and required;
 *  - the released status must come from SAP's read-back, never from the request, so a success reply
 *    without a status is refused rather than reported as a blank success;
 *  - the job identity is normalised with the same rules the read tools use, so a caller cannot
 *    release a job whose name it could not have found.
 */

test("the release confirmation string is required and exact", () => {
  const base = { connectionId: "w200", jobName: "ZJOB", jobCount: "00000001" }
  assert.equal(
    releaseBackgroundJobSchema.safeParse({ ...base, confirmation: "RELEASE_BACKGROUND_JOB" })
      .success,
    true
  )
  // A read tool's arguments pasted into a write tool must not be accepted.
  assert.equal(releaseBackgroundJobSchema.safeParse(base).success, false)
  assert.equal(
    releaseBackgroundJobSchema.safeParse({ ...base, confirmation: "release_background_job" })
      .success,
    false
  )
  assert.equal(
    releaseBackgroundJobSchema.safeParse({ ...base, confirmation: "CANCEL_BACKGROUND_JOB" })
      .success,
    false
  )
  // Strict: an unknown key is rejected rather than ignored.
  assert.equal(
    releaseBackgroundJobSchema.safeParse({
      ...base,
      confirmation: "RELEASE_BACKGROUND_JOB",
      mutate: "X"
    }).success,
    false
  )
})

test("a job identity is normalised the way the read tools normalise it", () => {
  assert.equal(jobName(" zjob "), "ZJOB")
  assert.equal(jobCount(" 00000001 "), "00000001")
  for (const bad of ["", "Z JOB", "Z*JOB", "A".repeat(33)])
    assert.throws(() => jobName(bad), /JOB_NAME_INVALID/, `jobName(${bad})`)
  // TBTCO-JOBCOUNT is CHAR8, so both a short and a long identity are refused: the read tools
  // demand exactly eight digits and the write tools must not accept what they cannot match.
  for (const bad of ["", "12A", "1".repeat(7), "1".repeat(9)])
    assert.throws(() => jobCount(bad), /JOB_COUNT_INVALID/)
})

test("the helper payload is parsed strictly, including its escaping", () => {
  const rows = jobPayloadRows([
    "M|1|JOBNAME|ZJOB",
    "M|2|JOBCOUNT|0000000001",
    "M|3|STATUS|R",
    "M|4|STEP_COUNT|2",
    "M|5|COMMENT|a%7Cb%25c"
  ])
  assert.equal(rows["JOBNAME"], "ZJOB")
  assert.equal(rows["STATUS"], "R")
  // Percent-escaped separators must be restored, not left escaped.
  assert.equal(rows["COMMENT"], "a|b%c")
  // An unparseable or unknown-kind row is an error, not something to skip silently.
  assert.throws(() => jobPayloadRows(["garbage"]), /invalid payload line/)
  assert.throws(() => jobPayloadRows(["T|1|TRKORR|X"]), /unknown payload kind/)
})

test("a successful release reports SAP's own status, and refuses a blank one", () => {
  const ok = jobReleaseResult("w200", {
    status: "S",
    code: "JOB_RELEASED",
    message: "Job released and status read back",
    metadata: { JOBNAME: "ZJOB", JOBCOUNT: "0000000001", STATUS: "R", STEP_COUNT: "2" }
  })
  assert.equal(ok.status, "ok")
  assert.equal(ok.jobStatus, "R")
  assert.equal(ok.stepCount, 2)
  assert.equal(ok.readBack.performed, true)
  assert.equal(ok.readBack.jobStatusAfter, "R")
  assert.equal(ok.confirmation, JOB_CONFIRMATIONS.release)
  assert.equal(ok.readOnly, false)

  // SAP said success but published no status: that is an invalid reply, not a blank success.
  assert.throws(
    () =>
      jobReleaseResult("w200", {
        status: "S",
        code: "JOB_RELEASED",
        message: "ok",
        metadata: { JOBNAME: "ZJOB", JOBCOUNT: "0000000001" }
      }),
    /JOB_RESPONSE_INVALID/
  )
})

test("a failed release carries the helper's code and claims no read-back", () => {
  const failed = jobReleaseResult("w200", {
    status: "E",
    code: "JOB_STATUS_UNCHANGED",
    message: "Release did not change the job status",
    metadata: { JOBNAME: "ZJOB", JOBCOUNT: "0000000001" }
  })
  assert.equal(failed.status, "failed")
  assert.equal(failed.code, "JOB_STATUS_UNCHANGED")
  assert.equal(failed.readBack.performed, false)
  assert.equal(failed.readBack.jobStatusAfter, null)
})

test("only contracted codes reach the caller", () => {
  // An unrecognised helper code must not travel through as if it were part of the contract.
  assert.equal(jobControlCode("JOB_NOT_FOUND"), "JOB_NOT_FOUND")
  assert.equal(jobControlCode("SOMETHING_NEW_FROM_SAP"), "JOB_CONTROL_FAILED")
  assert.equal(jobControlCode(undefined), "JOB_CONTROL_FAILED")
  assert.ok(new Set(JOB_CONTROL_CODES).size === JOB_CONTROL_CODES.length, "codes must be unique")
})

test("step and start-time validation refuse what SAP would only discover later", () => {
  assert.deepEqual(jobSteps([{ programName: "zreport" }]), [{ programName: "ZREPORT" }])
  assert.deepEqual(jobSteps([{ programName: "ZR", variantName: "v1" }]), [
    { programName: "ZR", variantName: "V1" }
  ])
  // A create with no steps is a caller error, not a SAP exception to decode.
  assert.throws(() => jobSteps([]), /JOB_STEP_REQUIRED/)
  assert.throws(() => jobSteps([{ programName: "" }]), /JOB_STEP_INVALID/)
  assert.throws(() => jobSteps([{ programName: "ZR", variantName: "V 1" }]), /JOB_STEP_INVALID/)
  assert.throws(
    () => jobSteps(Array.from({ length: 21 }, () => ({ programName: "ZR" }))),
    /JOB_TOO_MANY_STEPS/
  )

  assert.deepEqual(jobStartTime("2026-09-28T01:30:00"), { date: "20260928", time: "013000" })
  // An impossible time or date must be refused here rather than handed to SAP.
  for (const bad of [
    "2026-09-28 01:30:00",
    "2026-09-28T24:00:00",
    "2026-13-01T00:00:00",
    "2026-09-32T00:00:00"
  ])
    assert.throws(() => jobStartTime(bad), /JOB_START_TIME_INVALID/, bad)
})

/**
 * `cancel_background_job` (N3 / OP2) is the destructive half of job control, so the properties worth
 * pinning are the ones that would turn a wrong answer into a destroyed job or a false success:
 *
 *  - the confirmation string must be the cancel one exactly, and the arguments of the release tool
 *    must not be accepted by it, because the two differ only in what they do to the job;
 *  - cancellation is proved by absence, so a success reply that still carries a status is refused
 *    rather than reported as a cancelled job that somehow still has one;
 *  - a failure never claims absence - the read-back fields stay null, not false.
 */

test("the cancel confirmation string is required and is not the release one", () => {
  const base = { connectionId: "w200", jobName: "ZJOB", jobCount: "00000001" }
  assert.equal(
    cancelBackgroundJobSchema.safeParse({ ...base, confirmation: "CANCEL_BACKGROUND_JOB" }).success,
    true
  )
  assert.equal(cancelBackgroundJobSchema.safeParse(base).success, false)
  assert.equal(
    cancelBackgroundJobSchema.safeParse({ ...base, confirmation: "RELEASE_BACKGROUND_JOB" })
      .success,
    false
  )
  assert.equal(
    cancelBackgroundJobSchema.safeParse({ ...base, confirmation: "cancel_background_job" }).success,
    false
  )
  // Strict, and there is no forced mode to ask for: FORCEDMODE is deliberately left blank in the
  // helper because forced mode continues past cleanup errors.
  assert.equal(
    cancelBackgroundJobSchema.safeParse({
      ...base,
      confirmation: "CANCEL_BACKGROUND_JOB",
      forced: true
    }).success,
    false
  )
})

test("a successful cancel is proved by the job being gone, not by a status", () => {
  const ok = jobCancelResult("w200", {
    status: "S",
    code: "JOB_CANCELLED",
    message: "Job cancelled and absence read back",
    metadata: { JOBNAME: "ZJOB", JOBCOUNT: "0000000001", STATUS_BEFORE: "P" }
  })
  assert.equal(ok.status, "ok")
  assert.equal(ok.action, "cancel")
  assert.equal(ok.confirmation, JOB_CONFIRMATIONS.cancel)
  assert.equal(ok.readOnly, false)
  // There is no status and no step count left to report: the row and its steps are gone.
  assert.equal(ok.jobStatus, null)
  assert.equal(ok.stepCount, null)
  assert.equal(ok.readBack.performed, true)
  assert.equal(ok.readBack.jobExists, false)
  assert.equal(ok.readBack.jobStatusAfter, null)
  // What the job was before the delete survives only in the warning.
  assert.ok(ok.warnings.some((warning) => warning.includes("P")))

  // Success with no pre-delete status is an invalid reply, not a blank success.
  assert.throws(
    () =>
      jobCancelResult("w200", {
        status: "S",
        code: "JOB_CANCELLED",
        message: "ok",
        metadata: { JOBNAME: "ZJOB", JOBCOUNT: "0000000001" }
      }),
    /JOB_RESPONSE_INVALID/
  )
})

test("a failed cancel carries the helper's code and never claims absence", () => {
  for (const code of ["JOB_NOT_FOUND", "JOB_ALREADY_RUNNING", "JOB_STILL_PRESENT"]) {
    const failed = jobCancelResult("w200", {
      status: "E",
      code,
      message: "refused",
      metadata: { JOBNAME: "ZJOB", JOBCOUNT: "0000000001" }
    })
    assert.equal(failed.status, "failed", code)
    assert.equal(failed.code, code)
    assert.equal(failed.readBack.performed, false)
    // Absence is unknown on a failure, so it is null rather than false.
    assert.equal(failed.readBack.jobExists, null)
    assert.equal(failed.readBack.jobStatusAfter, null)
  }
})

test("the cancel arm's codes are contracted, unique, and include its success code", () => {
  for (const code of [
    "JOB_IDENTITY_REQUIRED",
    "JOB_STILL_PRESENT",
    "JOB_LOCKED",
    "JOB_COMMIT_FAILED",
    "JOB_CANCEL_FAILED",
    "JOB_CANCELLED"
  ])
    assert.equal(jobControlCode(code), code)
  // Both action tools' success codes must be registered, or a success would be reported as a
  // failure by the shared result builder.
  assert.ok(JOB_CONTROL_CODES.includes("JOB_CANCELLED"))
  assert.ok(JOB_CONTROL_CODES.includes("JOB_RELEASED"))
  assert.ok(JOB_CONTROL_CODES.includes("JOB_NOT_FOUND_AFTER_RELEASE"))
})
