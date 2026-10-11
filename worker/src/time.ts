const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export type JerusalemParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
};

export function jerusalemParts(date: Date): JerusalemParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    weekday: WEEKDAY[get("weekday")] ?? 0,
  };
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function jerusalemLabel(date: Date): string {
  const p = jerusalemParts(date);
  return `${pad2(p.day)}/${pad2(p.month)}/${p.year} ${pad2(p.hour)}:${pad2(p.minute)}`;
}

const HEB_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];

function dateKey(p: JerusalemParts): number {
  return Date.UTC(p.year, p.month - 1, p.day);
}

/** Hebrew relative time for a unix timestamp (seconds or milliseconds). */
export function whenLabel(ts: number, now: Date): string {
  const sec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
  const t = new Date(sec * 1000);
  const tp = jerusalemParts(t);
  const np = jerusalemParts(now);
  const dd = Math.round((dateKey(tp) - dateKey(np)) / 86400000);
  const hm = `${pad2(tp.hour)}:${pad2(tp.minute)}`;
  if (dd === 0) return `היום ${hm}`;
  if (dd === 1) return `מחר ${hm}`;
  return `יום ${HEB_DAYS[tp.weekday]} ${pad2(tp.day)}/${pad2(tp.month)} ${hm}`;
}

export function agoLabel(ts: number | undefined, now: Date): string {
  if (!ts) return "";
  const sec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
  const t = new Date(sec * 1000);
  const s = (now.getTime() - t.getTime()) / 1000;
  if (s < 0) return jerusalemLabel(t);
  if (s < 3600) return `לפני ${Math.max(0, Math.floor(s / 60))} דק׳`;
  if (s < 86400) return `לפני ${Math.floor(s / 3600)} שע׳`;
  const p = jerusalemParts(t);
  return `${pad2(p.day)}/${pad2(p.month)}/${p.year}`;
}
