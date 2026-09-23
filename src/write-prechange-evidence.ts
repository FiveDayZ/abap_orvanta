import { createHash } from "node:crypto"
import type { SapBackend, SapDdicOperation } from "./backend.js"
import type { ToolService } from "./tools.js"
import { hashWriteInput, type SapPreChangeEvidence } from "./write-operation-receipts.js"
import { SmartformService } from "./smartforms.js"
import { transportFingerprint } from "./transport-delivery.js"

type EvidenceDraft = Omit<SapPreChangeEvidence, "observedAt" | "observationStatus">

export async function observeWritePreChange(
  name: string,
  input: Record<string, unknown>,
  connectionId: string,
  targetSummary: string,
  backend: SapBackend,
  tools: ToolService
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
        evidence.fingerprint = stringValue(value.interfaceFingerprint ?? value.fingerprint)
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
  const complete =
    evidence.warnings.length === 0 &&
    (evidence.exists === false ||
      (evidence.active !== null &&
        (evidence.version !== null || evidence.fingerprint !== null) &&
        evidence.packageName !== null))
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
    evidence.active = booleanValue(value.active)
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

function isMissing(error: unknown): boolean {
  return /(?:SCREEN|TRANSACTION|FUNCTION|MESSAGE_CLASS|REPOSITORY_OBJECT|DDIC_OBJECT|ENHANCEMENT_IMPLEMENTATION|OBJECT)_(?:NOT_FOUND|DOES_NOT_EXIST)|(?:screen|transaction|function(?: module)?|message class|repository object|ABAP object|program) (?:does not exist|was not found)|could not find (?:ABAP )?object/i.test(
    String(error)
  )
}

function sourceFingerprint(source: string): string {
  return createHash("sha256").update(source).digest("hex")
}

function recordObservationError(evidence: EvidenceDraft, source: string, error: unknown): void {
  evidence.warnings.push(`${source}: observation failed (${hashWriteInput(String(error))})`)
}
