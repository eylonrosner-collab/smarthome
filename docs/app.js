import { WORKER_URL } from "./config.js";
import { mockEvents, mockRules, mockSnapshot } from "./mock.js";
import { renderActivity, renderHome, renderKpis, renderPreview, renderRuleList } from "./render.js";

const KEY = "smarthome.password";
const EXAMPLES = [
  "כשלחות הקרקע מתחת ל-30% השקה את Back Lawn ל-10 דקות",
  "כל יום ב-19:00 סגור את תריסי הסלון והדלק תאורת שביל",
  "סצנה: ערב סרט",
];

const state = {
  mock: false,
  snapshot: null,
  rules: [],
  events: [],
  tab: location.hash.replace("#", "") || "home",
  preview: null,
  editingId: null,
  showHidden: readShowHidden(),
  holdUntil: 0,
};

const $ = (id) => document.getElementById(id);

function readShowHidden() {
  try { return localStorage.getItem("smarthome.showHidden") === "1"; } catch { return false; }
}

function workerReady() {
  return /^https:\/\//.test(WORKER_URL) && !WORKER_URL.includes("YOUR-SUBDOMAIN");
}

function base() {
  return WORKER_URL.replace(/\/$/, "");
}

function showLock(message) {
  $("app").hidden = true;
  $("lock").hidden = false;
  const err = $("login-error");
  if (message) {
    err.hidden = false;
    err.textContent = message;
  }
}

function showApp() {
  $("lock").hidden = true;
  $("app").hidden = false;
  const note = $("banner");
  if (state.mock) {
    note.hidden = false;
    note.textContent = "תצוגת הדגמה עם נתונים לדוגמה. אחרי פריסת ה-Worker והגדרת הכתובת ב-config.js הלוח מתחבר לבית.";
  } else {
    note.hidden = true;
  }
  paint();
}

function toast(message) {
  const el = $("toast");
  el.hidden = false;
  el.textContent = message;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2400);
}

function paint() {
  const y = window.scrollY;
  $("meta").textContent = state.mock ? `הדגמה · ${state.snapshot.updatedLabel}` : state.snapshot?.updatedLabel || "";
  const view = { showHidden: state.showHidden };
  $("kpis").innerHTML = state.snapshot ? renderKpis(state.snapshot, view) : "";
  $("view-home").innerHTML = state.snapshot ? renderHome(state.snapshot, state.rules, view) : "";
  const hiddenBtn = $("show-hidden");
  if (hiddenBtn) {
    hiddenBtn.setAttribute("aria-pressed", state.showHidden ? "true" : "false");
    hiddenBtn.classList.toggle("is-on", state.showHidden);
  }
  $("rule-list").innerHTML = renderRuleList(state.rules);
  $("preview").innerHTML = renderPreview(state.preview);
  $("view-log").innerHTML = renderActivity(state.events);
  setTab(state.tab);
  window.scrollTo(0, y);
}

function setTab(tab) {
  state.tab = ["home", "rules", "log"].includes(tab) ? tab : "home";
  $("view-home").hidden = state.tab !== "home";
  $("view-rules").hidden = state.tab !== "rules";
  $("view-log").hidden = state.tab !== "log";
  for (const btn of document.querySelectorAll("[data-tab]")) {
    btn.classList.toggle("is-on", btn.dataset.tab === state.tab);
  }
  if (location.hash !== `#${state.tab}`) history.replaceState(null, "", `#${state.tab}`);
}

