import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

// Existing development-system samples only. No fixtures or business writes.
const client = new Client({ name: "m5-body-acceptance", version: "1" })
const evidence = { startedAt: new Date().toISOString(), checks: [] }
const connectionId = "w200"
const interval = {
  fromSystemTime: "2026-09-08T11:00:00",
  toSystemTime: "2026-09-08T12:00:00"
}
function summary(reply) {
  return JSON.parse(
    JSON.stringify(reply, (key, value) => {
      if (key === "text" && typeof value === "string")
        return { length: value.length, nonempty: value.trim().length > 0 }
      return value
    })
  )
}
export function assertExpectedRejection(response, expected) {
  assert.equal(response.isError, true, "Expected an explicit MCP tool error")
  const text = response.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  assert.equal(typeof text, "string")
  assert.match(text, expected)
  return { rejected: true, reason: text }
}

export function assertLocalSystemCoverage(source) {
  assert.ok(source, "SM21 source is required")
  assert.equal(source.status, "ok")
  assert.equal(source.coverage, "local_instance_bounded_tail")
  assert.equal(source.truncated, true)
  assert.equal(typeof source.server, "string")
  assert.ok(source.server.length > 0 && source.server.length <= 64)
  assert.ok(Number.isInteger(source.scannedRecords))
  assert.ok(source.scannedRecords >= 0 && source.scannedRecords <= 2000)
  assert.ok(Number.isInteger(source.returnedCount))
  assert.ok(source.returnedCount >= 0 && source.returnedCount <= source.scannedRecords)
}

