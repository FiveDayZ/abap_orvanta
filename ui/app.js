const $ = (id) => document.getElementById(id)
let token = location.hash.slice(1)
if (token) {
  sessionStorage.setItem("abap-settings-token", token)
  history.replaceState(null, "", location.pathname)
} else token = sessionStorage.getItem("abap-settings-token") || ""
let state
let selected = null
let draft = false
let dirty = false
let working = false
let exited = false
let enabled = new Set()
let selectionInitialized = false

function notice(message, error = false) {
  $("notice").hidden = !message
  $("notice").textContent = message
  $("notice").classList.toggle("error", error)
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || "操作未完成")
  return result
}
async function run(action) {
  if (working) return
  working = true
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = true
  })
  notice("正在处理…")
  try {
    await action()
  } catch (error) {
    notice(error.message || "无法连接配置中心，请重新打开。", true)
  } finally {
    working = false
    if (exited) return
    document.querySelectorAll("button").forEach((button) => {
      button.disabled = false
    })
    applyDisabled()
  }
}
function applyDisabled() {
  const running = Boolean(state?.service.running)
  const active = state?.service.connectionIds?.includes(selected)
  $("connection-fields").disabled = active || working || Boolean(state?.configIssue)
  $("password").disabled = active || working || dirty
  $("set-password").disabled = active || working || dirty
  $("clear-password").disabled = active || working || dirty
  $("add").disabled = working || Boolean(state?.configIssue)
  $("empty-add").disabled = $("add").disabled
  $("port").disabled = running || working
  $("test").disabled = working || dirty || draft || !state?.credentials.includes(selected)
  $("start").disabled = working || dirty || !enabled.size || Boolean(state?.configIssue)
  $("exit").disabled = working || Boolean(state?.service.running)
  document.querySelectorAll(".connection-enable").forEach((input) => {
    input.disabled = running || working
  })
  document.querySelectorAll(".connection-delete").forEach((button) => {
    button.disabled = working || Boolean(state?.configIssue)
  })
}
function confirmAction(title, message) {
  $("confirm-title").textContent = title
  $("confirm-message").textContent = message
  const dialog = $("confirm-dialog")
  dialog.returnValue = "cancel"
  dialog.showModal()
  return new Promise((resolve) =>
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {
      once: true
    })
  )
}
async function mayDiscard() {
  return !dirty || (await confirmAction("放弃未保存的更改？", "当前连接表单中的修改将被丢弃。"))
}
function render() {
  $("version").textContent = `v${state.version}`
  if (!selectionInitialized && state.connections.length) {
    enabled.add(state.connections[0].id)
    selectionInitialized = true
  }
  enabled = new Set([...enabled].filter((id) => state.connections.some((c) => c.id === id)))
  if (state.service.running) enabled = new Set(state.service.connectionIds)
  $("connection-count").textContent = `${state.connections.length}`
  $("selection-count").textContent = `本次启用 ${enabled.size} / ${state.connections.length}`
  $("connections").replaceChildren()
  state.connections.forEach((connection) => {
    const row = document.createElement("div")
    row.className = `connection-row${connection.id === selected && !draft ? " selected" : ""}`
    const checkbox = document.createElement("input")
    checkbox.type = "checkbox"
    checkbox.className = "connection-enable"
    checkbox.checked = enabled.has(connection.id)
    checkbox.setAttribute("aria-label", `本次启用 ${connection.id}`)
    checkbox.title = `本次启用 ${connection.id}`
    checkbox.onchange = () => {
      if (checkbox.checked) enabled.add(connection.id)
      else enabled.delete(connection.id)
      $("selection-count").textContent = `本次启用 ${enabled.size} / ${state.connections.length}`
      $("service-detail").textContent = enabled.size ? [...enabled].join(" · ") : "未选择连接"
      applyDisabled()
    }
    const button = document.createElement("button")
    button.className = "connection-item"
    button.setAttribute("aria-current", String(connection.id === selected && !draft))
    const dot = document.createElement("i")
    const active = state.service.connectionIds.includes(connection.id)
    dot.className = `dot${active ? " ready" : ""}`
    const text = document.createElement("div")
    const title = document.createElement("strong")
    title.textContent = connection.id
    const subtitle = document.createElement("span")
    subtitle.textContent = `${connection.client} · ${connection.username}`
    const status = document.createElement("span")
    status.className = "connection-status"
    status.textContent = active
      ? "运行中"
      : state.credentials.includes(connection.id)
        ? "凭据就绪"
        : "未设置凭据"
    text.append(title, subtitle, status)
    button.append(dot, text)
    button.addEventListener("click", async () => {
      if (working || !(await mayDiscard())) return
      selected = connection.id
      draft = false
      fill(connection)
      render()
      showTab("connection")
      notice("")
    })
    const remove = document.createElement("button")
    remove.className = "icon-button connection-delete danger"
    remove.title = `删除 ${connection.id}`
    remove.setAttribute("aria-label", remove.title)
    const icon = document.createElement("img")
    icon.src = "/icons/trash-2.svg"
    icon.alt = ""
    remove.append(icon)
    remove.onclick = () => deleteConnection(connection.id)
    row.append(checkbox, button, remove)
    $("connections").append(row)
  })
  const exists = draft || state.connections.some((connection) => connection.id === selected)
  $("empty").hidden = exists
  $("connection-form").hidden = !exists
  $("credential-section").hidden = !exists || draft
  $("saved-state").textContent = dirty ? "有未保存的更改" : draft ? "新连接" : "已保存"
  $("saved-state").classList.toggle("dirty", dirty)
  $("credential-state").textContent = state.credentials.includes(selected)
    ? "已设置 · 仅内存"
    : "待输入密码"
  $("connection-lock").hidden = !state.service.connectionIds.includes(selected)
  $("current-system").textContent = draft ? "新连接" : selected || "连接管理"
  const running = state.service.running
  $("service-label").textContent = running ? "服务运行中" : "服务未启动"
  $("service-detail").textContent = running
    ? state.service.connectionIds.join(" · ")
    : enabled.size
      ? [...enabled].join(" · ")
      : "未选择连接"
  $("service-dot").classList.toggle("ready", running)
  $("start").hidden = running
  $("stop").hidden = !running
  if (running) $("port").value = state.service.port
  $("endpoint-status").textContent = running ? "正在监听" : "服务未启动"
  $("config-path").textContent = state.configPath
  $("state-path").textContent = state.stateRoot
  $("events").replaceChildren()
  for (const entry of state.events) {
    const row = document.createElement("li")
    const time = document.createElement("time")
    time.textContent = new Date(entry.time).toLocaleTimeString("zh-CN", { hour12: false })
    const message = document.createElement("span")
    message.textContent = entry.message
    row.append(time, message)
    $("events").append(row)
  }
  renderEndpoint()
  applyDisabled()
  if (state.configIssue) notice(state.configIssue, true)
}
function fill(connection) {
  for (const [key, id] of Object.entries({
    id: "connection-id",
    url: "url",
    username: "username",
    client: "client",
    passwordEnv: "password-env"
  }))
    $(id).value = connection[key] || ""
  if (![...$("language").options].some((item) => item.value === connection.language))
    $("language").add(new Option(connection.language, connection.language))
  $("language").value = connection.language
  $("atc-variant").value = connection.atcVariant || ""
  $("allowlist").value = connection.remoteFunctionAllowlist.join("\n")
  $("allow-unauthorized").checked = connection.allowUnauthorized
  $("password").value = ""
  $("test-result").textContent = "尚未测试"
  dirty = false
}
function readForm() {
  const variant = $("atc-variant").value.trim()
  return {
    id: $("connection-id").value.trim().toLowerCase(),
    url: $("url").value.trim(),
    client: $("client").value.trim(),
    language: $("language").value,
    username: $("username").value.trim(),
    passwordEnv: $("password-env").value.trim(),
    allowUnauthorized: $("allow-unauthorized").checked,
    remoteFunctionAllowlist: $("allowlist")
      .value.split(/[\n,]/)
      .map((name) => name.trim().toUpperCase())
      .filter(Boolean),
    ...(variant ? { atcVariant: variant } : {})
  }
}
async function reload() {
  state = await api("/api/state")
  if (!state.connections.some((connection) => connection.id === selected))
    selected = state.connections[0]?.id ?? null
  draft = false
  dirty = false
  if (selected) fill(state.connections.find((connection) => connection.id === selected))
  render()
}
async function add() {
  if (working || !state || !(await mayDiscard())) return
  selected = null
  draft = true
  fill({
    id: "",
    url: "",
    username: "",
    client: "200",
    language: "EN",
    passwordEnv: "ABAP_MCP_SAP_PASSWORD",
    allowUnauthorized: false,
    remoteFunctionAllowlist: []
  })
  render()
  showTab("connection")
  $("connection-id").focus()
}
function showTab(tab) {
  for (const name of ["connection", "service"]) {
    $(`${name}-tab`).setAttribute("aria-selected", String(name === tab))
    $(`${name}-view`).hidden = name !== tab
    $(`${name}-tab`).tabIndex = name === tab ? 0 : -1
  }
  $("heading").textContent = tab === "connection" ? "连接设置" : "服务与接入"
}
function renderEndpoint() {
  const port = Number($("port").value)
  const url =
    state?.service.url ||
    `http://127.0.0.1:${Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : 4847}/mcp`
  $("endpoint").value = url
  $("client-config").textContent =
    $("client-format").value === "toml"
      ? `[mcp_servers.orvanta]\nurl = "${url}"\n`
      : JSON.stringify({ mcpServers: { orvanta: { url } } }, null, 2)
}
$("connection-form").addEventListener("input", () => {
  dirty = true
  $("saved-state").textContent = "有未保存的更改"
  $("saved-state").classList.add("dirty")
  applyDisabled()
})
$("connection-form").addEventListener("submit", (event) => {
  event.preventDefault()
  run(async () => {
    const connection = readForm()
    const others = state.connections.filter((item) => draft || item.id !== selected)
    if (others.some((item) => item.id === connection.id))
      throw new Error("连接标识已存在，请使用其他名称。")
    const result = await api("/api/config", {
      revision: state.revision,
      connections: [...others, connection]
    })
    state = result.state
    if (enabled.delete(selected) || !state.connections.some((c) => enabled.has(c.id)))
      enabled.add(connection.id)
    selected = connection.id
    draft = false
    fill(connection)
    render()
    notice("连接已保存。")
  })
})
$("credential-form").addEventListener("submit", (event) => {
  event.preventDefault()
  const password = $("password").value
  $("password").value = ""
  run(async () => {
    state = (await api("/api/password", { connectionId: selected, password })).state
    render()
    notice("本次密码已设置，未写入配置文件。")
  })
})
$("clear-password").onclick = () =>
  run(async () => {
    state = (await api("/api/password", { connectionId: selected, password: "" })).state
    $("password").value = ""
    render()
    notice("本次密码已清除。")
  })
