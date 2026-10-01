import { createHash } from "node:crypto"
import type { SapBackend, SapDdicOperation } from "./backend.js"
import type { MaintenanceDiagnosticService } from "./maintenance-diagnostics.js"
import { createReviewedTableReader, type ReviewedReaderSource } from "./reviewed-table-reader.js"
import type { ToolService } from "./tools.js"
import { hashWriteInput, type SapPreChangeEvidence } from "./write-operation-receipts.js"
import { SmartformService } from "./smartforms.js"
import { transportEntries, transportFingerprint } from "./transport-delivery.js"

type EvidenceDraft = Omit<SapPreChangeEvidence, "observedAt" | "observationStatus">

export async function observeWritePreChange(
  name: string,
  input: Record<string, unknown>,
  connectionId: string,
  targetSummary: string,
  backend: SapBackend,
  tools: ToolService,
  maintenance?: MaintenanceDiagnosticService
): Promise<SapPreChangeEvidence> {
  const evidence: EvidenceDraft = {
    target: targetSummary,
    exists: null,
    active: null,
    version: null,
    fingerprint: null,
    packageName: null,
    requestNumber: null,
    taskNumber: null,
    sources: [],
    warnings: []
  }

  if (name === "cleanup_transport_entries") {
    const parentTransportNumber = String(input.parentTransportNumber).toUpperCase()
    const taskNumber = String(input.taskNumber).toUpperCase()
    const request = await backend.transportDetails(connectionId, parentTransportNumber)
    if (request["tm:number"].toUpperCase() !== parentTransportNumber) {
      throw new Error("CTS_CLEANUP_PARENT_MISMATCH")
    }
    const task = request.tasks.find(
      (candidate) => candidate["tm:number"].toUpperCase() === taskNumber
    )
    evidence.sources.push("transport_details")
    evidence.exists = Boolean(task)
    evidence.active = null
    evidence.version = task?.["tm:status"] ?? request["tm:status"]
    evidence.fingerprint = transportFingerprint(request)
    evidence.requestNumber = parentTransportNumber
    evidence.taskNumber = taskNumber
    if (evidence.fingerprint !== String(input.expectedFingerprint).toLowerCase()) {
      throw new Error("CTS_CLEANUP_STALE_FINGERPRINT")
    }
  } else if (name === "create_transport_request") {
    await observeTransportRequestCreate(evidence, backend, connectionId, input, tools)
  } else if (name === "add_objects_to_transport") {
    await observeTransportObjectAdd(evidence, backend, connectionId, input)
  } else if (["create_smartform", "save_smartform", "activate_smartform"].includes(name)) {
    try {
      const result = await new SmartformService(backend).read({
        connectionId,
        formName: String(input.formName),
        language: String(input.language),
        version: "saved"
      })
      evidence.exists = true
      evidence.active = result.active
      evidence.fingerprint = result.fingerprint
      evidence.packageName = result.packageName
      evidence.requestNumber = result.requestNumber
      evidence.sources.push("smartform_repository_snapshot")
      if (name === "create_smartform") throw new Error("SMARTFORM_ALREADY_EXISTS")
      if (result.fingerprint !== input.expectedFingerprint)
        throw new Error("SMARTFORM_STALE_FINGERPRINT")
      if (result.packageName !== input.packageName) throw new Error("SMARTFORM_PACKAGE_MISMATCH")
    } catch (error) {
      if (
        name === "create_smartform" &&
        error instanceof Error &&
        error.message === "SMARTFORM_NOT_FOUND: Smart Form does not exist"
      ) {
        evidence.exists = false
        evidence.sources.push("smartform_explicit_not_found")
      } else {
        throw error
      }
    }
  } else if (
    name === "create_enhancement_hook_implementation" ||
    name === "create_new_badi_implementation" ||
    name === "update_enhancement_hook_implementation" ||
    name === "update_new_badi_implementation" ||
    name === "manage_enhancement_implementation_state" ||
    name === "delete_enhancement_implementation"
  ) {
    const enhancementName = String(input.enhancementName)
    try {
      const value = parseJson(
        await tools.readEnhancementImplementation({ enhancementName, connectionId })
      )
      evidence.sources.push("read_enhancement_implementation")
      evidence.exists = true
      evidence.active = booleanValue(
        (value.definition as Record<string, unknown> | undefined)?.active
      )
      evidence.fingerprint = stringValue(value.fingerprint)
      evidence.packageName = stringValue(value.packageName)
      if (
        name === "create_enhancement_hook_implementation" ||
        name === "create_new_badi_implementation"
      ) {
        throw new Error("ENHANCEMENT_IMPLEMENTATION_ALREADY_EXISTS")
      }
      if (evidence.fingerprint !== String(input.expectedFingerprint).toLowerCase()) {
        throw new Error("ENHANCEMENT_IMPLEMENTATION_STALE_FINGERPRINT")
      }
      if (evidence.packageName?.toUpperCase() !== String(input.packageName).toUpperCase()) {
        throw new Error("ENHANCEMENT_IMPLEMENTATION_PACKAGE_MISMATCH")
      }
    } catch (error) {
      if (
        (name === "create_enhancement_hook_implementation" ||
          name === "create_new_badi_implementation") &&
        /ENHANCEMENT_IMPLEMENTATION_NOT_FOUND/.test(String(error))
      ) {
        evidence.sources.push("enhancement_implementation_explicit_not_found")
        evidence.exists = false
      } else {
        throw error
      }
    }
  } else if (name === "manage_classic_badi_implementation") {
    const definitionName = String(input.definitionName ?? "")
    if (!definitionName) throw new Error("Classic BAdI definitionName is required")
    const value = parseJson(await tools.readClassicBadiDefinition({ definitionName, connectionId }))
    const snapshot = classicBadiSnapshot(value, String(input.implementationName).toUpperCase())
    evidence.sources.push("read_classic_badi_definition")
    evidence.exists = snapshot !== undefined
    if (snapshot) {
      evidence.active = snapshot.active
      evidence.fingerprint = createHash("sha256")
        .update(JSON.stringify(snapshot.value))
        .digest("hex")
      evidence.packageName = snapshot.packageName
    }
    if (String(input.action) === "create") {
      if (snapshot) throw new Error("CLASSIC_BADI_IMPLEMENTATION_ALREADY_EXISTS")
    } else {
      if (!snapshot) throw new Error("CLASSIC_BADI_IMPLEMENTATION_NOT_FOUND")
      if (evidence.fingerprint !== String(input.expectedFingerprint).toLowerCase()) {
        throw new Error("CLASSIC_BADI_IMPLEMENTATION_STALE_FINGERPRINT")
      }
      if (evidence.packageName?.toUpperCase() !== String(input.packageName).toUpperCase()) {
        throw new Error("CLASSIC_BADI_IMPLEMENTATION_PACKAGE_MISMATCH")
      }
    }
  } else if (name === "upsert_abap_screen" || name === "patch_abap_screen") {
    await observeJson(
      evidence,
      "read_abap_screen",
      () =>
        tools.readAbapScreen({
          programName: String(input.programName),
          screenNumber: String(input.screenNumber),
          connectionId
        }),
      (value) => {
        evidence.exists = true
        evidence.active = true
        evidence.fingerprint = stringValue(value.fingerprint)
      }
    )
    await observeAssignment(evidence, tools, connectionId, "PROG/P", input.programName, false)
  } else if (name === "patch_abap_gui_definition") {
    await observeJson(
      evidence,
      "read_abap_gui_definition",
      () =>
        tools.readAbapGuiDefinition({
          programName: String(input.programName),
          connectionId
        }),
      (value) => {
        evidence.exists = true
        evidence.active = true
        evidence.version = stringValue(value.versionToken)
        evidence.fingerprint = stringValue(value.fingerprint)
      }
    )
    await observeAssignment(evidence, tools, connectionId, "PROG/P", input.programName, false)
  } else if (name === "create_module_pool" || name === "delete_module_pool") {
    await observeAssignment(evidence, tools, connectionId, "PROG/P", input.programName, true)
  } else if (
    name === "create_transaction_code" ||
    name === "delete_transaction_code" ||
    name === "create_report_transaction"
  ) {
    await observeJson(
      evidence,
      "read_transaction_code",
      () =>
        tools.readTransactionCode({
          transactionCode: String(input.transactionCode),
          connectionId
        }),
      (value) => {
        const transactions = Array.isArray(value.transactions) ? value.transactions : []
        evidence.exists = transactions.length > 0
        evidence.active = evidence.exists ? true : null
        evidence.fingerprint = hashWriteInput({
          transactions: value.transactions,
          guiAttributes: value.guiAttributes
        })
      }
    )
    await observeAssignment(evidence, tools, connectionId, "TRAN", input.transactionCode, false)
  } else if (
    name === "create_function_module_with_interface" ||
    name === "patch_function_module_interface" ||
    name === "write_function_module_source" ||
    name === "test_remote_function_module" ||
    name === "invoke_customer_function_module"
  ) {
    await observeJson(
      evidence,
      "read_function_module_interface",
      () =>
        tools.readFunctionModuleInterface({
          functionName: String(input.functionName),
          connectionId
        }),
      (value) => {
        evidence.exists = true
        evidence.active = true
        // `fingerprint` keeps its historical value, the interface fingerprint the write guard
        // compares against. The two fields below carry the read tool's own names and meanings, so a
        // receipt reader no longer has to guess which of the three hashes a generic name holds.
        evidence.fingerprint = stringValue(value.interfaceFingerprint ?? value.fingerprint)
        evidence.interfaceFingerprint = stringValue(value.interfaceFingerprint)
        evidence.definitionFingerprint = stringValue(value.fingerprint)
      }
    )
    await observeAssignment(evidence, tools, connectionId, "FUGR/FF", input.functionName, true)
    if (evidence.exists === false && input.functionGroup) {
      await observeAssignment(evidence, tools, connectionId, "FUGR/F", input.functionGroup, false)
    }
  } else if (
    name === "create_abap_message_class" ||
    name === "update_abap_message_class" ||
    name === "delete_abap_message_class"
  ) {
    await observeJson(
      evidence,
      "read_abap_message_class",
      () =>
        tools.readAbapMessageClass({
          messageClass: String(input.messageClass),
          connectionId
        }),
      (value) => {
        evidence.exists = true
        evidence.active = true
        evidence.version = stringValue(value.version)
        evidence.fingerprint = stringValue(value.fingerprint)
        evidence.packageName = stringValue(value.packageName)
      }
    )
  } else if (
    name === "append_ddic_transparent_table_fields" ||
    name === "patch_ddic_transparent_table_fields" ||
    name === "patch_ddic_transparent_table_settings" ||
    // Resuming an activation must observe the same DDIC definition the write will activate. Without
    // this branch it fell through to the generic ADT source observation, which reported
    // exists=false for a table that only exists as an inactive definition (2026-09-22 10:56
    // incident) and contradicted the dedicated DDIC read the tool had already performed.
    name === "resume_ddic_table_activation"
  ) {
    await observeJson(
      evidence,
      "read_ddic_transparent_table",
      () =>
        tools.readDdicTransparentTable({
          objectName: String(input.objectName),
          connectionId
        }),
      (value) => {
        // A missing object now arrives as a parsed result instead of a thrown error, so this callback
        // has to read the verdict itself. Treating every parsed payload as existence would undo the
        // 2026-09-22 10:56 correction that reports a saved-but-not-activated definition as inactive.
        if (value.exists === false) {
          evidence.exists = false
          return
        }
        evidence.exists = true
        const status = String(value.status ?? "").toLowerCase()
        // A saved-but-not-activated definition is readable and must be reported as inactive, not as
        // an active table.
        evidence.active = typeof value.active === "boolean" ? value.active : status !== "inactive"
        evidence.version = stringValue(value.version)
        evidence.fingerprint = stringValue(value.fingerprint)
        evidence.packageName = stringValue(value.packageName)
      }
    )
  } else if (name === "recover_ddic_table_conversion") {
    await observeJson(
      evidence,
      "read_ddic_table_conversion_status",
      () =>
        tools.readDdicTableConversionStatus({
          objectName: String(input.objectName),
          connectionId
        }),
      (value) => {
        evidence.exists = booleanValue(value.pending)
        evidence.active = null
        evidence.version = null
        evidence.fingerprint = stringValue(value.worklistFingerprint)
        evidence.packageName = stringValue(input.packageName)
      }
    )
  } else if (name === "delete_ddic_object") {
    // Every deletion is preceded by the read operation of the *same* DDIC object kind, so the
    // receipt proves what was removed. A kind missing here does not degrade to a weaker
    // observation: it throws before SAP is touched, which is how `objectType: "ENQU"` was
    // unreachable even though the registry, the contract and the helper all supported it, and how
    // `objectType: "VIEW"` stayed unreachable after the 1.11 maintenance-view delete was added.
    const operation = {
      DOMA: "READ_DOMAIN",
      DTEL: "READ_DATA_ELEMENT",
      STRU: "READ_STRUCTURE",
      TABL: "READ_TRANSPARENT_TABLE",
      TTYP: "READ_TABLE_TYPE",
      SHLP: "READ_SEARCH_HELP",
      ENQU: "READ_LOCK_OBJECT",
      NROB: "READ_NUMBER_RANGE_OBJECT",
      VIEW: "READ_MAINTENANCE_VIEW"
    }[String(input.objectType).toUpperCase()] as SapDdicOperation | undefined
    if (!operation) throw new Error(`Unsupported DDIC deletion type: ${String(input.objectType)}`)
    await observeDdic(evidence, backend, connectionId, String(input.objectName), operation)
  } else if (DDIC_READ_OPERATION[name]) {
    await observeDdic(
      evidence,
      backend,
      connectionId,
      String(input.objectName),
      DDIC_READ_OPERATION[name]
    )
  } else if (name === "delete_sap_lock") {
    // One SM12 lock entry is the target, and it is not a repository object: the generic source
    // observation below looked the empty ADT URI up and refused every release with "ADT target "
    // (2026-09-28, before the identity and this branch existed). The same SM12 search a caller uses to
    // obtain the key is the authoritative pre-change read, so the receipt records the exact row,
    // including the instance markers that separate two locks sharing one key. A key with no matching
    // row is recorded as absent rather than as a blocker: the helper re-reads the lock table itself and
    // answers LOCK_NOT_FOUND, which is its documented contract, and no entry is released.
    if (!maintenance) throw new Error("SM12 lock observation requires the maintenance reader")
    const lockReport = parseJson(
      await maintenance.searchLocks({
        connectionId,
        username: String(input.username),
        tableName: String(input.tableName),
        argument: String(input.argument),
        lockObject: input.lockObject === undefined ? undefined : String(input.lockObject)
      })
    )
    const lockRows = Array.isArray(lockReport.entries) ? lockReport.entries : []
    const lockOwner = String(input.username).toUpperCase()
    const lockTable = String(input.tableName).toUpperCase()
    const lockArgument = String(input.argument)
    const lockMode = String(input.mode).toUpperCase()
    const lockObject =
      input.lockObject === undefined ? null : String(input.lockObject).toUpperCase()
    const observedLock = lockRows.find((row) => {
      const candidate = (row ?? {}) as Record<string, unknown>
      return (
        String(candidate.username).toUpperCase() === lockOwner &&
        String(candidate.tableName).toUpperCase() === lockTable &&
        String(candidate.argument) === lockArgument &&
        String(candidate.mode).toUpperCase() === lockMode &&
        (lockObject === null || String(candidate.lockObject).toUpperCase() === lockObject)
      )
    })
    evidence.sources.push("maintenance_lock_search")
    evidence.exists = observedLock !== undefined
    evidence.active = null
    evidence.version = null
    evidence.fingerprint =
      observedLock === undefined ? null : hashWriteInput(JSON.stringify(observedLock))
    if (observedLock === undefined)
      evidence.warnings.push(
        "no SM12 row matched this exact key in the current client; the helper re-reads the lock table and answers LOCK_NOT_FOUND instead of releasing an entry it did not read"
      )
  } else if (name === "release_transport_task") {
    // A CTS request is not a repository object either, and it has no ADT URI: the generic source
    // observation below would look up an empty URI and refuse the release before SAP is contacted,
    // exactly as it did for the lock release. The transport organizer read is the authoritative
    // pre-change read, so the receipt records the request's observed status plus its task and object
    // inventory - the release carries the tasks with it, so what lives in a task is part of what is
    // about to be exported. A request the read cannot find is recorded as absent rather than as a
    // blocker: the helper re-reads E070 itself and answers TRANSPORT_NOT_FOUND, which is its
    // documented contract, and nothing is exported.
    try {
      const request = await backend.transportDetails(
        connectionId,
        String(input.transportNumber).toUpperCase()
      )
      evidence.sources.push("transport_details")
      const number = String(request["tm:number"] ?? "")
        .trim()
        .toUpperCase()
      evidence.exists = number === String(input.transportNumber).toUpperCase()
      evidence.active = null
      evidence.version = stringValue(request["tm:status"])
      evidence.fingerprint = transportFingerprint(request)
      evidence.requestNumber = number === "" ? null : number
      const entries = transportEntries(request)
      evidence.warnings.push(
        `the release carries ${request.tasks.length} task(s) and ${entries.length} object entr(ies); releasing the request releases its tasks`
      )
    } catch (error) {
      if (isMissing(error)) {
        evidence.sources.push("transport_details")
        evidence.exists = false
        evidence.warnings.push(
          "no transport matched this exact number in the current client; the helper re-reads E070 and answers TRANSPORT_NOT_FOUND instead of releasing a request it did not read"
        )
      } else {
        recordObservationError(evidence, "transport_details", error)
      }
    }
  } else if (name === "create_background_job") {
    // Create has no pre-existing row, so there is nothing of its own to snapshot: the write is what
    // brings the job into being. What can be established beforehand is what the *name* currently
    // resolves to, and that is worth recording because the helper refuses a name a pending or running
    // job still holds (JOB_DUPLICATE) - so a name that is already taken is the one pre-change fact
    // this tool has. `exists` is false either way: no job exists at the identity being written, which
    // is exactly what "no target object was snapshotted" means for a create (same shape as
    // run_abap_program below), and the gate must not read it as "the job is gone".
    const createdJobName = String(input.jobName).toUpperCase()
    const createSources: ReviewedReaderSource[] = []
    const readExistingJobNames = createReviewedTableReader(
      backend,
      connectionId,
      async () =>
        JSON.parse(
          await tools.readFunctionModuleInterface({
            connectionId,
            functionName: "RFC_READ_TABLE"
          })
        ),
      createSources,
      evidence.warnings
    )
    const nameRows = await readExistingJobNames({
      table: "TBTCO",
      fields: ["JOBNAME", "JOBCOUNT", "STATUS", "SDLSTRTDT", "SDLSTRTTM", "SDLUNAME"],
      filters: { JOBNAME: createdJobName },
      maximum: 1,
      codePrefix: "JOB_OBSERVATION_",
      mapError: () => "JOB_OBSERVATION_FAILED"
    })
    evidence.sources.push("tbtco")
    evidence.active = null
    evidence.version = null
    evidence.fingerprint = null
    evidence.exists = false
    const heldBy = (nameRows ?? [])[0]
    if (heldBy !== undefined) {
      evidence.warnings.push(
        `the name ${createdJobName} is already held by job ${stringValue(heldBy.JOBCOUNT)} with status ${stringValue(heldBy.STATUS)}; the helper refuses a duplicate name while a pending or running job holds it and answers JOB_DUPLICATE, so this create either adds a differently numbered job or is refused`
      )
    } else if (createSources[0]?.status === "empty") {
      evidence.warnings.push(
        `no TBTCO row carries the job name ${createdJobName} in the current client; the create is expected to add one, so there is no pre-existing row to snapshot`
      )
    } else {
      evidence.warnings.push(
        `whether the job name ${createdJobName} is already taken could not be read (${createSources[0]?.code ?? "JOB_OBSERVATION_FAILED"}); the helper re-reads TBTCO name by name and answers JOB_DUPLICATE rather than creating a second job under a held name`
      )
    }
  } else if (
    name === "release_background_job" ||
    name === "cancel_background_job" ||
    name === "modify_background_job"
  ) {
    // A background job is a TBTCO row, so like a lock entry or a CTS request it is not a repository
    // object and it has no ADT URI: the generic source observation below looked up an empty URI and
    // refused every attempt before SAP was contacted, which is what both tools did until this branch
    // existed (2026-09-30: `source: observation failed (92234395...)`, identical for both tools and
    // unchanged across an instance restart). The job's own row is the authoritative pre-change read,
    // because its STATUS is the field the write is about to change.
    //
    // The row is read through the shared reviewed table reader rather than through the SM37 job
    // tools, and that is deliberate. The helper's job-details branch aborts on a job whose SDLSTRTDT
    // is empty - `make_time` RETURNs out of the whole function module - and that is exactly the
    // "scheduled, never started" job a release exists for, so using it here would refuse every job
    // these two tools were built to move. The reader is fingerprint-gated and TBTCO is on the
    // deliverable allowlist with JOBNAME/JOBCOUNT as its key, so this is the same reviewed path the
    // read-only table tools use. A row that is not there is recorded as absent rather than as a
    // blocker: the helper re-reads the job header and answers JOB_NOT_FOUND, which is its documented
    // contract, and nothing is moved.
    const observedJobName = String(input.jobName).toUpperCase()
    const observedJobCount = String(input.jobCount)
    const jobSources: ReviewedReaderSource[] = []
    const readJobHeader = createReviewedTableReader(
      backend,
      connectionId,
      async () =>
        JSON.parse(
          await tools.readFunctionModuleInterface({
            connectionId,
            functionName: "RFC_READ_TABLE"
          })
        ),
      jobSources,
      evidence.warnings
    )
    const jobRows = await readJobHeader({
      table: "TBTCO",
      fields: [
        "JOBNAME",
        "JOBCOUNT",
        "STATUS",
        "SDLSTRTDT",
        "SDLSTRTTM",
        "SDLUNAME",
        "AUTHCKMAN",
        "LASTCHDATE",
        "LASTCHTIME"
      ],
      filters: { JOBNAME: observedJobName, JOBCOUNT: observedJobCount },
      maximum: 1,
      codePrefix: "JOB_OBSERVATION_",
      mapError: () => "JOB_OBSERVATION_FAILED"
    })
    evidence.sources.push("tbtco")
    const observedJob = (jobRows ?? [])[0]
    evidence.active = null
    evidence.version = observedJob === undefined ? null : stringValue(observedJob.STATUS)
    evidence.fingerprint =
      observedJob === undefined ? null : hashWriteInput(JSON.stringify(observedJob))
    if (observedJob !== undefined) {
      evidence.exists = true
    } else if (jobSources[0]?.status === "empty") {
      evidence.exists = false
      evidence.warnings.push(
        "no TBTCO row matched this exact job name and job count in the current client; the helper re-reads the job header and answers JOB_NOT_FOUND instead of moving a job it did not read"
      )
    } else {
      // The read itself failed rather than returning no row. That is not an established absence, so
      // `exists` stays null and the gate refuses the write instead of reporting the job as gone.
      evidence.warnings.push(
        `the TBTCO row could not be read (${jobSources[0]?.code ?? "JOB_OBSERVATION_FAILED"}); the job's current status is unknown, so nothing was moved`
      )
    }
  } else if (name === "run_abap_program") {
    // The target of this tool is whatever the program itself changes, and no read can bound that.
    // Treating the program object as the target would attach a green pre-change snapshot to a write
    // whose real effect is somewhere else, so the evidence records that it could not be established
    // and says why. `exists: false` means "no target object was snapshotted", which is exactly the
    // case here: the run itself is what changes SAP, not the program definition.
    evidence.sources.push("program-execution")
    evidence.exists = false
    evidence.warnings.push(
      "the program's own side effects cannot be observed before it runs; only the SUBMIT return code is reported afterwards"
    )
  } else {
    await observeSourceTarget(evidence, name, input, connectionId, backend)
    const assignment = sourceAssignment(name, input)
    if (assignment) {
      await observeAssignment(
        evidence,
        tools,
        connectionId,
        assignment.objectType,
        assignment.objectName,
        false
      )
    }
  }

  if (evidence.exists === null) {
    throw new Error(
      `SAP pre-change observation could not establish whether ${targetSummary} exists: ${evidence.warnings.join("; ") || "no readable SAP evidence"}`
    )
  }
  // A confirmed absence is a complete observation. Every absence the read established is exactly
  // that: the CTS dedupe scan found no matching request, and the lock and transport branches found no
  // matching row. Those branches also push the warning that explains the absence - the helper answers
  // LOCK_NOT_FOUND, the release carries its tasks - and requiring `warnings.length === 0` before the
  // `exists === false` arm could apply made an established absence read as partial, which is what
  // partial is not for.
  //
  // The program-execution branch is the one exception, and it is why the arm is not simply
  // `exists === false`: there `exists: false` means "no target object was snapshotted", not "the
  // target is absent". Nothing about the write's real effect was established, so a warning there
  // still has to leave the observation partial.
  const absenceEstablished =
    evidence.exists === false && !evidence.sources.includes("program-execution")
  const complete =
    absenceEstablished ||
    (evidence.warnings.length === 0 &&
      evidence.active !== null &&
      (evidence.version !== null || evidence.fingerprint !== null) &&
      evidence.packageName !== null)
  return {
    ...evidence,
    observedAt: new Date().toISOString(),
    observationStatus: complete ? "complete" : "partial"
  }
}

