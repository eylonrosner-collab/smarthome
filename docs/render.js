export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

export function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("he-IL", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function renderKpis(snapshot, opts) {
  const showHidden = Boolean(opts?.showHidden);
  const devices = (snapshot.sections || []).flatMap((s) => s.devices || []).filter((d) => showHidden || !d.hidden);
  const online = devices.filter((d) => d.online).length;
  return [
    kpi("מכשירים", devices.length),
    kpi("מחוברים", online),
    kpi("מנותקים", devices.length - online),
    kpi("אזורי השקיה", snapshot.stats?.zones ?? 0),
  ].join("");
}

function kpi(label, value) {
  return `<div class="kpi"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

export function renderHome(snapshot, rules, opts) {
  const showHidden = Boolean(opts?.showHidden);
  const scenes = (rules || []).filter((r) => r.enabled && r.trigger?.type === "manual");
  const sceneRow = scenes.length
    ? `<div class="scenes" aria-label="סצנות">${scenes
        .map((r) => `<button type="button" class="scene" data-run-rule="${esc(r.id)}">${esc(r.name)}</button>`)
        .join("")}</div>`
    : "";
  const errors = (snapshot.errors || []).map((e) => `<div class="err">${esc(e)}</div>`).join("");
  const sections = (snapshot.sections || []).map((section) => renderSection(section, showHidden)).filter(Boolean).join("");
  const empty = sections ? "" : `<div class="empty">אין מכשירים להצגה</div>`;
  return `${errors}${sceneRow}${sections}${empty}`;
}

function renderSection(section, showHidden) {
  const devices = (section.devices || []).filter((d) => showHidden || !d.hidden);
  const zones = section.zones || [];
  if (!devices.length && !zones.length) return "";
  const online = devices.filter((d) => d.online).length;
  const count = devices.length ? `<span class="cnt">${online}/${devices.length} מחוברים</span>` : "";
  const sub = section.subtitle ? `<p class="sub">${esc(section.subtitle)}</p>` : "";
  const zoneHtml = zones.map(renderZone).join("");
  const deviceHtml = devices.map((device) => renderDevice(device, showHidden)).join("");
  return `<section><h2>${esc(section.icon)} ${esc(section.title)} ${count}</h2>${sub}<div class="grid">${zoneHtml}${deviceHtml}</div></section>`;
}

function renderZone(zone) {
  const controls = zone.relayId == null
    ? `<p class="muted">אין מזהה אזור לשליטה</p>`
    : `<div class="controls" data-zone="${esc(zone.relayId)}">
        <label class="minutes">דקות<input type="number" min="1" max="180" value="10" inputmode="numeric" data-minutes></label>
        <button type="button" class="btn primary" data-zone-action="run">השקיה</button>
        <button type="button" class="btn" data-zone-action="stop">עצירה</button>
        <label class="minutes">השהיה
          <select data-hours>
            <option value="6">6 שע׳</option>
            <option value="12">12 שע׳</option>
            <option value="24" selected>יום</option>
            <option value="48">יומיים</option>
            <option value="168">שבוע</option>
          </select>
        </label>
        <button type="button" class="btn" data-zone-action="suspend">השהיה</button>
        <button type="button" class="btn ghost" data-zone-action="resume">חידוש תזמון</button>
      </div>`;
  return `<article class="card zone ${zone.running ? "active" : ""}">
    <div class="head"><span class="ico">${/lawn/i.test(zone.name) ? "🌿" : "💧"}</span>
      <div class="t"><h3>${esc(zone.name)}</h3><small>אזור ${esc(zone.relay)} · Hydrawise</small></div>
      <span class="pill ${zone.running ? "water" : "off"}">${esc(zone.stateLabel)}</span></div>
    <div class="body">
      ${row(zone.running ? "סטטוס" : "הפעלה הבאה", zone.nextLabel, true)}
      ${row("משך", zone.durationLabel)}
      ${row("מחזור", zone.periodLabel)}
      ${zone.staleLabel ? `<p class="stale">${esc(zone.staleLabel)}</p>` : ""}
    </div>
    ${controls}
  </article>`;
}

function renderDevice(device, showHidden) {
  const badge = device.online
    ? `<span class="badge on">מחובר</span>`
    : `<span class="badge off">מנותק</span>`;
  const hiddenFlag = device.hidden ? `<span class="hidden-flag">מוסתר</span>` : "";
  const rows = (device.rows || []).map((r) => {
    const extra = r.label === "לחות קרקע" || r.label === "מיקום" ? bar(r.value) : "";
    return `${row(r.label, r.value)}${extra}`;
  }).join("");
  const switches = (device.switches || []).map((sw) => channelRow(device.id, sw, showHidden)).join("");
  const dimmers = (device.dimmers || []).map((d) => dimmer(device.id, d, showHidden)).join("");
  const curtain = device.curtain ? curtainControls(device) : "";
  const ac = device.ac ? acControls(device) : "";
  const note = device.readOnlyNote ? `<p class="muted">${esc(device.readOnlyNote)}</p>` : "";
  const stale = device.staleText ? `<p class="stale">${esc(device.staleText)}</p>` : "";
  return `<article class="card ${device.online ? "" : "offline"} ${device.hidden ? "is-hidden" : ""}" data-device-card="${esc(device.id)}" ${device.hidden ? "data-hidden-device" : ""}>
    <div class="head"><span class="ico">${esc(device.icon || "🔧")}</span>
      <div class="t">
        <div class="name-line"><h3>${esc(device.name)}</h3>
          <button type="button" class="icon-btn" data-rename-device="${esc(device.id)}" aria-label="שינוי שם">✎</button>
        </div>
        <small>${esc(device.subtitle || device.kindLabel || "")}</small>
      </div>
      <div class="badges">${hiddenFlag}${badge}</div></div>
    <div class="body">${rows}${note}</div>
    ${switches}${dimmers}${curtain}${ac}
    ${stale}
    <div class="card-tools">
      <button type="button" class="icon-btn" data-hide-device="${esc(device.id)}">${device.hidden ? "הצג" : "הסתר"}</button>
    </div>
  </article>`;
}

function channelRow(deviceId, sw, showHidden) {
  if (sw.hidden && !showHidden) return "";
  const hideLabel = sw.hidden ? "הצג" : "הסתר";
  return `<div class="gang-row ${sw.hidden ? "is-hidden" : ""}" data-channel="${esc(sw.code)}" ${sw.hidden ? "data-hidden-channel" : ""}>
    <button type="button" class="switch ${sw.on ? "is-on" : ""}" role="switch" aria-checked="${sw.on ? "true" : "false"}" data-toggle data-device="${esc(deviceId)}" data-code="${esc(sw.code)}">
      <span>${esc(sw.label)}</span>${sw.hidden ? `<em class="hidden-flag">מוסתר</em>` : ""}<i aria-hidden="true"></i>
    </button>
    <button type="button" class="icon-btn" data-rename-channel data-device="${esc(deviceId)}" data-code="${esc(sw.code)}" aria-label="שינוי שם">✎</button>
    <button type="button" class="icon-btn" data-hide-channel data-device="${esc(deviceId)}" data-code="${esc(sw.code)}">${hideLabel}</button>
  </div>`;
}

function dimmer(deviceId, d, showHidden) {
  if (d.hidden && !showHidden) return "";
  const pct = d.percent == null ? "" : `<small>${esc(d.percent)}%</small>`;
  const range = d.brightCode
    ? `<label class="range">בהירות<input type="range" min="1" max="100" value="${esc(d.percent ?? 50)}" data-bright-range data-device="${esc(deviceId)}" data-code="${esc(d.code)}"></label>`
    : "";
  return `${channelRow(deviceId, d, true)}${pct ? `<div class="dim-pct">${pct}</div>` : ""}${range}`;
}

function curtainControls(device) {
  const pos = device.curtain.position;
  const slider = pos == null
    ? ""
    : `<label class="range">מיקום ${esc(pos)}%<input type="range" min="0" max="100" value="${esc(pos)}" data-curtain-range data-device="${esc(device.id)}"></label>
       <button type="button" class="btn" data-curtain="position" data-device="${esc(device.id)}">הזזה למיקום</button>`;
  return `<div class="controls curtain-controls">
    <button type="button" class="btn" data-curtain="open" data-device="${esc(device.id)}">פתיחה</button>
    <button type="button" class="btn" data-curtain="stop" data-device="${esc(device.id)}">עצירה</button>
    <button type="button" class="btn" data-curtain="close" data-device="${esc(device.id)}">סגירה</button>
    ${slider}
  </div>`;
}

const AC_MODES = [
  ["0", "קירור"],
  ["1", "חימום"],
  ["2", "אוטומטי"],
  ["3", "מאוורר"],
  ["4", "ייבוש"],
];
const AC_WINDS = [
  ["0", "אוטומטי"],
  ["1", "נמוך"],
  ["2", "בינוני"],
  ["3", "גבוה"],
];

function acControls(device) {
  const ac = device.ac;
  const modes = AC_MODES.map(([v, label]) => chip("data-ac-mode", v, label, ac.mode === v, device.id)).join("");
  const winds = AC_WINDS.map(([v, label]) => chip("data-ac-wind", v, label, ac.wind === v, device.id)).join("");
  return `<div class="controls ac" data-ac-device="${esc(device.id)}" data-power="${ac.power ? "1" : "0"}" data-ac-state-mode="${esc(ac.mode)}" data-ac-state-temp="${esc(ac.temp)}" data-ac-state-wind="${esc(ac.wind)}">
    <button type="button" class="btn ${ac.power ? "primary" : ""}" data-ac-power data-device="${esc(device.id)}">${ac.power ? "כיבוי" : "הדלקה"}</button>
    <div class="temp"><button type="button" data-temp-step="-1" data-device="${esc(device.id)}" aria-label="הורדת טמפרטורה">−</button><b>${esc(ac.temp)}°</b><button type="button" data-temp-step="1" data-device="${esc(device.id)}" aria-label="העלאת טמפרטורה">+</button></div>
    <div class="chips" role="group" aria-label="מצב">${modes}</div>
    <div class="chips" role="group" aria-label="מאוורר">${winds}</div>
  </div>`;
}

function chip(attr, value, label, on, deviceId) {
  return `<button type="button" class="chip ${on ? "is-on" : ""}" ${attr}="${esc(value)}" data-device="${esc(deviceId)}">${esc(label)}</button>`;
}

function row(label, value, strong) {
  const inner = strong ? `<b>${esc(value)}</b>` : esc(value);
  return `<div class="row"><span>${esc(label)}</span><bdi>${inner}</bdi></div>`;
}

function bar(value) {
  const n = Math.max(0, Math.min(100, parseFloat(value) || 0));
  return `<div class="bar" aria-hidden="true"><i style="width:${n}%"></i></div>`;
}

export function renderRuleList(rules) {
  if (!rules.length) return `<div class="empty">עדיין אין תרחישים. כתבו אחד למעלה.</div>`;
  return rules.map(renderRule).join("");
}

function renderRule(rule) {
  const kind = rule.trigger?.type === "manual" ? "סצנה" : rule.trigger?.type === "time" ? "שעה" : "חיישן";
  return `<article class="card rule" data-rule="${esc(rule.id)}">
    <div class="head">
      <div class="t"><h3>${esc(rule.name)}</h3><small>${kind}${rule.enabled ? "" : " · מושבת"}</small></div>
      <button type="button" class="switch mini ${rule.enabled ? "is-on" : ""}" role="switch" aria-checked="${rule.enabled ? "true" : "false"}" data-rule-enabled data-rule="${esc(rule.id)}" aria-label="הפעלת תרחיש"><i></i></button>
    </div>
    <p class="summary">${esc(rule.summaryHe || "")}</p>
    <div class="rule-actions">
      <button type="button" class="btn primary" data-run-rule="${esc(rule.id)}">הפעלה</button>
      <button type="button" class="btn" data-edit-rule="${esc(rule.id)}">עריכה</button>
      <button type="button" class="btn danger" data-delete-rule="${esc(rule.id)}">מחיקה</button>
    </div>
  </article>`;
}

export function renderPreview(preview) {
  if (!preview) return "";
  const issues = (preview.issues || []).map((i) => `<p class="warn">${esc(i)}</p>`).join("");
  const note = preview.usedFallback
    ? "המודל לא ענה, אז זה פענוח מקומי. אשרו רק אם הניסוח נכון."
    : preview.parsedBy === "ai"
      ? "תורגם באמצעות מודל שפה. אשרו רק אם זה מה שהתכוונתם."
      : "פענוח אוטומטי. אשרו רק אם זה מה שהתכוונתם.";
  const canSave = !(preview.issues || []).length;
  return `<div class="preview">
    <h3>זה מה שהבנתי</h3>
    <p>${esc(preview.summaryHe || "")}</p>
    ${issues}
    <p class="muted">${note}</p>
    <div class="rule-actions">
      <button type="button" class="btn primary" id="save-rule" ${canSave ? "" : "disabled"}>שמירה</button>
      <button type="button" class="btn" id="cancel-preview">ביטול</button>
    </div>
  </div>`;
}

export function renderActivity(events) {
  if (!events?.length) return `<div class="empty">עדיין אין פעילות. תרחישים שרצים והפעלות ידניות יופיעו כאן.</div>`;
  return `<ol class="log">${events
    .map((e) => `<li class="${e.ok ? "ok" : "bad"}">
      <time datetime="${esc(e.at)}">${esc(formatWhen(e.at))}</time>
      <div><b>${esc(e.ruleName || (e.ok ? "פעולה" : "שגיאה"))}</b><p>${esc(e.message)}</p></div>
    </li>`)
    .join("")}</ol>`;
}
