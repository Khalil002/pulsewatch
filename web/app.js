// pulsewatch web client: plain REST against /api, refreshed every few seconds.
const state = {
  token: localStorage.getItem("pw.token"),
  user: null,
  org: null,
  tab: "monitors",
  selected: null, // monitor id shown in the detail card
  timer: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const isAdmin = () => ["owner", "admin"].includes(state.user?.role);

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.detail ?? data?.title ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

let toastTimer;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.add("hidden"), 3500);
}

function show(view) {
  for (const id of ["auth-view", "dash-view", "status-view"]) $(`#${id}`).classList.toggle("hidden", id !== view);
}

const ago = (iso) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};
const duration = (from, to) => {
  const s = Math.round(((to ? new Date(to) : new Date()) - new Date(from)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const pct = (v) => (v === null || v === undefined ? "–" : `${v.toFixed(v === 100 ? 0 : 2)}%`);
const statusOf = (m) => (m.paused ? "paused" : m.status);

// --- routing -------------------------------------------------------------------

async function boot() {
  api("GET", "/health").then((d) => { $("#backend").textContent = `backend: ${d.backend}`; })
    .catch(() => { $("#backend").textContent = "backend: offline"; });
  const slug = location.hash.match(/^#status=([a-z0-9-]+)$/)?.[1];
  if (slug) return showStatusPage(slug);
  if (state.token) {
    try { state.user = await api("GET", "/me"); } catch { state.token = null; localStorage.removeItem("pw.token"); }
  }
  renderSession();
  state.user ? openDashboard() : show("auth-view");
}
window.addEventListener("hashchange", () => { clearInterval(state.timer); boot(); });

function renderSession() {
  $("#session").innerHTML = state.user
    ? `<span class="muted small">${esc(state.user.email)} · ${esc(state.user.role)}</span><button class="ghost" id="logout">Log out</button>`
    : "";
  if (state.user) $("#logout").onclick = () => {
    localStorage.removeItem("pw.token");
    location.hash = "";
    location.reload();
  };
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = event.submitter?.dataset.mode ?? "login";
  const f = new FormData(event.target);
  const body = { email: f.get("email"), password: f.get("password") };
  if (mode === "register") body.orgName = f.get("orgName");
  try {
    const data = await api("POST", `/auth/${mode}`, body);
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("pw.token", data.token);
    renderSession();
    openDashboard();
  } catch (err) {
    toast(err.message);
  }
});

$("#home-link").addEventListener("click", (e) => { e.preventDefault(); location.hash = ""; });

// --- dashboard -------------------------------------------------------------------

async function openDashboard() {
  show("dash-view");
  state.org = await api("GET", "/org");
  $("#new-monitor-card").classList.toggle("hidden", !isAdmin());
  $('[data-tab="settings"]').classList.toggle("hidden", !isAdmin());
  await refresh();
  clearInterval(state.timer);
  state.timer = setInterval(refresh, 5000);
}

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  state.tab = tab;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== tab));
  refresh();
});

async function refresh() {
  try {
    const [monitors, open] = await Promise.all([api("GET", "/monitors"), api("GET", "/incidents?status=open")]);
    const stats = await Promise.all(monitors.map((m) => api("GET", `/monitors/${m.id}/stats`)));
    renderSummary(monitors, stats, open);
    if (state.tab === "monitors") renderMonitors(monitors, stats);
    if (state.tab === "incidents") renderIncidents(await api("GET", "/incidents"));
    if (state.tab === "alerts") renderAlerts(await api("GET", "/alerts"), monitors);
    if (state.tab === "settings") await renderSettings();
  } catch (err) {
    if (err.status === 401) { localStorage.removeItem("pw.token"); location.reload(); }
    else toast(err.message);
  }
}

function renderSummary(monitors, stats, open) {
  const up = monitors.filter((m) => !m.paused && m.status === "up").length;
  const active = monitors.filter((m) => !m.paused).length;
  const withChecks = stats.filter((s) => s.checks > 0);
  const uptime = withChecks.length ? withChecks.reduce((a, s) => a + s.uptimePercent, 0) / withChecks.length : null;
  $("#summary").innerHTML = `
    <div class="stat"><b>${up} / ${active}</b><span>monitors up</span></div>
    <div class="stat"><b class="${open.length ? "bad" : "ok"}">${open.length}</b><span>open incidents</span></div>
    <div class="stat"><b>${pct(uptime)}</b><span>average uptime, 24h</span></div>
    <div class="stat"><b><a href="#status=${esc(state.org.slug)}" target="_blank">/${esc(state.org.slug)}</a></b><span>public status page</span></div>`;
}