/**
 * The DDIC read operation that observes the object an upsert is about to write.
 *
 * A DDIC object kind omitted here does not fail loudly: the target falls through to the generic
 * source observation, which looks the name up as a program and therefore reports a lock object or
 * a search help as an absent repository object. The receipt then claims a creation where an update
 * happened. Every upsert that writes a distinct DDIC object kind belongs in this map.
 */
const DDIC_READ_OPERATION: Record<string, SapDdicOperation> = {
  upsert_ddic_domain: "READ_DOMAIN",
  upsert_ddic_data_element: "READ_DATA_ELEMENT",
  upsert_ddic_structure: "READ_STRUCTURE",
  create_ddic_transparent_table: "READ_TRANSPARENT_TABLE",
  upsert_ddic_table_type: "READ_TABLE_TYPE",
  upsert_search_help: "READ_SEARCH_HELP",
  upsert_lock_object: "READ_LOCK_OBJECT",
  upsert_number_range_object: "READ_NUMBER_RANGE_OBJECT",
  upsert_maintenance_view: "READ_MAINTENANCE_VIEW",
  // An append structure is read with the ordinary structure read, which already reports its
  // tableClass and, since the D6-5 read side, the base table it is attached to.
  upsert_append_structure_fields: "READ_STRUCTURE"
}