async function call(name, args, expectedRejection) {
  const response = await client.callTool(
    { name, arguments: { connectionId, ...args } },
    undefined,
    { timeout: 120000 }
  )
  if (expectedRejection) return assertExpectedRejection(response, expectedRejection)
  const text = response.content
    ?.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
  if (response.isError) throw new Error(text)
  return JSON.parse(text)
}
async function check(name, run) {
  const item = { name }
  evidence.checks.push(item)
  try {
    await run(item)
    item.passed = true
  } catch (error) {
    item.passed = false
    item.error = error.message
  }
}
async function selfCheck(functionName, inputParameters, expected) {
  const fingerprints = {
    Z_ORVANTA_LOG_READ: "0b6ed92e7f9d8a9f46fc73c4dc24486a042316e18fd940fac2d6e8552fde0d96",
    Z_ORVANTA_OPS_READ: "371bbcd37ec1d761d563d7f2773a5e43b639fa3e7e0e21b1b7c0d288c1b01005"
  }
  const definition = await call("read_function_module_interface", { functionName })
  assert.equal(definition.sourceFingerprint, fingerprints[functionName], "Reviewed source changed")
  return call("test_remote_function_module", {
    functionName,
    inputParameters,
    expectedOutputs: { EV_RESULT: expected },
    expectedInterfaceFingerprint: definition.fingerprint,
    acknowledgePotentialSideEffects: true,
    operationId: `m5-body-accept-${Date.now()}`
  })
}
function readable(messages) {
  assert.ok(messages.length > 0, "Existing sample must return messages")
  assert.ok(
    messages.every((m) => m.text?.trim() && !m.textUnavailable && !m.textTruncated),
    "Every returned sample message must have available, nonempty, untruncated text"
  )
}
async function main() {
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4847/mcp")))
    for (const number of ["07802", "36274", "36275"]) {
      await check(`SLG1 ${number}: full pagination, revision, nonempty text`, async (item) => {
        const logNumber = number.padStart(20, "0")
        let page = await call("read_application_log", { logNumber, maxMessages: 2 })
        item.pages = [summary(page)]
        assert.equal(page.status, "ok")
        readable(page.messages)
        const first = page
        const messages = [...page.messages]
        while (page.hasMore) {
          assert.ok(item.pages.length < 501, "Pagination budget")
          page = await call("read_application_log", {
            logNumber,
            maxMessages: 2,
            afterMessageNumber: page.nextAfterMessageNumber,
            expectedRevision: first.revision
          })
          item.pages.push(summary(page))
          assert.equal(page.status, "ok")
          assert.equal(page.revision, first.revision)
          readable(page.messages)
          assert.ok(page.messages[0].number > messages.at(-1).number)
          messages.push(...page.messages)
        }
        assert.equal(messages.length, first.header.messageCount)
        const wrongRevision = (first.revision[0] === "0" ? "1" : "0") + first.revision.slice(1)
        const stale = await call("read_application_log", {
          logNumber,
          expectedRevision: wrongRevision
        })
        item.stale = summary(stale)
        assert.equal(stale.code, "LOG_CHANGED")
      })
    }
    await check(
      "SLG1 07708: confirmed absent definition remains explicitly unavailable",
      async (item) => {
        item.definitionCheck = await selfCheck(
          "Z_ORVANTA_LOG_READ",
          {
            IV_ACTION: "READ_BODY_CHECK",
            IV_LOGNUMBER: "00000000000000007708",
            IV_LIMIT: "2"
          },
          "MESSAGE_DEFINITION_ABSENT"
        )
        const reply = await call("read_application_log", { logNumber: "00000000000000007708" })
        item.reply = summary(reply)
        assert.equal(reply.status, "ok")
        assert.equal(reply.messages.length, 1)
        assert.equal(reply.messages[0].messageClass, "ZCA")
        assert.equal(reply.messages[0].messageNumber, "606")
        assert.equal(reply.messages[0].textUnavailable, true)
        assert.equal(reply.messages[0].text, "")
      }
    )
    await check("SLG1 nonexistent key", async (item) => {
      const reply = await call("read_application_log", { logNumber: "99999999999999999999" })
      item.reply = summary(reply)
      assert.equal(reply.status, "not_found")
    })
    await check("SLG1 invalid key rejected", async (item) => {
      item.rejection = await call(
        "read_application_log",
        { logNumber: "bad" },
        /^MCP error -32602: Input validation error:[\s\S]*"code":\s*"invalid_string"[\s\S]*"logNumber"/
      )
    })
    for (const jobCount of ["00025900", "10595900"]) {
      await check(`SM37 SWWDHEX ${jobCount}: nonempty text`, async (item) => {
        const reply = await call("read_background_job_log", {
          jobName: "SWWDHEX",
          jobCount,
          maxMessages: 200
        })
        item.reply = summary(reply)
        assert.equal(reply.status, "ok")
        readable(reply.messages)
        assert.ok(reply.messages.length > 1, "Need a multipage existing job sample")
        const first = await call("read_background_job_log", {
          jobName: "SWWDHEX",
          jobCount,
          maxMessages: 1
        })
        const rest = await call("read_background_job_log", {
          jobName: "SWWDHEX",
          jobCount,
          maxMessages: 200,
          afterMessageNumber: first.nextAfterMessageNumber,
          expectedRevision: first.revision
        })
        item.pages = [summary(first), summary(rest)]
        assert.equal(rest.status, "ok")
        assert.equal(rest.hasMore, false)
        assert.equal(rest.revision, first.revision)
        assert.deepEqual([...first.messages, ...rest.messages], reply.messages)
        const stale = await call("read_background_job_log", {
          jobName: "SWWDHEX",
          jobCount,
          expectedRevision: (first.revision[0] === "0" ? "1" : "0") + first.revision.slice(1)
        })
        item.stale = summary(stale)
        assert.equal(stale.code, "LOG_CHANGED")
      })
    }
    await check("SM37/SM21 invalid input and unbound pagination rejected", async (item) => {
      item.rejections = []
      item.rejections.push(
        await call(
          "read_background_job_log",
          {
            jobName: "SWWDHEX",
            jobCount: "10595900",
            afterMessageNumber: 1
          },
          /^Error invoking read_background_job_log: Error: Subsequent job-log pages require expectedRevision$/
        )
      )
      item.rejections.push(
        await call(
          "read_background_job_log",
          {
            jobName: "SWWDHEX",
            jobCount: "bad"
          },
          /^MCP error -32602: Input validation error:[\s\S]*"code":\s*"invalid_string"[\s\S]*"jobCount"/
        )
      )
      item.rejections.push(
        await call(
          "read_system_logs",
          {
            ...interval,
            toSystemTime: "2026-09-08T12:00:01"
          },
          /^Error invoking read_system_logs: Error: Diagnostic range must be between 0 and 3600 seconds$/
        )
      )
      item.rejected = 3
    })
    await check("SM37/SM21/ST22 correlation preserves coverage and quality", async (item) => {
      const reply = await call("correlate_sap_logs", {
        ...interval,
        job: { jobName: "SWWDHEX", jobCount: "10595900" },
        systemLog: { program: "RSWWDHEX" },
        includeDumps: true,
        maxPerSource: 5
      })
      item.reply = summary(reply)
      assert.equal(reply.status, "partial", "Bounded SM21 must not imply complete coverage")
      assert.equal(reply.qualityGate, "not_evaluated")
      assert.ok(reply.sources.every((source) => source.status === "ok"))
      assertLocalSystemCoverage(reply.sources.find((source) => source.source === "SM21"))
      assert.ok(reply.candidates.length > 0)
      assert.ok(
        reply.candidates.every((candidate) => candidate.causalRelationship === "not_proven")
      )
      const systemEvents = reply.timeline.filter((event) => event.source === "SM21")
      readable(systemEvents)
      assert.ok(systemEvents.every((event) => event.textUnavailable === false))
    })
    for (const [name, functionName, input] of [
      [
        "SLG1",
        "Z_ORVANTA_LOG_READ",
        {
          IV_ACTION: "READ_BODY_CHECK",
          IV_LOGNUMBER: "00000000000000007802",
          IV_LIMIT: "2"
        }
      ],
      [
        "SM37",
        "Z_ORVANTA_OPS_READ",
        {
          IV_ACTION: "JOB_BODY_CHECK",
          IV_JOBNAME: "SWWDHEX",
          IV_JOBCOUNT: "10595900",
          IV_LIMIT: "1000"
        }
      ],
      [
        "SM21",
        "Z_ORVANTA_OPS_READ",
        {
          IV_ACTION: "SYSTEM_BODY_CHECK",
          IV_FROM: interval.fromSystemTime,
          IV_TO: interval.toSystemTime,
          IV_LIMIT: "5"
        }
      ]
    ]) {
      await check(`${name} body self-check`, async (item) => {
        item.reply = await selfCheck(functionName, input, "OK")
      })
    }
    for (const program of [undefined, "RSWWDHEX"]) {
      await check(`SM21 ${program ?? "all"}: nonempty text and scope`, async (item) => {
        const reply = await call("read_system_logs", { ...interval, program, maxResults: 5 })
        item.reply = summary(reply)
        assert.equal(reply.status, "ok")
        assertLocalSystemCoverage(reply)
        assert.ok(
          reply.entries.every((m) => m.client === "200" && (!program || m.program === program))
        )
        readable(reply.entries)
      })
    }
  } catch (error) {
    evidence.error = error.message
  } finally {
    await client.close()
    evidence.finishedAt = new Date().toISOString()
    evidence.passed =
      !evidence.error &&
      evidence.checks.length === 15 &&
      evidence.checks.every((check) => check.passed)
    const path = resolve("../.doc", `m5-log-body-acceptance-${Date.now()}.json`)
    await writeFile(path, JSON.stringify(evidence, null, 2), { flag: "wx" })
    console.log(
      JSON.stringify(
        {
          path,
          passed: evidence.passed,
          checks: evidence.checks.map(({ name, passed, error }) => ({ name, passed, error }))
        },
        null,
        2
      )
    )
    if (!evidence.passed) process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