$("add").onclick = add
$("empty-add").onclick = add
$("refresh").onclick = async () => {
  if (await mayDiscard())
    run(async () => {
      await reload()
      notice("配置已刷新。")
    })
}
$("discard").onclick = async () => {
  if (await mayDiscard())
    run(async () => {
      await reload()
      notice("")
    })
}
async function deleteConnection(id) {
  if (working || !state) return
  if (state.service.connectionIds.includes(id)) {
    notice(`连接 ${id} 正在运行。请先停止 MCP 服务，再删除此连接。`, true)
    return
  }
  if (!(await mayDiscard())) return
  if (
    !(await confirmAction(
      `删除连接 ${id}？`,
      "将删除本地配置并清除本次密码。SAP 对象及操作凭证不受影响。"
    ))
  )
    return
  run(async () => {
    state = (
      await api("/api/config", {
        revision: state.revision,
        connections: state.connections.filter((item) => item.id !== id)
      })
    ).state
    enabled.delete(id)
    await reload()
    notice(`连接 ${id} 已删除。`)
  })
}
$("delete").onclick = async () => {
  if (draft) {
    if (await mayDiscard()) run(reload)
    return
  }
  await deleteConnection(selected)
}
$("test").onclick = () =>
  run(async () => {
    $("test-result").textContent = "正在测试…"
    const response = await api("/api/test", { connectionId: selected })
    state = response.state
    render()
    $("test-result").textContent =
      `ADT：${response.result.adt ? "通过" : "未通过"} · 基础助手：${response.result.helper ? "通过" : "未通过"}`
    notice(
      response.result.adt
        ? "SAP ADT 连接测试通过。"
        : "SAP ADT 连接测试未通过，请核对地址、账号、密码、权限和网络。",
      !response.result.adt
    )
  })