async function observeDdic(
  evidence: EvidenceDraft,
  backend: SapBackend,
  connectionId: string,
  objectName: string,
  operation: SapDdicOperation
): Promise<void> {
  try {
    const result = await backend.callSapDdic(connectionId, {
      operation,
      objectName: objectName.toUpperCase()
    })
    evidence.sources.push("sap_ddic_read")
    if (result.status.toUpperCase() !== "S") {
      if (isMissing(`${result.code} ${result.message}`)) {
        evidence.exists = false
        return
      }
      throw new Error(`${result.code}: ${result.message}`)
    }
    evidence.exists = true
    // A definition that only exists in its inactive (saved but not activated) version is still a
    // readable DDIC object, but it is not active. Reporting active=true here made the receipt of a
    // failed create claim an active table; the DDIC read marks the inactive version with
    // metadata INACTIVE = 'X'.
    evidence.active = String(result.metadata?.INACTIVE ?? "").toUpperCase() !== "X"
    evidence.version = result.objectVersion
    evidence.fingerprint = hashWriteInput({
      header: result.header,
      fixedValues: result.fixedValues,
      fields: result.fields
    })
    evidence.packageName = result.packageName
    evidence.requestNumber = result.recordedRequest
  } catch (error) {
    recordObservationError(evidence, "sap_ddic_read", error)
  }
}

