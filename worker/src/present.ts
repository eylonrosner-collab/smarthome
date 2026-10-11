import { agoLabel } from "./time";
import type { CatalogItem, DeviceView, SectionId, TuyaDevice } from "./types";

const CAT_ICON: Record<string, string> = {
  kg: "💡",
  tgkg: "🔆",
  tdq: "🔌",
  clkg: "🪟",
  qt: "❄️",
  wnykq: "📡",
  wg2: "📶",
  mzj: "🍲",
};

const CAT_LABEL: Record<string, string> = {
  kg: "מתג חכם",
  tgkg: "דימר",
  tdq: "מפסק WiFi",
  clkg: "מתג תריס",
  qt: "מזגן (IR)",
  wnykq: "שלט IR",
  wg2: "Gateway Zigbee",
  mzj: "ISV-100W (סו-ויד)",
};

const AC_MODE: Record<string, string> = {
  "0": "קירור",
  "1": "חימום",
  "2": "אוטומטי",
  "3": "מאוורר",
  "4": "ייבוש",
};

const AC_WIND: Record<string, string> = {
  "0": "אוטומטי",
  "1": "נמוך",
  "2": "בינוני",
  "3": "גבוה",
};

const CTRL: Record<string, string> = {
  open: "נפתח",
  close: "נסגר",
  stop: "עצור",
  continue: "ממשיך",
};

const WORK: Record<string, string> = {
  stop: "עצור",
  complete: "הסתיים",
  cooking: "מבשל",
  preheat: "חימום מקדים",
};

const GENERIC = /^(switch\s*\d*|.*smart swi.*)$/i;

export const SOIL_CATEGORIES = new Set(["zwjcy", "sms", "trsq", "smsj", "soil", "ldcg"]);

const MOISTURE_CODES = ["soil_humidity", "humidity", "humidity_value", "moisture", "soilhumidity", "humidity_current"];
const TEMP_CODES = ["temp_current", "va_temperature", "temp_value", "temperature", "temp"];
const BATT_CODES = ["battery_percentage", "battery", "va_battery", "battery_state", "residual_electricity"];

export function isOn(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    return s === "1" || s === "true" || s === "on";
  }
  return false;
}

export function deviceTitle(d: TuyaDevice): string {
  const custom = (d.customName || "").trim();
  return custom || d.name || d.id;
}

export function isSoilSensor(d: { category?: string; name?: string; customName?: string; productName?: string }, status?: Record<string, unknown> | null): boolean {
  const cat = String(d.category || "").toLowerCase();
  if (SOIL_CATEGORIES.has(cat)) return true;
  const blob = `${d.customName || ""} ${d.name || ""} ${d.productName || ""} ${cat}`.toLowerCase();
  if (/soil|moisture|אדמ|לחות קרקע|חיישן לחות/.test(blob)) return true;
  if (status && MOISTURE_CODES.some((c) => c in status && /soil|zwj|sms/.test(cat))) return true;
  return false;
}

export function sectionOf(d: TuyaDevice, status?: Record<string, unknown> | null): SectionId {
  if (isSoilSensor(d, status)) return "garden";
  const c = String(d.category || "");
  const n = `${d.customName || ""} ${d.name || ""}`;
  if (n.includes("שביל") || n.includes("גינה")) return "garden";
  if (c === "qt" || c === "wnykq") return "climate";
  if (c === "clkg") return "curtains";
  if (n.toLowerCase().includes("boiler") || n.includes("דוד")) return "power";
  if (c === "kg" || c === "tgkg") return "lights";
  if (c === "tdq") return "power";
  return "other";
}