$("start").onclick = () =>
  run(async () => {
    state = (
      await api("/api/start", {
        port: Number($("port").value),
        connectionIds: [...enabled]
      })
    ).state
    render()
    notice("服务已启动。")
  })
$("stop").onclick = async () => {
  if (
    !(await confirmAction(
      "停止 MCP 服务？",
      "Agent 与本界面所启动服务的连接将断开。正在执行操作时会拒绝停止。"
    ))
  )
    return
  run(async () => {
    state = (await api("/api/stop", {})).state
    render()
    notice("服务已停止。")
  })
}
for (const name of ["connection", "service"]) {
  $(`${name}-tab`).onclick = () => showTab(name)
  $(`${name}-tab`).onkeydown = (event) => {
    if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault()
      const next = name === "connection" ? "service" : "connection"
      showTab(next)
      $(`${next}-tab`).focus()
    }
  }
}
$("port").oninput = renderEndpoint
$("confirm-cancel").onclick = () => $("confirm-dialog").close("cancel")
$("confirm-accept").onclick = () => $("confirm-dialog").close("confirm")
$("client-format").onchange = renderEndpoint
$("copy-url").onclick = () =>
  run(async () => {
    await navigator.clipboard.writeText($("endpoint").value)
    notice("服务地址已复制。")
  })
$("copy-config").onclick = () =>
  run(async () => {
    await navigator.clipboard.writeText($("client-config").textContent)
    notice("客户端配置已复制。")
  })
$("exit").onclick = async () => {
  if (
    !(await mayDiscard()) ||
    !(await confirmAction("关闭配置中心？", "本次密码将清除，下次打开需要重新输入。"))
  )
    return
  run(async () => {
    await api("/api/exit", {})
    exited = true
    dirty = false
    sessionStorage.removeItem("abap-settings-token")
    $("password").value = ""
    notice("配置中心已关闭，本次密码已清除。")
  })
}
window.addEventListener("beforeunload", (event) => {
  if (dirty) {
    event.preventDefault()
    event.returnValue = ""
  }
})
run(async () => {
  await reload()
  notice(state.configIssue || "", Boolean(state.configIssue))
})