async function observeAssignment(
  evidence: EvidenceDraft,
  tools: ToolService,
  connectionId: string,
  objectType: "CLAS/OC" | "INTF/OI" | "FUGR/F" | "FUGR/FF" | "PROG/P" | "PROG/I" | "TRAN",
  objectName: unknown,
  assignmentDefinesExistence: boolean
): Promise<void> {
  try {
    const value = parseJson(
      await tools.inspectRepositoryAssignment({
        objectName: String(objectName),
        objectType,
        connectionId
      })
    )
    evidence.sources.push("repository_assignment")
    if (assignmentDefinesExistence) evidence.exists = true
    // A create observes the enclosing function group to learn where the new object will land. That
    // group is active by definition, but this evidence describes the target, so reporting the
    // group's state as the target's claimed an active version for an object that does not exist yet
    // (observed live: exists false with active true in the same receipt).
    evidence.active = evidence.exists === false ? null : booleanValue(value.active)
    evidence.packageName = stringValue(value.packageName)
    evidence.requestNumber = stringValue(value.requestNumber)
    evidence.taskNumber = stringValue(value.taskNumber)
  } catch (error) {
    if (isMissing(error) && (assignmentDefinesExistence || evidence.exists !== true)) {
      evidence.sources.push("repository_assignment")
      if (evidence.exists === null) evidence.exists = false
      return
    }
    recordObservationError(evidence, "repository_assignment", error)
  }
}

