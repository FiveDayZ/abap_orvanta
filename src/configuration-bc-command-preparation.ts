import { hashWriteInput } from "./write-operation-receipts.js"
import {
  ConfigurationBcBeforeStateStore,
  assertConfigurationBcBeforeState,
  type ConfigurationBcStateBinding
} from "./configuration-bc-before-state-store.js"
import {
  configurationBcCommandContract,
  configurationBcCommandRequestSchema
} from "./configuration-bc-command-contract.js"
import type { readConfigurationBcBeforeState } from "./configuration-bc-state.js"
import {
  assertConfigurationBcEffectsEvidence,
  type ConfigurationBcEffectsEvidence
} from "./configuration-bc-effects.js"

type State = Awaited<ReturnType<typeof readConfigurationBcBeforeState>>
const requestBinding = [
  "connectionId",
  "bcSetId",
  "version",
  "requestNumber",
  "taskNumber"
] as const

/** Internal read-only preparation; the future command still owns SAP locks and receipt reservation. */
export async function prepareConfigurationBcCommand(
  raw: unknown,
  authenticatedBinding: ConfigurationBcStateBinding,
  store: ConfigurationBcBeforeStateStore,
  readCurrent: () => Promise<State>,
  effectsEvidence?: {
    reference: string
    readCurrent: () => Promise<ConfigurationBcEffectsEvidence>
  }
) {
  const input = configurationBcCommandRequestSchema.parse(raw)
  for (const field of requestBinding)
    if (input[field] !== authenticatedBinding[field])
      throw Error("CONFIGURATION_BC_COMMAND_BINDING_INVALID")

  const before = await store.read(input.beforeStateReference, authenticatedBinding)
  const linked = effectsEvidence
    ? await store.readEffects(effectsEvidence.reference, authenticatedBinding)
    : undefined
  if (linked && linked.beforeStateReference !== input.beforeStateReference)
    throw Error("CONFIGURATION_BC_COMMAND_EFFECTS_BINDING_INVALID")
  // Only a server-owned complete native reader may supply this observation, never request bytes.
  const current = structuredClone(await readCurrent())
  assertConfigurationBcBeforeState(current)
  if (hashWriteInput(current) !== input.beforeStateReference)
    throw Error("CONFIGURATION_BC_COMMAND_BEFORE_STATE_CHANGED")

  if (linked && effectsEvidence) {
    const effects = structuredClone(await effectsEvidence.readCurrent())
    assertConfigurationBcEffectsEvidence(effects, current, input.beforeStateReference)
    // A read operation ID is an audit label, not a native data version or command permission.
    if (
      hashWriteInput({ ...effects, operationId: linked.effects.operationId }) !==
      hashWriteInput(linked.effects)
    )
      throw Error("CONFIGURATION_BC_COMMAND_EFFECTS_CHANGED")
  }

  const contract = configurationBcCommandContract(input)
  return {
    ...contract,
    readOnly: true as const,
    lockedSnapshot: false as const,
    nativeBeforeStateRechecked: true as const,
    ...(linked && effectsEvidence
      ? {
          nativeEffectsRechecked: true as const,
          effectsBeforeState: {
            reference: effectsEvidence.reference,
            beforeStateReference: linked.beforeStateReference,
            effectsVersion: linked.effects.effectsVersion,
            ctsVersion: linked.effects.ctsVersion,
            scopeVersion: linked.effects.scopeVersion,
            bodyFingerprint: linked.effects.bodyFingerprint,
            counts: { ...linked.effects.counts },
            profileCount: linked.effects.profileCount
          }
        }
      : {}),
    beforeState: {
      reference: input.beforeStateReference,
      versions: { ...before.versions },
      counts: { ...before.counts },
      identity: { ...before.identity },
      layoutFingerprint: before.layoutFingerprint
    },
    requiredNativeChecks: contract.requiredNativeChecks,
    blockedBy: [
      ...contract.blockedBy.filter((reason) => reason !== "native_before_state_runtime_acceptance"),
      "sap_locked_before_state_not_established"
    ]
  }
}
