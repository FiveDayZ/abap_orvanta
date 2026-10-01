import assert from "node:assert/strict"
import test from "node:test"
import {
  JOB_CONFIRMATIONS,
  JOB_CONTROL_CODES,
  JOB_REPOSITORY_OPERATIONS,
  cancelBackgroundJobSchema,
  createBackgroundJob,
  createBackgroundJobSchema,
  jobCancelResult,
  jobControlCode,
  jobCount,
  jobCreateResult,
  jobModifyProblem,
  jobModifyResult,
  jobName,
  jobPayloadLine,
  jobPayloadRows,
  jobReleaseResult,
  jobReplyMetadata,
  jobSourceRows,
  jobStartTime,
  jobSteps,
  modifyBackgroundJob,
  modifyBackgroundJobSchema,
  releaseBackgroundJobSchema,
  type CreateBackgroundJobInput,
  type JobRepositoryChannel,
  type JobRepositoryReply,
  type JobRepositoryRequest,
  type ModifyBackgroundJobInput
} from "../src/background-jobs.js"
import { TOOL_REGISTRY } from "../src/tool-registry.js"

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

test("a midnight start time is sent as a start time, not left out", () => {
  // TBTCO-SDLSTRTTM is report type T, whose INITIAL value is '000000'. The helper arms cannot decide
  // "was a start time given?" from the stored value alone, so a service that dropped or normalised a
  // 00:00:00 schedule would make a legitimate midnight job uncreatable (observed live as
  // JOB_START_TIME_INVALID). The row must travel verbatim.
  assert.deepEqual(jobStartTime("2030-01-01T00:00:00"), { date: "20300101", time: "000000" })
  const rows = jobSourceRows({
    startDate: "20300101",
    startTime: "000000",
    steps: [{ programName: "RSPARAM" }]
  })
  assert.deepEqual(rows, [
    "H|1|START_DATE|20300101",
    "H|1|START_TIME|000000",
    "S|1|PROGRAM|RSPARAM"
  ])
  // A non-midnight schedule keeps the same shape.
  assert.deepEqual(jobSourceRows({ startDate: "20300102", startTime: "013000", steps: [] }), [
    "H|1|START_DATE|20300102",
    "H|1|START_TIME|013000"
  ])
})