function gname(names: Record<string, string>, code: string, i: number): string {
  const n = names[code] || "";
  return n && !GENERIC.test(n) ? n : `מתג ${i}`;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function scalePercent(code: string, value: number): number {
  if (code === "battery_percentage" || code === "battery") {
    return value > 100 && value <= 1000 ? Math.round(value / 10) : Math.round(value);
  }
  if (value > 100 && value <= 1000) return Math.round((value / 10) * 10) / 10;
  if (value > 1000 && value <= 10000) return Math.round((value / 100) * 10) / 10;
  return Math.round(value * 10) / 10;
}

function scaleTemp(code: string, value: number): number {
  if ((code === "temp_current" || code === "va_temperature" || code === "temp_value") && Math.abs(value) > 80) {
    return Math.round(value) / 10;
  }
  if (Math.abs(value) > 80) return Math.round(value) / 10;
  return Math.round(value * 10) / 10;
}

function firstCode(status: Record<string, unknown>, codes: string[]): { code: string; value: unknown } | null {
  for (const code of codes) {
    if (code in status && status[code] != null && status[code] !== "") return { code, value: status[code] };
  }
  return null;
}

function soilMetrics(status: Record<string, unknown>): NonNullable<DeviceView["metrics"]> {
  const metrics: NonNullable<DeviceView["metrics"]> = {};
  const m = firstCode(status, MOISTURE_CODES);
  if (m) {
    const n = num(m.value);
    if (n != null) metrics.moisture = scalePercent(m.code, n);
  }
  const t = firstCode(status, TEMP_CODES);
  if (t) {
    const n = num(t.value);
    if (n != null) metrics.temperature = scaleTemp(t.code, n);
  }
  const b = firstCode(status, BATT_CODES);
  if (b) {
    if (typeof b.value === "string" && Number.isNaN(Number(b.value))) {
      const map: Record<string, string> = { low: "נמוכה", middle: "בינונית", high: "גבוהה" };
      metrics.battery = map[b.value.toLowerCase()] || b.value;
    } else {
      const n = num(b.value);
      if (n != null) metrics.battery = scalePercent(b.code, n);
    }
  }
  return metrics;
}

export function presentDevice(
  device: TuyaDevice,
  status: Record<string, unknown> | null,
  names: Record<string, string>,
  now: Date,
  link?: { infraredId?: string; remoteId?: string },
): DeviceView {
  const category = String(device.category || "");
  const online = Boolean(device.isOnline ?? device.online);
  const name = deviceTitle(device);
  const productName = String(device.productName || "");
  const kindLabel = isSoilSensor(device, status) ? "חיישן לחות קרקע" : CAT_LABEL[category] || productName || category || "מכשיר";
  let subtitle = kindLabel;
  if (device.customName && device.customName !== device.name && device.name) subtitle += ` · ${device.name}`;
  const section = sectionOf(device, status);
  const rows: DeviceView["rows"] = [];
  const switches: DeviceView["switches"] = [];
  const dimmers: DeviceView["dimmers"] = [];
  let curtain: DeviceView["curtain"];
  let ac: DeviceView["ac"];
  let metrics: DeviceView["metrics"];
  let readOnlyNote: string | undefined;
  const soil = isSoilSensor(device, status);

  if (status == null) {
    readOnlyNote = "לא ניתן לקרוא סטטוס";
  } else if (soil) {
    metrics = soilMetrics(status);
    if (metrics.moisture != null) rows.push({ label: "לחות קרקע", value: `${metrics.moisture}%` });
    if (metrics.temperature != null) rows.push({ label: "טמפרטורה", value: `${metrics.temperature}°` });
    if (metrics.battery != null) rows.push({ label: "סוללה", value: typeof metrics.battery === "number" ? `${metrics.battery}%` : String(metrics.battery) });
    if (!rows.length) {
      for (const [k, v] of Object.entries(status).slice(0, 6)) rows.push({ label: k, value: String(v) });
    }
  } else if (category === "kg" || category === "tdq") {
    const gangs = Object.keys(status).filter((k) => /^switch_\d+$/.test(k)).sort();
    gangs.forEach((k, idx) => {
      const on = isOn(status[k]);
      switches.push({ code: k, label: gangs.length > 1 ? gname(names, k, idx + 1) : "הפעלה", on });
    });
    if ("cur_power" in status) {
      const power = num(status.cur_power);
      if (power != null) rows.push({ label: "הספק", value: `${(power / 10).toFixed(0)} W` });
      const voltage = num(status.cur_voltage);
      const current = num(status.cur_current);
      if (voltage != null || current != null) {
        rows.push({
          label: "מתח / זרם",
          value: `${voltage != null ? (voltage / 10).toFixed(1) : "—"}V · ${current != null ? (current / 1000).toFixed(2) : "—"}A`,
        });
      }
      const ele = num(status.add_ele);
      if (ele != null) rows.push({ label: "צריכה מצטברת", value: `${(ele / 1000).toFixed(1)} kWh` });
    }
    if (status.fault) rows.push({ label: "תקלה", value: String(status.fault) });
  } else if (category === "tgkg") {
    let i = 1;
    while (`switch_led_${i}` in status) {
      const code = `switch_led_${i}`;
      const brightCode = `bright_value_${i}`;
      const b = num(status[brightCode]);
      const percent = b == null ? undefined : Math.round((b / 1000) * 100);
      const on = isOn(status[code]);
      dimmers.push({ code, label: gname(names, code, i), on, percent, brightCode: b == null ? undefined : brightCode });
      i += 1;
    }
  } else if (category === "clkg") {
    const pos = num(status.percent_state ?? status.percent_control);
    curtain = {
      position: pos,
      motor: CTRL[String(status.control)] || (status.control != null ? String(status.control) : undefined),
      travelSeconds: num(status.tr_timecon),
    };
    if (pos != null) rows.push({ label: "מיקום", value: `${pos}% פתוח` });
    if (curtain.motor) rows.push({ label: "מצב מנוע", value: curtain.motor });
    if (curtain.travelSeconds != null) rows.push({ label: "זמן מהלך", value: `${curtain.travelSeconds} שנ׳` });
  } else if (category === "qt") {
    const mode = String(status.mode ?? "0");
    const wind = String(status.wind ?? "0");
    const temp = num(status.temp) ?? 24;
    ac = {
      power: isOn(status.power),
      mode,
      temp,
      wind,
      infraredId: link?.infraredId,
      remoteId: link?.remoteId,
    };
    rows.push({ label: "מצב", value: AC_MODE[mode] || mode });
    rows.push({ label: "טמפרטורה", value: `${temp}°C` });
    rows.push({ label: "מאוורר", value: AC_WIND[wind] || wind });
  } else if (category === "mzj") {
    const on = isOn(status.PowerOnOff);
    switches.push({ code: "PowerOnOff", label: "הפעלה", on });
    if (status.WorkStatus != null) rows.push({ label: "סטטוס", value: WORK[String(status.WorkStatus)] || String(status.WorkStatus) });
    const show = num(status.TempShow);
    const set = num(status.TempSet);
    if (show != null || set != null) {
      rows.push({
        label: "טמפ׳ נוכחית / יעד",
        value: `${show != null ? (show / 10).toFixed(1) : "—"}° / ${set != null ? (set / 10).toFixed(1) : "—"}°`,
      });
    }
  } else if (category === "wnykq") {
    readOnlyNote = "שלט IR – המזגן נשלט מהכרטיס של המזגן";
  } else if (category === "wg2") {
    readOnlyNote = "Gateway – אין נתוני סטטוס";
  } else {
    const gangs = Object.keys(status).filter((k) => /^switch_\d+$/.test(k)).sort();
    gangs.forEach((k, idx) => {
      switches.push({ code: k, label: gangs.length > 1 ? gname(names, k, idx + 1) : "הפעלה", on: isOn(status[k]) });
    });
    const skip = new Set(gangs);
    for (const [k, v] of Object.entries(status)) {
      if (skip.has(k) || rows.length >= 5) break;
      rows.push({ label: k, value: String(v) });
    }
  }

  const staleText = online ? undefined : `ערכים אחרונים ידועים · נראה לאחרונה ${agoLabel(device.updateTime, now) || "—"}`;
  return {
    id: device.id,
    name,
    productName,
    category,
    online,
    icon: soil ? "🌱" : CAT_ICON[category] || "🔧",
    kindLabel,
    subtitle,
    section,
    staleText,
    rows,
    switches,
    dimmers,
    curtain,
    ac,
    metrics,
    readOnlyNote,
    soil,
  };
}

export function catalogItemFromDevice(d: DeviceView): CatalogItem {
  const metrics: string[] = [];
  if (d.metrics?.moisture != null) metrics.push("moisture");
  if (d.metrics?.temperature != null) metrics.push("temperature");
  if (d.metrics?.battery != null) metrics.push("battery");
  if (d.soil && !metrics.includes("moisture")) metrics.push("moisture");
  return {
    kind: "device",
    id: d.id,
    name: d.name,
    category: d.category,
    section: d.section,
    switches: [...d.switches, ...d.dimmers].map((s) => ({ code: s.code, label: s.label })),
    infraredId: d.ac?.infraredId,
    remoteId: d.ac?.remoteId,
    metrics: metrics.length ? metrics : undefined,
    curtain: Boolean(d.curtain) || d.category === "clkg",
    ac: Boolean(d.ac) || d.category === "qt",
    dimmer: d.dimmers.length > 0 || d.category === "tgkg",
  };
}