function bars(hourly) {
  // One bar per hour for the last 24h: height is latency, red means at least one failure.
  const byHour = new Map(hourly.map((h) => [new Date(h.hour).getTime(), h]));
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  const slots = Array.from({ length: 24 }, (_, i) => byHour.get(now.getTime() - (23 - i) * 3_600_000));
  const max = Math.max(1, ...hourly.map((h) => h.avgLatencyMs));
  return `<div class="bars">${slots.map((h) => h
    ? `<i class="${h.failures ? "bad" : ""}" style="height:${Math.max(8, (100 * h.avgLatencyMs) / max)}%" title="${h.checks} checks, ${h.failures} failed, ${h.avgLatencyMs} ms"></i>`
    : `<i class="none" title="no checks"></i>`).join("")}</div>`;
}

function renderMonitors(monitors, stats) {
  $("#monitors").innerHTML = monitors.map((m, i) => `
    <li class="monitor ${state.selected === m.id ? "selected" : ""}" data-id="${m.id}">
      <span class="dot ${statusOf(m)}"></span>
      <div><div class="name">${esc(m.name)}</div><div class="url">${esc(m.method)} ${esc(m.url)} · every ${m.intervalSec}s</div></div>
      <div class="nums"><div>${pct(stats[i].uptimePercent)}</div><div class="muted">${stats[i].avgLatencyMs ?? "–"} ms · ${ago(m.lastCheckedAt)}</div></div>
    </li>`).join("") || `<li class="card muted">No monitors yet. Add one to start checking it.</li>`;
  if (state.selected) renderDetail(monitors.find((m) => m.id === state.selected), stats[monitors.findIndex((m) => m.id === state.selected)]);
}

$("#monitors").addEventListener("click", (e) => {
  const id = e.target.closest("[data-id]")?.dataset.id;
  if (!id) return;
  state.selected = state.selected === id ? null : id;
  if (!state.selected) $("#detail").classList.add("hidden");
  refresh();
});

async function renderDetail(m, stats) {
  if (!m) { state.selected = null; $("#detail").classList.add("hidden"); return; }
  const checks = await api("GET", `/monitors/${m.id}/checks?limit=8`);
  $("#detail").classList.remove("hidden");
  $("#detail").innerHTML = `
    <div class="row" style="justify-content:space-between">
      <h2>${esc(m.name)} <span class="badge ${statusOf(m)}">${statusOf(m)}</span></h2>
      ${isAdmin() ? `<div class="row">
        <button class="ghost" data-act="check">Check now</button>
        <button class="ghost" data-act="pause">${m.paused ? "Resume" : "Pause"}</button>
        <button class="danger" data-act="delete">Delete</button></div>` : ""}
    </div>
    <div class="muted small">${stats.checks} checks in 24h · ${stats.failures} failed · avg ${stats.avgLatencyMs ?? "–"} ms · p95 ${stats.p95LatencyMs ?? "–"} ms</div>
    ${bars(stats.hourly)}
    <table class="table"><thead><tr><th>When</th><th>Result</th><th>Status</th><th>Latency</th></tr></thead><tbody>
    ${checks.map((c) => `<tr><td>${ago(c.checkedAt)}</td><td class="${c.ok ? "ok" : "bad"}">${c.ok ? "ok" : esc(c.error)}</td>
      <td>${c.statusCode ?? "–"}</td><td>${c.latencyMs} ms</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No checks yet</td></tr>`}
    </tbody></table>`;
  $("#detail").querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(m, b.dataset.act)));
}

async function act(m, action) {
  try {
    if (action === "check") { await api("POST", `/monitors/${m.id}/check`); toast("Check queued"); }
    if (action === "pause") await api("PATCH", `/monitors/${m.id}`, { paused: !m.paused });
    if (action === "delete" && confirm(`Delete ${m.name} and its history?`)) {
      await api("DELETE", `/monitors/${m.id}`);
      state.selected = null;
      $("#detail").classList.add("hidden");
    }
    setTimeout(refresh, 600);
  } catch (err) {
    toast(err.message);
  }
}