async function observeJson(
  evidence: EvidenceDraft,
  source: string,
  read: () => Promise<string>,
  apply: (value: Record<string, unknown>) => void
): Promise<void> {
  try {
    apply(parseJson(await read()))
    evidence.sources.push(source)
  } catch (error) {
    if (isMissing(error)) {
      evidence.sources.push(source)
      evidence.exists = false
      return
    }
    recordObservationError(evidence, source, error)
  }
}

/**
 * A new CTS request has no source identity, so the generic ADT source observation threw
 * "write target has no readable source identity" and the tool aborted before SAP was contacted:
 * the observation gate, not the helper, is what made create_transport_request unreachable.
 *
 * The pre-change state that matters is the tool's own retry guard - a modifiable request with the
 * same owner, type and description. The request type selects the CTS category, which is how
 * listUserTransports already separates workbench (K) from customizing (W).
 */
async function observeTransportRequestCreate(
  evidence: EvidenceDraft,
  backend: SapBackend,
  connectionId: string,
  input: Record<string, unknown>,
  tools: ToolService
): Promise<void> {
  const source = "list_user_transports"
  try {
    const type = String(input.requestType ?? "")
      .trim()
      .toUpperCase()
    const description = String(input.description ?? "").trim()
    const owner = String(input.owner ?? backend.connectionDetails(connectionId).username ?? "")
      .trim()
      .toUpperCase()
    const transports = (await backend.listUserTransports(
      connectionId,
      owner,
      tools.readTransportTableRows.bind(tools)
    )) as unknown as Record<string, unknown>
    evidence.sources.push(source)
    const targets = transports[type === "W" ? "customizing" : "workbench"]
    const modifiable = Array.isArray(targets)
      ? (targets as Array<Record<string, unknown>>).flatMap((target) =>
          Array.isArray(target.modifiable)
            ? (target.modifiable as Array<Record<string, string>>)
            : []
        )
      : []
    const match = modifiable.find(
      (candidate) =>
        String(candidate["tm:owner"] ?? "")
          .trim()
          .toUpperCase() === owner && String(candidate["tm:desc"] ?? "").trim() === description
    )
    if (!match) {
      evidence.exists = false
      return
    }
    evidence.exists = true
    evidence.active = true
    evidence.version = stringValue(match["tm:number"])
    evidence.requestNumber = stringValue(match["tm:number"])
  } catch (error) {
    recordObservationError(evidence, source, error)
  }
}