async function api(path, opts = {}) {
  const res = await fetch(base() + path, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${localStorage.getItem(KEY) || ""}`,
    },
    body: opts.body == null ? undefined : JSON.stringify(opts.body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    localStorage.removeItem(KEY);
    showLock("הסיסמה לא מתאימה. נסו שוב.");
    throw new Error("סיסמה שגויה");
  }
  if (!res.ok) throw new Error(data.error || "הבקשה נכשלה");
  return data;
}

async function refresh(fresh) {
  if (state.mock) return;
  const snap = await api(`/api/snapshot${fresh ? "?fresh=1" : ""}`);
  state.rules = (await api("/api/rules")).rules || [];
  state.events = (await api("/api/activity")).events || [];
  if (!(state.holdUntil && Date.now() < state.holdUntil)) {
    state.snapshot = snap;
    state.holdUntil = 0;
  }
  paint();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function enterMock() {
  state.mock = true;
  state.snapshot = clone(mockSnapshot);
  state.rules = clone(mockRules);
  state.events = clone(mockEvents);
  showApp();
}

function findDevice(id) {
  for (const section of state.snapshot.sections) {
    const device = section.devices.find((d) => d.id === id);
    if (device) return device;
  }
  return null;
}

function findZone(relayId) {
  for (const section of state.snapshot.sections) {
    const zone = section.zones.find((z) => String(z.relayId) === String(relayId));
    if (zone) return zone;
  }
  return null;
}

async function sendCommand(path, body, apply) {
  if (state.mock) {
    apply();
    paint();
    toast("עודכן בתצוגת ההדגמה");
    return;
  }
  await api(path, { method: "POST", body });
  state.holdUntil = Date.now() + 60_000;
  apply();
  paint();
  toast("הפקודה נשלחה");
}

function demoPreview(text) {
  const t = text.trim();
  if (/לחות|moisture/i.test(t) && /30/.test(t) && /back lawn/i.test(t)) {
    return draft(t, "השקיה · Back Lawn", "sensor", "כאשר לחות הקרקע בחיישן הלחות מתחת ל-30%. פעולות: השקיית Back Lawn ל-10 דקות. המתנה של 180 דקות בין הפעלות, כדי שלא יופעל שוב כל עוד התנאי עדיין מתקיים.");
  }
  if (/19:00/.test(t) && /תריס|shutter|סלון|living room/i.test(t)) {
    return draft(t, "שגרה 19:00", "time", "כל יום בשעה 19:00 (שעון ישראל). פעולות: סגירת תריס סלון, תריס סלון חדש; הדלקת תאורת שביל.");
  }
  if (/סצנה|scene/i.test(t) && /סרט|movie/i.test(t)) {
    return draft(t, "ערב סרט", "manual", "סצנה ידנית «ערב סרט». מופעלת רק בלחיצה. פעולות: סגירת תריסי הסלון וכיבוי תאורת הסלון.");
  }
  return {
    summaryHe: "",
    issues: ["בתצוגת הדגמה אפשר לנסות את שלוש הדוגמאות. אחרי הפריסה, המודל מפרש כל משפט."],
    parsedBy: "local",
    usedFallback: false,
    draft: null,
  };
}

function draft(sourceText, name, type, summaryHe) {
  return {
    summaryHe,
    issues: [],
    parsedBy: "local",
    usedFallback: false,
    draft: {
      name,
      enabled: true,
      sourceText,
      summaryHe,
      cooldownMinutes: type === "sensor" ? 180 : type === "time" ? 10 : 0,
      trigger: { type },
      conditions: [],
      actions: [{ type: "switch", on: true }],
      parsedBy: "local",
    },
  };
}

function logLocal(ok, message, rule) {
  state.events.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ok,
    message,
    ruleName: rule?.name,
  });
}

function applyMovie() {
  for (const id of ["dev-curtain-salon-new", "dev-curtain-salon-a", "dev-curtain-salon-b"]) {
    const device = findDevice(id);
    if (!device?.curtain) continue;
    device.curtain.motor = "נסגר";
    device.rows = device.rows.map((r) => (r.label === "מצב מנוע" ? { ...r, value: "נסגר" } : r));
  }
  const lights = findDevice("dev-salon-lights");
  if (lights) lights.switches.forEach((sw) => { sw.on = false; });
}

async function runRule(id) {
  const rule = state.rules.find((r) => r.id === id);
  if (!rule) return;
  if (state.mock) {
    if (rule.id === "rule-movie" || /סרט|movie/i.test(rule.name)) applyMovie();
    logLocal(true, rule.summaryHe || "הופעל", rule);
    paint();
    toast(`«${rule.name}» הופעל`);
    return;
  }
  const result = await api(`/api/rules/${encodeURIComponent(id)}/run`, { method: "POST", body: {} });
  toast(result.message || "התרחיש הופעל");
  await refresh(true);
}

function wire() {
  $("examples").innerHTML = EXAMPLES.map((ex) => `<button type="button" data-example="${ex}">${ex}</button>`).join("");
  $("show-hidden").addEventListener("click", () => {
    state.showHidden = !state.showHidden;
    try { localStorage.setItem("smarthome.showHidden", state.showHidden ? "1" : "0"); } catch { /* private mode */ }
    paint();
  });
  $("demo-btn").addEventListener("click", () => {
    try {
      enterMock();
    } catch (err) {
      showLock(err.message || "הדגמה נכשלה");
    }
  });
  if (!workerReady()) {
    $("setup-note").hidden = false;
    $("setup-note").textContent = "כתובת ה-Worker עדיין לא הוגדרה ב-config.js. אפשר להיכנס לתצוגת הדגמה, או לעדכן את הכתובת אחרי הפריסה.";
  }
  try {
    if (new URLSearchParams(location.search).get("mock") === "1") enterMock();
    else if (localStorage.getItem(KEY) && workerReady()) {
      refresh(true).then(showApp).catch((err) => showLock(err.message));
    }
  } catch (err) {
    showLock(err.message || "הדגמה נכשלה");
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const password = $("password").value;
    $("login-error").hidden = true;
    if (!workerReady()) {
      showLock("קודם מעדכנים את כתובת ה-Worker. בינתיים אפשר תצוגת הדגמה.");
      return;
    }
    try {
      const res = await fetch(base() + "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "סיסמה שגויה");
      localStorage.setItem(KEY, password);
      await refresh(true);
      showApp();
    } catch (err) {
      showLock(err.message || "לא הצלחנו להתחבר");
    }
  });

  $("logout").addEventListener("click", () => {
    localStorage.removeItem(KEY);
    state.mock = false;
    showLock("");
    $("login-error").hidden = true;
  });
  $("refresh").addEventListener("click", () => {
    if (state.mock) {
      toast("ההדגמה לא מתרעננת מהבית");
      return;
    }
    state.holdUntil = 0;
    refresh(true).then(() => toast("עודכן")).catch((err) => toast(err.message));
  });

  document.body.addEventListener("click", async (event) => {
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      setTab(tab.dataset.tab);
      return;
    }
    const example = event.target.closest("[data-example]");
    if (example) {
      $("rule-text").value = example.dataset.example;
      setTab("rules");
      return;
    }
    if (!state.snapshot) return;
    try {
      await onAction(event);
    } catch (err) {
      toast(err.message || "שגיאה");
    }
  });

  $("parse-btn").addEventListener("click", async () => {
    const text = $("rule-text").value.trim();
    if (!text) return toast("כתבו תרחיש");
    try {
      if (state.mock) state.preview = demoPreview(text);
      else state.preview = await api("/api/rules/preview", { method: "POST", body: { text } });
      $("preview").innerHTML = renderPreview(state.preview);
    } catch (err) {
      toast(err.message);
    }
  });

  $("preview").addEventListener("click", async (event) => {
    if (event.target.id === "cancel-preview") {
      state.preview = null;
      state.editingId = null;
      $("preview").innerHTML = "";
      return;
    }
    if (event.target.id !== "save-rule" || !state.preview?.draft) return;
    try {
      if (state.mock) {
        const rule = { ...state.preview.draft, id: state.editingId || crypto.randomUUID(), enabled: true };
        if (state.editingId) state.rules = state.rules.map((r) => (r.id === rule.id ? rule : r));
        else state.rules.unshift(rule);
        logLocal(true, `נשמר תרחיש «${rule.name}»`, rule);
      } else if (state.editingId) {
        await api(`/api/rules/${encodeURIComponent(state.editingId)}`, { method: "PUT", body: { draft: state.preview.draft } });
      } else {
        await api("/api/rules", { method: "POST", body: { draft: state.preview.draft } });
      }
      state.preview = null;
      state.editingId = null;
      $("rule-text").value = "";
      if (!state.mock) await refresh(false);
      else paint();
      toast("התרחיש נשמר");
    } catch (err) {
      toast(err.message);
    }
  });

  window.addEventListener("hashchange", () => setTab(location.hash.replace("#", "")));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.mock && $("app").hidden === false) refresh(false).catch(() => {});
  });
  setInterval(() => {
    if (!document.hidden && !state.mock && !$("app").hidden) refresh(false).catch(() => {});
  }, 60_000);
}

function openRename(slot, value, commit) {
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = value;
  input.maxLength = 40;
  input.enterKeyHint = "done";
  input.setAttribute("aria-label", "שם חדש");
  slot.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    if (!save) {
      paint();
      return;
    }
    commit(input.value.replace(/\s+/g, " ").trim());
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

async function savePref(path, body, apply) {
  apply();
  paint();
  if (state.mock) {
    toast("עודכן בתצוגת ההדגמה");
    return;
  }
  try {
    await api(path, { method: "PUT", body });
    toast("נשמר");
  } catch (err) {
    toast(err.message || "השמירה נכשלה");
    await refresh(false);
  }
}

async function onAction(event) {
  if (event.target.closest("input, textarea, select")) return;
  const renameDevice = event.target.closest("[data-rename-device]");
  if (renameDevice) {
    const device = findDevice(renameDevice.dataset.renameDevice);
    if (!device) return;
    const title = renameDevice.closest(".name-line")?.querySelector("h3");
    if (!title) return;
    openRename(title, device.name, (name) => savePref(
      `/api/prefs/devices/${encodeURIComponent(device.id)}`,
      { name },
      () => { if (name) device.name = name; },
    ).then(() => { if (!name && !state.mock) return refresh(false); if (!name) paint(); }));
    return;
  }

  const renameChannel = event.target.closest("[data-rename-channel]");
  if (renameChannel) {
    const device = findDevice(renameChannel.dataset.device);
    const sw = device && [...device.switches, ...device.dimmers].find((s) => s.code === renameChannel.dataset.code);
    if (!sw) return;
    openRename(renameChannel, sw.label, (name) => savePref(
      `/api/prefs/devices/${encodeURIComponent(device.id)}/channels/${encodeURIComponent(sw.code)}`,
      { name },
      () => { if (name) sw.label = name; },
    ).then(() => { if (!name && !state.mock) return refresh(false); if (!name) paint(); }));
    return;
  }

  const hideDevice = event.target.closest("[data-hide-device]");
  if (hideDevice) {
    const device = findDevice(hideDevice.dataset.hideDevice);
    if (!device) return;
    const hidden = !device.hidden;
    await savePref(`/api/prefs/devices/${encodeURIComponent(device.id)}`, { hidden }, () => { device.hidden = hidden; });
    return;
  }

  const hideChannel = event.target.closest("[data-hide-channel]");
  if (hideChannel) {
    const device = findDevice(hideChannel.dataset.device);
    const sw = device && [...device.switches, ...device.dimmers].find((s) => s.code === hideChannel.dataset.code);
    if (!sw) return;
    const hidden = !sw.hidden;
    await savePref(
      `/api/prefs/devices/${encodeURIComponent(device.id)}/channels/${encodeURIComponent(sw.code)}`,
      { hidden },
      () => { sw.hidden = hidden; },
    );
    return;
  }

  const toggle = event.target.closest("[data-toggle]");
  if (toggle) {
    const device = findDevice(toggle.dataset.device);
    const sw = device && [...device.switches, ...device.dimmers].find((s) => s.code === toggle.dataset.code);
    if (!sw) return;
    const on = !sw.on;
    await sendCommand(`/api/devices/${encodeURIComponent(device.id)}/commands`, {
      commands: [{ code: sw.code, value: on }],
    }, () => { sw.on = on; });
    return;
  }

  const power = event.target.closest("[data-ac-power]");
  const mode = event.target.closest("[data-ac-mode]");
  const wind = event.target.closest("[data-ac-wind]");
  const temp = event.target.closest("[data-temp-step]");
  if (power || mode || wind || temp) {
    const id = (power || mode || wind || temp).dataset.device;
    const device = findDevice(id);
    if (!device?.ac) return;
    const next = { ...device.ac, temp: Number(device.ac.temp) };
    if (power) next.power = !next.power;
    if (mode) next.mode = mode.dataset.acMode;
    if (wind) next.wind = wind.dataset.acWind;
    if (temp) next.temp = Math.min(30, Math.max(16, next.temp + Number(temp.dataset.tempStep)));
    await sendCommand(`/api/devices/${encodeURIComponent(id)}/ac`, {
      power: next.power,
      mode: next.mode,
      temp: next.temp,
      wind: next.wind,
    }, () => {
      device.ac = next;
      device.rows = [
        { label: "מצב", value: modeLabel(next.mode) },
        { label: "טמפרטורה", value: `${next.temp}°C` },
        { label: "מאוורר", value: windLabel(next.wind) },
      ];
    });
    return;
  }

  const curtain = event.target.closest("[data-curtain]");
  if (curtain) {
    const device = findDevice(curtain.dataset.device);
    if (!device) return;
    const command = curtain.dataset.curtain;
    const range = device && document.querySelector(`[data-curtain-range][data-device="${CSS.escape(device.id)}"]`);
    const position = command === "position" ? Number(range?.value ?? device.curtain?.position ?? 0) : undefined;
    const commands = command === "position"
      ? [{ code: "percent_control", value: position }]
      : [{ code: "control", value: command }];
    await sendCommand(`/api/devices/${encodeURIComponent(device.id)}/commands`, { commands }, () => {
      device.curtain = device.curtain || {};
      if (command === "position") device.curtain.position = position;
      else device.curtain.motor = command === "open" ? "נפתח" : command === "close" ? "נסגר" : "עצור";
      const rows = [];
      if (device.curtain.position != null) rows.push({ label: "מיקום", value: `${device.curtain.position}% פתוח` });
      if (device.curtain.motor) rows.push({ label: "מצב מנוע", value: device.curtain.motor });
      device.rows = rows;
    });
    return;
  }

  const zoneBtn = event.target.closest("[data-zone-action]");
  if (zoneBtn) {
    const wrap = zoneBtn.closest("[data-zone]");
    const relayId = wrap.dataset.zone;
    const zone = findZone(relayId);
    const minutes = Number(wrap.querySelector("[data-minutes]")?.value || 10);
    const hours = Number(wrap.querySelector("[data-hours]")?.value || 24);
    const action = zoneBtn.dataset.zoneAction;
    await sendCommand(`/api/zones/${encodeURIComponent(relayId)}/${action}`, { minutes, hours }, () => {
      if (!zone) return;
      if (action === "run") {
        zone.running = true;
        zone.stateLabel = "משקה עכשיו";
        zone.nextLabel = `נותרו כ-${minutes} דק׳`;
      } else if (action === "stop" || action === "resume") {
        zone.running = false;
        zone.stateLabel = action === "stop" ? "נעצר" : "ממתין";
      } else {
        zone.running = false;
        zone.stateLabel = "מושהה";
        zone.nextLabel = `${hours} שע׳`;
      }
    });
    return;
  }

  const run = event.target.closest("[data-run-rule]");
  if (run) return runRule(run.dataset.runRule);

  const edit = event.target.closest("[data-edit-rule]");
  if (edit) {
    const rule = state.rules.find((r) => r.id === edit.dataset.editRule);
    if (!rule) return;
    state.editingId = rule.id;
    $("rule-text").value = rule.sourceText || "";
    setTab("rules");
    $("rule-text").focus();
    return;
  }

  const enabled = event.target.closest("[data-rule-enabled]");
  if (enabled) {
    const rule = state.rules.find((r) => r.id === enabled.dataset.rule);
    if (!rule) return;
    const value = !rule.enabled;
    if (state.mock) {
      rule.enabled = value;
      paint();
      return;
    }
    await api(`/api/rules/${encodeURIComponent(rule.id)}`, { method: "PUT", body: { enabled: value } });
    await refresh(false);
    return;
  }

  const del = event.target.closest("[data-delete-rule]");
  if (del) {
    if (del.dataset.confirm !== "1") {
      del.dataset.confirm = "1";
      del.textContent = "לאשר מחיקה";
      return;
    }
    const id = del.dataset.deleteRule;
    if (state.mock) state.rules = state.rules.filter((r) => r.id !== id);
    else await api(`/api/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!state.mock) await refresh(false);
    else paint();
    toast("התרחיש נמחק");
  }
}

function modeLabel(mode) {
  return { "0": "קירור", "1": "חימום", "2": "אוטומטי", "3": "מאוורר", "4": "ייבוש" }[mode] || mode;
}
function windLabel(wind) {
  return { "0": "אוטומטי", "1": "נמוך", "2": "בינוני", "3": "גבוה" }[wind] || wind;
}

wire();