$("#monitor-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const f = new FormData(event.target);
  const body = {
    name: f.get("name"), url: f.get("url"), method: f.get("method"),
    intervalSec: Number(f.get("intervalSec")), timeoutMs: Number(f.get("timeoutMs")), expectedStatus: Number(f.get("expectedStatus")),
    alertWebhookUrl: f.get("alertWebhookUrl") || null,
  };
  try {
    const m = await api("POST", "/monitors", body);
    event.target.reset();
    state.selected = m.id;
    toast("Monitor added; the first check runs now");
    setTimeout(refresh, 800);
  } catch (err) {
    toast(err.message);
  }
});

function renderIncidents(incidents) {
  $("#incidents").innerHTML = incidents.map((i) => `
    <tr><td>${esc(i.monitorName)} ${i.resolvedAt ? `<span class="badge up">resolved</span>` : `<span class="badge down">open</span>`}</td>
    <td>${esc(i.cause)}</td><td>${ago(i.startedAt)}</td><td>${duration(i.startedAt, i.resolvedAt)}</td></tr>`).join("")
    || `<tr><td colspan="4" class="muted">No incidents. Nice.</td></tr>`;
}

function renderAlerts(alerts, monitors) {
  const names = new Map(monitors.map((m) => [m.id, m.name]));
  $("#alerts").innerHTML = alerts.map((a) => `
    <tr><td>${esc(a.event)}</td><td>${esc(names.get(a.monitorId) ?? a.monitorId)}</td><td><span class="badge ${a.status}">${a.status}</span></td>
    <td>${a.attempts}</td><td class="muted">${esc(a.lastError ?? "")}</td><td>${ago(a.createdAt)}</td></tr>`).join("")
    || `<tr><td colspan="6" class="muted">No alerts yet. Add a webhook URL to a monitor to get them.</td></tr>`;
}

async function renderSettings() {
  const [keys, members] = await Promise.all([api("GET", "/api-keys"), api("GET", "/members")]);
  $("#keys").innerHTML = keys.map((k) => `
    <li><span>${esc(k.name)} <code>${esc(k.prefix)}…</code> <span class="muted small">${k.revokedAt ? "revoked" : `used ${ago(k.lastUsedAt)}`}</span></span>
    ${k.revokedAt ? "" : `<button class="danger" data-revoke="${k.id}">Revoke</button>`}</li>`).join("") || `<li class="muted">No keys yet</li>`;
  $("#members").innerHTML = members.map((m) => `<li><span>${esc(m.email)}</span><span class="badge">${esc(m.role)}</span></li>`).join("");
  $("#secret").textContent = state.org.webhookSecret ?? "";
  $("#member-form").classList.toggle("hidden", state.user.role !== "owner");
}

$("#keys").addEventListener("click", async (e) => {
  const id = e.target.dataset.revoke;
  if (!id) return;
  try { await api("DELETE", `/api-keys/${id}`); refresh(); } catch (err) { toast(err.message); }
});

$("#key-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const key = await api("POST", "/api-keys", { name: new FormData(event.target).get("name") });
    event.target.reset();
    $("#new-key").classList.remove("hidden");
    $("#new-key").innerHTML = `Copy this key now, it is not shown again:<br><b>${esc(key.key)}</b>`;
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

$("#member-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const f = new FormData(event.target);
  try {
    await api("POST", "/members", { email: f.get("email"), password: f.get("password"), role: f.get("role") });
    event.target.reset();
    refresh();
  } catch (err) {
    toast(err.message);
  }
});

// --- public status page ------------------------------------------------------------

async function showStatusPage(slug) {
  show("status-view");
  const render = async () => {
    try {
      const page = await api("GET", `/status/${slug}`);
      $("#status-view").innerHTML = `
        <div class="card status-hero">
          <h1>${esc(page.name)}</h1>
          <div class="banner ${page.overall}">${page.overall === "operational" ? "All systems operational" : "Some systems are down"}</div>
        </div>
        <div class="card"><ul class="status-list">${page.monitors.map((m) => `
          <li><span class="dot ${m.status}"></span><span class="grow">${esc(m.name)}</span>
          <span class="muted small">${pct(m.uptimePercent)} uptime (24h)</span><span class="badge ${m.status}">${m.status}</span></li>`).join("")
          || `<li class="muted">Nothing is being monitored yet</li>`}</ul>
          <p class="muted small">Updated ${ago(page.generatedAt)}. Refreshes automatically.</p></div>`;
    } catch (err) {
      $("#status-view").innerHTML = `<div class="card">${esc(err.message)}</div>`;
    }
  };
  await render();
  state.timer = setInterval(render, 10000);
}

boot();