/**
 * The write target is an entry inside an existing request, which likewise has no source identity.
 * The pre-change state is whether the exact CTS entries are already recorded: all of them present
 * means this call repeats an earlier one, any missing means there is work to do.
 */
async function observeTransportObjectAdd(
  evidence: EvidenceDraft,
  backend: SapBackend,
  connectionId: string,
  input: Record<string, unknown>
): Promise<void> {
  const source = "transport_details"
  try {
    const requestNumber = String(input.requestNumber ?? "")
      .trim()
      .toUpperCase()
    const objects = Array.isArray(input.objects)
      ? (input.objects as Array<Record<string, unknown>>)
      : []
    const request = await backend.transportDetails(connectionId, requestNumber)
    evidence.sources.push(source)
    evidence.requestNumber = requestNumber
    const recorded = new Set(
      transportEntries(request).map((entry) => ctsEntryKey(entry.pgmid, entry.type, entry.name))
    )
    const missing = objects.filter(
      (object) =>
        !recorded.has(
          ctsEntryKey(
            String(object.pgmid ?? ""),
            String(object.object ?? ""),
            String(object.objName ?? "")
          )
        )
    )
    evidence.exists = missing.length === 0
    evidence.version = stringValue(request["tm:status"])
    evidence.fingerprint = transportFingerprint(request)
    if (evidence.exists) evidence.active = true
  } catch (error) {
    recordObservationError(evidence, source, error)
  }
}

