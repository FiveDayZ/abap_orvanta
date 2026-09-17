import assert from "node:assert/strict"
import test from "node:test"
import { ToolService } from "../src/tools.js"
import { MockBackend } from "./mock-backend.js"

for (const direction of ["import", "export", "changing", "table"] as const) {
  test(`interface ${direction} add/rename/update/remove preserves other directions and body`, async () => {
    const backend = new MockBackend()
    let sourceWrites = 0
    const replaceSource = backend.replaceSource.bind(backend)
    backend.replaceSource = async (...args) => {
      sourceWrites++
      return replaceSource(...args)
    }
    const tools = new ToolService(backend)
    const base = { connectionId: "w200", functionName: "ZCMCP_FM_1501" }
    const initial = JSON.parse(await tools.readFunctionModuleInterface(base))
    let current = initial
    const stages = [
      {
        operation: "add" as const,
        direction,
        name: "P_ADDED",
        typeName: direction === "table" ? "BAPIRET2" : "CHAR20",
        passByValue: direction !== "table"
      },
      { operation: "rename" as const, direction, name: "P_ADDED", newName: "P_RENAMED" },
      {
        operation: "update" as const,
        direction,
        name: "P_RENAMED",
        description: "Updated parameter"
      },
      { operation: "remove" as const, direction, name: "P_RENAMED" }
    ]
    const keys = {
      import: "importParameters",
      export: "exportParameters",
      changing: "changingParameters",
      table: "tableParameters"
    }
    for (const operation of stages) {
      const writesBefore = sourceWrites
      current = JSON.parse(
        await tools.patchFunctionModuleInterface({
          ...base,
          functionGroup: "ZCMCP_FG_1501",
          packageName: "ZABAP",
          transportNumber: "GR2K923421",
          expectedInterfaceFingerprint: current.interfaceFingerprint,
          expectedSourceFingerprint: current.sourceFingerprint,
          parameterOperations: [operation],
          exceptionOperations: [],
          confirmation: "DESTRUCTIVE_INTERFACE_CHANGE"
        })
      )
      assert.equal(current.sourceFingerprint, initial.sourceFingerprint)
      const declarationChanged = operation.operation !== "update"
      assert.equal(sourceWrites - writesBefore, declarationChanged ? 1 : 0)
      assert.equal(current.sourceWritePerformed, declarationChanged)
      if (!declarationChanged) assert.equal(current.sourceMutation, null)
      assert.deepEqual(current.source, initial.source)
      for (const key of Object.values(keys).filter((key) => key !== keys[direction])) {
        assert.deepEqual(current[key], initial[key])
      }
      const name = operation.operation === "add" ? "P_ADDED" : "P_RENAMED"
      const parameter = current[keys[direction]].find((p: { name: string }) => p.name === name)
      if (operation.operation === "remove") assert.equal(parameter, undefined)
      else {
        assert.ok(parameter)
        if (operation.operation === "update")
          assert.equal(parameter.description, "Updated parameter")
      }
    }
    assert.deepEqual(current[keys[direction]], initial[keys[direction]])
  })
}

test("classic exception lifecycle preserves all parameters and implementation", async () => {
  const backend = new MockBackend()
  let sourceWrites = 0
  const replaceSource = backend.replaceSource.bind(backend)
  backend.replaceSource = async (...args) => {
    sourceWrites++
    return replaceSource(...args)
  }
  const tools = new ToolService(backend)
  const base = { connectionId: "w200", functionName: "ZCMCP_FM_1501" }
  const initial = JSON.parse(await tools.readFunctionModuleInterface(base))
  let current = initial
  for (const operation of [
    { operation: "add" as const, name: "TEMP_ERROR", description: "Temporary" },
    { operation: "rename" as const, name: "TEMP_ERROR", newName: "RENAMED_ERROR" },
    { operation: "update" as const, name: "RENAMED_ERROR", description: "Updated error" },
    { operation: "remove" as const, name: "RENAMED_ERROR" }
  ]) {
    const writesBefore = sourceWrites
    current = JSON.parse(
      await tools.patchFunctionModuleInterface({
        ...base,
        functionGroup: "ZCMCP_FG_1501",
        packageName: "ZABAP",
        transportNumber: "GR2K923421",
        expectedInterfaceFingerprint: current.interfaceFingerprint,
        expectedSourceFingerprint: current.sourceFingerprint,
        parameterOperations: [],
        exceptionOperations: [operation],
        confirmation: "DESTRUCTIVE_INTERFACE_CHANGE"
      })
    )
    const declarationChanged = operation.operation !== "update"
    assert.equal(sourceWrites - writesBefore, declarationChanged ? 1 : 0)
    assert.equal(current.sourceWritePerformed, declarationChanged)
    if (!declarationChanged) assert.equal(current.sourceMutation, null)
    for (const key of [
      "importParameters",
      "exportParameters",
      "changingParameters",
      "tableParameters",
      "source"
    ]) {
      assert.deepEqual(current[key], initial[key])
    }
    const name = operation.operation === "add" ? "TEMP_ERROR" : "RENAMED_ERROR"
    const exception = current.exceptions.find((x: { name: string }) => x.name === name)
    if (operation.operation === "remove") assert.equal(exception, undefined)
    else {
      assert.ok(exception)
      if (operation.operation === "update") assert.equal(exception.description, "Updated error")
    }
  }
  assert.deepEqual(current.exceptions, initial.exceptions)
})