test("a refusal is read as SAP's code even when the reply echoes the request rows", () => {
  // An arm that refuses before its first REFRESH returns the rows the caller sent in the reply table
  // (observed live: JOB_CREATE answered an error while `source` still held the H|/S| request rows).
  const requestRows = ["H|1|START_DATE|20300101", "H|1|START_TIME|000000", "S|1|PROGRAM|RSPARAM"]
  assert.deepEqual(jobReplyMetadata({ status: "E", source: requestRows }), {})
  assert.deepEqual(jobReplyMetadata({ status: "e", source: [] }), {})
  // The same rows in a success reply are still refused: there the rows are the evidence.
  assert.throws(
    () => jobReplyMetadata({ status: "S", source: requestRows }),
    /unknown payload kind/
  )
  // A refusal that does carry facts keeps them, so the orphan-job warning still reaches the caller.
  const carried = jobReplyMetadata({
    status: "E",
    source: [...requestRows, "M|1|JOBCOUNT|0000000001", "M|1|CLEANUP|DELETE_FAILED"]
  })
  assert.equal(carried["JOBCOUNT"], "0000000001")
  assert.equal(carried["CLEANUP"], "DELETE_FAILED")
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

/**
 * `create_background_job` and `modify_background_job` (N3 / OP2) complete the job-control family, so
 * the properties worth pinning are the ones that would turn a wrong request into a job SAP runs
 * under someone else's authorizations, or a wrong answer into a job the caller cannot address:
 *
 *  - every refusal the service can make must happen before the repository channel is called, because
 *    a create reaches the scheduler and a modify rewrites what the scheduler will execute - so each
 *    refusal test asserts that nothing was sent;
 *  - the payload is the `KIND|INDEX|PROPERTY|VALUE` shape the helper parses, with `%` and `|`
 *    escaped, and the identity never travels inside it;
 *  - a success is only a success when SAP's own read-back carries the fields the answer is made of: a
 *    create without the job count SAP assigned cannot be released, modified or cancelled afterwards.
 */

/**
 * A repository channel that records every call and answers with a canned reply.
 *
 * It is the reason these tests can prove a refusal happened *before* SAP was contacted: a refused
 * request leaves the recorded call list empty, which no assertion on a thrown error alone can show.
 */
function recordingChannel(reply: JobRepositoryReply): {
  channel: JobRepositoryChannel
  calls: JobRepositoryRequest[]
} {
  const calls: JobRepositoryRequest[] = []
  return {
    calls,
    channel: {
      callSapRepository: async (_connectionId, request) => {
        calls.push(request)
        return reply
      }
    }
  }
}

test("the create confirmation string is required and a job count cannot be smuggled into it", () => {
  const base = {
    connectionId: "w200",
    jobName: "ZJOB",
    steps: [{ programName: "RSPARAM" }],
    startTime: "2030-01-01T00:00:00"
  }
  assert.equal(
    createBackgroundJobSchema.safeParse({ ...base, confirmation: "CREATE_BACKGROUND_JOB" }).success,
    true
  )
  assert.equal(createBackgroundJobSchema.safeParse(base).success, false)
  for (const confirmation of [
    "create_background_job",
    "MODIFY_BACKGROUND_JOB",
    "RELEASE_BACKGROUND_JOB"
  ])
    assert.equal(
      createBackgroundJobSchema.safeParse({ ...base, confirmation }).success,
      false,
      confirmation
    )
  // The job count is assigned by SAP, so a caller that supplies one is refused rather than ignored -
  // a create must not be able to name the identity of the job it is about to make.
  assert.equal(
    createBackgroundJobSchema.safeParse({
      ...base,
      confirmation: "CREATE_BACKGROUND_JOB",
      jobCount: "00000001"
    }).success,
    false
  )
  // The same for the fields SAP owns: a caller cannot set a status or a step property.
  for (const injected of [{ status: "P" }, { newFlag: "X" }, { variant: "V1" }])
    assert.equal(
      createBackgroundJobSchema.safeParse({
        ...base,
        confirmation: "CREATE_BACKGROUND_JOB",
        ...injected
      }).success,
      false,
      JSON.stringify(injected)
    )
})

test("a create refuses a bad schedule, user or step before SAP is contacted", async () => {
  const base: CreateBackgroundJobInput = {
    connectionId: "w200",
    jobName: "ZJOB",
    steps: [{ programName: "RSPARAM" }],
    startTime: "2030-01-01T00:00:00",
    confirmation: "CREATE_BACKGROUND_JOB"
  }
  const refused: CreateBackgroundJobInput[] = [
    { ...base, startTime: "2030-01-01 00:00:00" },
    { ...base, startTime: "2030-13-01T00:00:00" },
    { ...base, jobName: "Z JOB" },
    { ...base, targetUser: "BATCH USER" },
    { ...base, steps: [{ programName: "RSPARAM", variantName: "V 1" }] },
    { ...base, steps: Array.from({ length: 21 }, () => ({ programName: "RSPARAM" })) }
  ]
  for (const input of refused) {
    const { channel, calls } = recordingChannel({
      status: "S",
      code: "JOB_CREATED",
      message: "Job created and read back"
    })
    let refused = false
    try {
      await createBackgroundJob(channel, input)
    } catch {
      refused = true
    }
    assert.equal(refused, true, `expected a refusal for ${JSON.stringify(input)}`)
    assert.deepEqual(calls, [], `nothing may reach SAP for ${JSON.stringify(input)}`)
  }
})

test("the job payload is the KIND|INDEX|PROPERTY|VALUE shape the helper parses", () => {
  assert.deepEqual(
    jobSourceRows({
      targetUser: "BATCHUSER",
      startDate: "20300101",
      startTime: "000000",
      steps: [{ programName: "RSPARAM" }, { programName: "ZREPORT", variantName: "V1" }]
    }),
    [
      "H|1|TARGET_USER|BATCHUSER",
      "H|1|START_DATE|20300101",
      "H|1|START_TIME|000000",
      "S|1|PROGRAM|RSPARAM",
      "S|2|PROGRAM|ZREPORT",
      "S|2|VARIANT|V1"
    ]
  )
  // A step without a variant must not send a VARIANT row at all: an empty value would name a variant
  // called "" rather than no variant.
  assert.deepEqual(jobSourceRows({ steps: [{ programName: "RSPARAM" }] }), ["S|1|PROGRAM|RSPARAM"])
  // The separators are percent-escaped in the value, or the helper would split one fact into two.
  assert.equal(jobPayloadLine("H", 1, "TARGET_USER", "A|B%C"), "H|1|TARGET_USER|A%7CB%25C")
  // A payload that carries no fact at all is a caller mistake, not an empty table to send.
  assert.throws(() => jobSourceRows({}), /JOB_PAYLOAD_INVALID/)
})

test("a create dispatches JOB_CREATE with the normalised identity and schedule", async () => {
  const { channel, calls } = recordingChannel({
    status: "S",
    code: "JOB_CREATED",
    message: "Job created and read back",
    source: [
      "M|1|JOBNAME|ZJOB",
      "M|2|JOBCOUNT|0000000042",
      "M|3|STATUS|P",
      "M|4|STEP_COUNT|2",
      "M|5|TARGET_USER|BATCHUSER"
    ]
  })
  const text = await createBackgroundJob(channel, {
    connectionId: "W200",
    jobName: " zjob ",
    steps: [{ programName: "rsparam" }, { programName: "zreport", variantName: "v1" }],
    startTime: "2030-01-01T00:00:00",
    targetUser: "batchuser",
    confirmation: "CREATE_BACKGROUND_JOB"
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    operation: "JOB_CREATE",
    jobName: "ZJOB",
    source: [
      "H|1|TARGET_USER|BATCHUSER",
      "H|1|START_DATE|20300101",
      "H|1|START_TIME|000000",
      "S|1|PROGRAM|RSPARAM",
      "S|2|PROGRAM|ZREPORT",
      "S|2|VARIANT|V1"
    ]
  })
  // The connection id is normalised the way every other write normalises it.
  assert.ok(text.includes('"action": "create"'))
  assert.ok(text.includes("0000000042"))
})

test("a successful create reports the identity SAP assigned, and refuses a blank one", () => {
  const ok = jobCreateResult("w200", {
    status: "S",
    code: "JOB_CREATED",
    message: "Job created and read back",
    metadata: {
      JOBNAME: "ZJOB",
      JOBCOUNT: "0000000042",
      STATUS: "P",
      STEP_COUNT: "2",
      TARGET_USER: "BATCHUSER"
    }
  })
  assert.equal(ok.status, "ok")
  assert.equal(ok.action, "create")
  assert.equal(ok.jobCount, "0000000042")
  assert.equal(ok.jobStatus, "P")
  assert.equal(ok.stepCount, 2)
  assert.equal(ok.confirmation, JOB_CONFIRMATIONS.create)
  assert.equal(ok.readOnly, false)
  assert.equal(ok.readBack.performed, true)
  assert.equal(ok.readBack.jobExists, true)
  assert.equal(ok.readBack.jobStatusAfter, "P")

  // A success with no job count is unusable: the caller could never release, modify or cancel what it
  // was told it had created.
  assert.throws(
    () =>
      jobCreateResult("w200", {
        status: "S",
        code: "JOB_CREATED",
        message: "ok",
        metadata: { JOBNAME: "ZJOB", STATUS: "P" }
      }),
    /JOB_RESPONSE_INVALID/
  )
  // And a success with no status is not evidence that anything was created.
  assert.throws(
    () =>
      jobCreateResult("w200", {
        status: "S",
        code: "JOB_CREATED",
        message: "ok",
        metadata: { JOBNAME: "ZJOB", JOBCOUNT: "0000000042" }
      }),
    /JOB_RESPONSE_INVALID/
  )
})

test("a failed create carries the helper's code and claims no read-back", () => {
  for (const code of [
    "JOB_DUPLICATE",
    "JOB_CREATE_FAILED",
    "JOB_STEP_INVALID",
    "JOB_NO_AUTHORITY"
  ]) {
    const failed = jobCreateResult("w200", {
      status: "E",
      code,
      message: "refused",
      metadata: { JOBNAME: "ZJOB" }
    })
    assert.equal(failed.status, "failed", code)
    assert.equal(failed.code, code)
    assert.equal(failed.readBack.performed, false)
    assert.equal(failed.readBack.jobExists, null)
    assert.equal(failed.readBack.jobStatusAfter, null)
  }
})

test("modify refuses a mixed or empty action before SAP is contacted", async () => {
  const base = {
    connectionId: "w200",
    jobName: "ZJOB",
    jobCount: "00000042",
    confirmation: "MODIFY_BACKGROUND_JOB" as const
  }
  const refused: ModifyBackgroundJobInput[] = [
    // A header change with no header field names nothing to change.
    { ...base, action: "header" },
    // A header change that also carries steps is two operations in one call.
    { ...base, action: "header", steps: [{ programName: "RSPARAM" }] },
    // A step change with an empty list has nothing to replace.
    { ...base, action: "steps", steps: [] },
    { ...base, action: "steps" },
    // A step change that also carries a header field belongs to the other arm.
    { ...base, action: "steps", startTime: "2030-01-01T00:00:00" },
    { ...base, action: "steps", targetUser: "BATCHUSER" }
  ]
  for (const input of refused) {
    // The schema refuses it as well, so a caller is stopped even before the service runs.
    assert.equal(
      modifyBackgroundJobSchema.safeParse(input).success,
      false,
      `schema must refuse ${JSON.stringify(input)}`
    )
    const { channel, calls } = recordingChannel({
      status: "S",
      code: "JOB_MODIFIED",
      message: "Job modified and read back"
    })
    let refusedByService = false
    try {
      await modifyBackgroundJob(channel, input)
    } catch {
      refusedByService = true
    }
    assert.equal(refusedByService, true, `expected a refusal for ${JSON.stringify(input)}`)
    assert.deepEqual(calls, [], `nothing may reach SAP for ${JSON.stringify(input)}`)
  }
  // The rule is stated once and used by both layers, so it cannot drift.
  assert.equal(jobModifyProblem({ action: "header", targetUser: "BATCHUSER" }), null)
  assert.equal(jobModifyProblem({ action: "steps", steps: [{ programName: "RSPARAM" }] }), null)
  assert.equal(jobModifyProblem({ action: "header" }), "JOB_PAYLOAD_INVALID")
  assert.equal(jobModifyProblem({ action: "steps" }), "JOB_STEP_REQUIRED")
})

test("a header modify dispatches JOB_MODIFY_HEADER with header rows only", async () => {
  const { channel, calls } = recordingChannel({
    status: "S",
    code: "JOB_MODIFIED",
    message: "Job modified and read back",
    source: [
      "M|1|JOBNAME|ZJOB",
      "M|2|JOBCOUNT|00000042",
      "M|3|STATUS|P",
      "M|4|TARGET_USER|BATCHUSER",
      "M|5|START_DATE|20300601",
      "M|6|START_TIME|040506"
    ]
  })
  await modifyBackgroundJob(channel, {
    connectionId: "w200",
    jobName: "zjob",
    jobCount: "00000042",
    action: "header",
    startTime: "2030-06-01T04:05:06",
    targetUser: "batchuser",
    confirmation: "MODIFY_BACKGROUND_JOB"
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    operation: "JOB_MODIFY_HEADER",
    jobName: "ZJOB",
    jobCount: "00000042",
    source: ["H|1|TARGET_USER|BATCHUSER", "H|1|START_DATE|20300601", "H|1|START_TIME|040506"]
  })
})

test("a step modify dispatches JOB_MODIFY_STEP with step rows only", async () => {
  const { channel, calls } = recordingChannel({
    status: "S",
    code: "JOB_MODIFIED",
    message: "Job modified and read back",
    source: ["M|1|JOBNAME|ZJOB", "M|2|JOBCOUNT|00000042", "M|3|STATUS|P", "M|4|STEP_COUNT|1"]
  })
  await modifyBackgroundJob(channel, {
    connectionId: "w200",
    jobName: "zjob",
    jobCount: "00000042",
    action: "steps",
    steps: [{ programName: "rsparam", variantName: "v1" }],
    confirmation: "MODIFY_BACKGROUND_JOB"
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    operation: "JOB_MODIFY_STEP",
    jobName: "ZJOB",
    jobCount: "00000042",
    source: ["S|1|PROGRAM|RSPARAM", "S|1|VARIANT|V1"]
  })
})

test("a successful modify reports SAP's own read-back and never echoes the request", () => {
  const ok = jobModifyResult("w200", {
    status: "S",
    code: "JOB_MODIFIED",
    message: "Job modified and read back",
    metadata: {
      JOBNAME: "ZJOB",
      JOBCOUNT: "00000042",
      STATUS: "P",
      TARGET_USER: "BATCHUSER",
      START_DATE: "20300601",
      START_TIME: "040506"
    }
  })
  assert.equal(ok.status, "ok")
  assert.equal(ok.action, "modify")
  assert.equal(ok.jobStatus, "P")
  assert.equal(ok.confirmation, JOB_CONFIRMATIONS.modify)
  assert.equal(ok.readOnly, false)
  assert.equal(ok.readBack.performed, true)
  assert.equal(ok.readBack.jobExists, true)
  assert.ok(ok.warnings.some((warning) => warning.includes("20300601040506")))
  assert.ok(ok.warnings.some((warning) => warning.includes("BATCHUSER")))
  // A modify never starts the job: saying so is what keeps the tool from being read as a release.
  assert.ok(ok.warnings.some((warning) => warning.includes("never releases it")))

  // A modify whose reply carries no status proves nothing about the job it claims to have changed.
  assert.throws(
    () =>
      jobModifyResult("w200", {
        status: "S",
        code: "JOB_MODIFIED",
        message: "ok",
        metadata: { JOBNAME: "ZJOB", JOBCOUNT: "00000042" }
      }),
    /JOB_RESPONSE_INVALID/
  )
  // A refusal keeps the helper's code and claims no read-back.
  const failed = jobModifyResult("w200", {
    status: "E",
    code: "JOB_NOT_MODIFIABLE",
    message: "Job is not scheduled",
    metadata: { JOBNAME: "ZJOB", JOBCOUNT: "00000042" }
  })
  assert.equal(failed.status, "failed")
  assert.equal(failed.code, "JOB_NOT_MODIFIABLE")
  assert.equal(failed.readBack.performed, false)
  assert.equal(failed.readBack.jobExists, null)
})

test("the create and modify arms' codes are contracted, including their success codes", () => {
  for (const code of [
    "JOB_PAYLOAD_INVALID",
    "JOB_CREATE_FAILED",
    "JOB_CREATED",
    "JOB_MODIFIED",
    "JOB_DUPLICATE",
    "JOB_NOT_MODIFIABLE",
    "JOB_STATUS_UNCHANGED",
    "JOB_DERELEASE_FAILED"
  ])
    assert.equal(jobControlCode(code), code)
  // A success code that is missing from the whitelist would turn a real success into
  // JOB_CONTROL_FAILED, so both new success codes are named explicitly here.
  assert.ok(JOB_CONTROL_CODES.includes("JOB_CREATED"))
  assert.ok(JOB_CONTROL_CODES.includes("JOB_MODIFIED"))
  assert.ok(JOB_CONTROL_CODES.includes("JOB_PAYLOAD_INVALID"))
  assert.ok(JOB_CONTROL_CODES.includes("JOB_CREATE_FAILED"))
  // The de-release correction's failure code has to be contracted too, or the one reply that
  // describes a job left released against the tool's contract would arrive as JOB_CONTROL_FAILED.
  assert.ok(JOB_CONTROL_CODES.includes("JOB_DERELEASE_FAILED"))
  // An arm that invents a code still reaches the caller as the contracted failure.
  assert.equal(jobControlCode("JOB_CREATE_EXPLODED"), "JOB_CONTROL_FAILED")
})

test("a de-release refusal is reported as its own failure, not as an unchanged modify", () => {
  // The distinction matters: the requested change did land in this case, so reporting
  // JOB_STATUS_UNCHANGED would tell the caller the opposite of what happened.
  const failed = jobModifyResult("w200", {
    status: "E",
    code: "JOB_DERELEASE_FAILED",
    message: "The job is still released after the change; status S",
    metadata: { JOBNAME: "ZJOB", JOBCOUNT: "00000042", STATUS: "S" }
  })
  assert.equal(failed.status, "failed")
  assert.equal(failed.code, "JOB_DERELEASE_FAILED")
  assert.equal(failed.readBack.performed, false)
  assert.notEqual(failed.code, "JOB_STATUS_UNCHANGED")
})

test("the two new arms pin the helper version that carries them", () => {
  // The version pin is the point of the two registry entries: a helper that carries JOB_RELEASE and
  // JOB_CANCEL (2.13/2.14) does not carry these arms, and the capability report decides availability
  // from the registry, so a wrong or missing pin would advertise a tool the deployed body cannot
  // serve. Both are writes on the shared repository body, like the release and cancel pair.
  const create = TOOL_REGISTRY.find((entry) => entry.name === "create_background_job")
  assert.ok(create, "create_background_job must be registered")
  assert.equal(create.group, "ops")
  assert.equal(create.route, "sap-helper-fallback")
  assert.equal(create.sapHelper, "Z_ORVANTA_MCP_DYNPRO_API")
  assert.equal(create.minHelperProtocol, "2.19")
  assert.deepEqual(create.requiredHelperOperations, ["JOB_CREATE"])
  assert.equal(create.annotations.readOnlyHint, false)

  const modify = TOOL_REGISTRY.find((entry) => entry.name === "modify_background_job")
  assert.ok(modify, "modify_background_job must be registered")
  assert.equal(modify.group, "ops")
  assert.equal(modify.route, "sap-helper-fallback")
  assert.equal(modify.sapHelper, "Z_ORVANTA_MCP_DYNPRO_API")
  // The higher of the two arms, because one deployed helper body serves both.
  assert.equal(modify.minHelperProtocol, "2.21")
  assert.deepEqual(modify.requiredHelperOperations, ["JOB_MODIFY_HEADER", "JOB_MODIFY_STEP"])
  assert.equal(modify.annotations.readOnlyHint, false)

  // The opcodes the two tools can send are exactly the three arms those entries name.
  assert.deepEqual(
    [...JOB_REPOSITORY_OPERATIONS],
    ["JOB_CREATE", "JOB_MODIFY_HEADER", "JOB_MODIFY_STEP"]
  )
})