function ctsEntryKey(pgmid: string, type: string, name: string): string {
  return `${pgmid.trim().toUpperCase()}|${type.trim().toUpperCase()}|${name.trim().toUpperCase()}`
}

async function observeSourceTarget(
  evidence: EvidenceDraft,
  name: string,
  input: Record<string, unknown>,
  connectionId: string,
  backend: SapBackend
): Promise<void> {
  const uri = String(input.fileUri ?? input.url ?? "")
  let sourceEvidence = "source"
  try {
    if (uri) {
      const inspection = await backend.inspectSource(connectionId, uri)
      const inactive = inspection.inactiveSource !== null
      const source = inspection.inactiveSource ?? inspection.activeSource
      sourceEvidence = inactive ? "inactive_source" : "active_source"
      evidence.exists = true
      evidence.active = !inactive
      evidence.fingerprint = sourceFingerprint(source)
      evidence.sources.push(sourceEvidence)
      return
    }
    const target = sourceObject(name, input)
    if (!target) throw new Error("write target has no readable source identity")
    const matches = await backend.searchObjects(connectionId, target.name, [target.type], 20)
    const object = matches.find(({ name }) => name.toUpperCase() === target.name)
    evidence.sources.push("adt_object_search")
    if (!object) {
      evidence.exists = false
      return
    }
    evidence.exists = true
    evidence.packageName = object.package
    const source = await backend.readSource(connectionId, object, { version: "active" })
    evidence.active = true
    evidence.fingerprint = sourceFingerprint(source.source)
    evidence.sources.push("active_source")
  } catch (error) {
    if (isMissing(error)) {
      if (evidence.exists === null) evidence.exists = false
      else recordObservationError(evidence, sourceEvidence, error)
      return
    }
    recordObservationError(evidence, sourceEvidence, error)
  }
}

function sourceObject(
  name: string,
  input: Record<string, unknown>
): { name: string; type: string } | undefined {
  if (name === "create_object_programmatically") {
    return { name: String(input.name).toUpperCase(), type: baseType(input.objectType) }
  }
  if (name === "delete_abap_source_object") {
    const objectType = String(input.objectType).toUpperCase()
    const objectName = String(input.objectName).trim().toUpperCase()
    if (objectType === "FUGR/I") {
      const parentName = String(input.parentName).trim().toUpperCase()
      return {
        name: /^[A-Z][A-Z0-9_]{2}$/.test(objectName) ? `L${parentName}${objectName}` : objectName,
        type: "PROG"
      }
    }
    if (objectType === "FUGR/FF") return { name: objectName, type: "FUNC" }
    return { name: objectName, type: baseType(objectType) }
  }
  if (name === "create_test_include") {
    return { name: String(input.className).toUpperCase(), type: "CLAS" }
  }
  if (name === "manage_text_elements") {
    const type = { PROGRAM: "PROG", CLASS: "CLAS", FUNCTION_GROUP: "FUGR" }[
      String(input.objectType).toUpperCase()
    ]
    return type ? { name: String(input.objectName).toUpperCase(), type } : undefined
  }
  if (input.objectName) {
    return {
      name: String(input.objectName).toUpperCase(),
      type: baseType(input.objectType ?? "PROG")
    }
  }
  return undefined
}

function sourceAssignment(
  name: string,
  input: Record<string, unknown>
):
  | {
      objectName: unknown
      objectType: "CLAS/OC" | "INTF/OI" | "FUGR/F" | "FUGR/FF" | "PROG/P" | "PROG/I" | "TRAN"
    }
  | undefined {
  if (name === "delete_abap_source_object") {
    const type = String(input.objectType).toUpperCase()
    if (type === "FUGR/I") {
      return { objectName: input.parentName, objectType: "FUGR/F" }
    }
    if (type === "FUGR/F" || type === "FUGR/FF") {
      return { objectName: input.objectName, objectType: type }
    }
    if (["CLAS/OC", "INTF/OI", "PROG/P", "PROG/I"].includes(type)) {
      return {
        objectName: input.objectName,
        objectType: type as "CLAS/OC" | "INTF/OI" | "PROG/P" | "PROG/I"
      }
    }
    return undefined
  }
  if (name !== "manage_text_elements") return undefined
  const type = String(input.objectType).toUpperCase()
  if (type === "PROGRAM") return { objectName: input.objectName, objectType: "PROG/P" }
  if (type === "FUNCTION_GROUP") return { objectName: input.objectName, objectType: "FUGR/F" }
  return undefined
}

function baseType(value: unknown): string {
  return String(value).toUpperCase().split("/", 1)[0] || "PROG"
}

function parseJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SAP readback is not a JSON object")
  }
  return parsed as Record<string, unknown>
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function classicBadiSnapshot(
  value: Record<string, unknown>,
  implementationName: string
): { value: Record<string, unknown>; active: boolean; packageName: string | null } | undefined {
  const definition = value.definition as Record<string, unknown> | undefined
  const assignments = Array.isArray(definition?.implementationAssignments)
    ? (definition.implementationAssignments as Array<Record<string, unknown>>).filter(
        (row) => String(row.implementationName).toUpperCase() === implementationName
      )
    : []
  if (!assignments.length) return undefined
  const classMappings = Array.isArray(definition?.classMappings)
    ? (definition.classMappings as Array<Record<string, unknown>>).filter(
        (row) => String(row.implementationName).toUpperCase() === implementationName
      )
    : []
  return {
    value: { assignments, classMappings },
    active: assignments.some((row) => row.active === true),
    packageName: stringValue(assignments[0]?.packageName)
  }
}

export function isMissing(error: unknown): boolean {
  const text = String(error)
  // The helper answers a missing object with a code that says only that the read failed and a
  // message whose "does not exist" wording is localised. On w200 (system language 1) a function
  // module that does not exist comes back as
  // "FUNCTION_READ_FAILED: 功能模块 <name> 不存在", which no English pattern matches, so the normal
  // state before every create was recorded as an observation error instead of as evidence that the
  // target is absent - a warning the receipt could not explain and an observationStatus of partial.
  if (/不存在|未找到|没有找到/.test(text)) return true
  return /(?:SCREEN|TRANSACTION|FUNCTION|MESSAGE_CLASS|REPOSITORY_OBJECT|DDIC_OBJECT|ENHANCEMENT_IMPLEMENTATION|OBJECT)_(?:NOT_FOUND|DOES_NOT_EXIST)|(?:screen|transaction|function(?: module)?|message class|repository object|ABAP object|program) (?:does not exist|was not found)|could not find (?:ABAP )?object/i.test(
    text
  )
}

function sourceFingerprint(source: string): string {
  return createHash("sha256").update(source).digest("hex")
}

function recordObservationError(evidence: EvidenceDraft, source: string, error: unknown): void {
  evidence.warnings.push(`${source}: observation failed (${hashWriteInput(String(error))})`)
}
