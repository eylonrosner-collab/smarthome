import { askWorkersAi } from "./ai";
import { passwordFromRequest, passwordsMatch } from "./auth";
import { validateAcBody, validateCommands } from "./execute";
import { assertSavable, interpretRule, normalizeDraft, type Draft, type Rule } from "./rules";
import { executeSavedRule, runScheduler } from "./scheduler";
import { loadPrefs, readPrefPatch, updateChannelPref, updateDevicePref } from "./prefs";
import { buildSnapshot, invalidateSnapshot } from "./snapshot";
import { appendActivity, loadActivity, loadRules, saveRules } from "./store";
import { TuyaClient, tuyaUserMessage } from "./tuya";
import type { Env, Snapshot } from "./types";
import { recordZoneCommand } from "./hydro-cache";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduler(env));
  },
};

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== env.ALLOWED_ORIGIN) {
    return json({ error: "מקור לא מורשה" }, 403, request, env);
  }
  if (request.method === "OPTIONS") return json({ ok: true }, 204, request, env);
  if (request.method === "GET" && url.pathname === "/") {
    return new Response("לוח הבית נמצא באתר. ממשק ה-API זמין תחת /api ומוגן בסיסמה.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  try {
    const match = matchRoute(request.method, url.pathname);
    if (!match) return json({ error: "לא נמצא" }, 404, request, env);
    if (match.name === "health") return json({ ok: true, service: "smarthome" }, 200, request, env);
    if (match.name === "login") return login(request, env);

    const auth = requireAuth(request, env);
    if (auth) return auth;

    switch (match.name) {
      case "snapshot":
        return json(await buildSnapshot(env, { fresh: url.searchParams.get("fresh") === "1" }), 200, request, env);
      case "commands":
        return deviceCommands(request, env, decodeURIComponent(match.params.id));
      case "ac":
        return acCommand(request, env, decodeURIComponent(match.params.id));
      case "zone":
        return zoneCommand(request, env, Number(match.params.relayId), match.params.action);
      case "preview":
        return previewRule(request, env);
      case "rules":
        return json({ rules: await loadRules(env.RULES) }, 200, request, env);
      case "createRule":
        return createRule(request, env);
      case "updateRule":
        return updateRule(request, env, decodeURIComponent(match.params.id));
      case "deleteRule":
        return deleteRule(env, request, decodeURIComponent(match.params.id));
      case "runRule":
        return runRule(env, request, decodeURIComponent(match.params.id));
      case "activity":
        return json({ events: await loadActivity(env.RULES) }, 200, request, env);
      case "prefs":
        return json(await loadPrefs(env.RULES), 200, request, env);
      case "prefDevice":
        return await putPref(request, env, (patch) => updateDevicePref(env.RULES, decodeURIComponent(match.params.id), patch));
      case "prefChannel":
        return await putPref(request, env, (patch) => updateChannelPref(env.RULES, decodeURIComponent(match.params.id), decodeURIComponent(match.params.code), patch));
      default:
        return json({ error: "לא נמצא" }, 404, request, env);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "שגיאה";
    const status = err instanceof Error && (err.name === "RuleRejected" || err instanceof SyntaxError) ? 400 : 500;
    return json({ error: message }, status, request, env);
  }
}

function requireAuth(request: Request, env: Env): Response | null {
  if (!env.DASH_PASSWORD) return json({ error: "השרת עדיין לא הוגדר" }, 503, request, env);
  if (!passwordsMatch(passwordFromRequest(request), env.DASH_PASSWORD)) {
    return json({ error: "סיסמה שגויה" }, 401, request, env);
  }
  return null;
}

async function login(request: Request, env: Env): Promise<Response> {
  if (!env.DASH_PASSWORD) return json({ error: "השרת עדיין לא הוגדר" }, 503, request, env);
  const body = await readJson(request);
  const password = typeof body.password === "string" ? body.password : "";
  if (!passwordsMatch(password, env.DASH_PASSWORD)) return json({ error: "סיסמה שגויה" }, 401, request, env);
  return json({ ok: true }, 200, request, env);
}

async function deviceCommands(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson(request);
  let commands;
  try {
    commands = validateCommands(body.commands);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "פקודה לא תקינה" }, 400, request, env);
  }
  const client = tuya(env);
  const result = await client.sendCommands(id, commands);
  await invalidateSnapshot(env.RULES);
  const ok = Boolean(result.success);
  const failure = tuyaUserMessage(result.msg);
  await appendActivity(env.RULES, { ok, message: ok ? `פקודה ל-${id}` : `נכשלה פקודה ל-${id}: ${failure}` });
  if (!ok) return json({ error: failure }, 502, request, env);
  return json({ ok: true }, 200, request, env);
}

async function acCommand(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson(request);
  let ac;
  try {
    ac = validateAcBody(body);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "פקודת מזגן לא תקינה" }, 400, request, env);
  }
  const snap = await buildSnapshot(env);
  const device = snap.sections.flatMap((s) => s.devices).find((d) => d.id === id);
  const infraredId = device?.ac?.infraredId;
  const remoteId = device?.ac?.remoteId;
  if (!infraredId || !remoteId) {
    return json({ error: "לא נמצא שלט IR למזגן הזה. ודאו ששירות IR Control Hub פעיל בפרויקט Tuya." }, 400, request, env);
  }
  const result = await tuya(env).sendAcCommand(infraredId, remoteId, ac);
  await invalidateSnapshot(env.RULES);
  const ok = Boolean(result.success);
  const failure = tuyaUserMessage(result.msg);
  await appendActivity(env.RULES, {
    ok,
    message: ok ? `${device?.name || "מזגן"}: ${ac.power ? "דולק" : "כבוי"} ${ac.temp}°` : `מזגן נכשל: ${failure}`,
  });
  if (!ok) return json({ error: failure }, 502, request, env);
  return json({ ok: true }, 200, request, env);
}

async function zoneCommand(request: Request, env: Env, relayId: number, action: string): Promise<Response> {
  const body = await readJson(request);
  const snap = await buildSnapshot(env);
  const zone = snap.sections.flatMap((s) => s.zones).find((z) => z.relayId === relayId);
  if (!zone) return json({ error: "אזור ההשקיה לא נמצא" }, 404, request, env);
  const minutes = clamp(Number(body.minutes ?? 10), 1, 180);
  const hours = clamp(Number(body.hours ?? 24), 1, 720);
  const now = Math.floor(Date.now() / 1000);
  const kind = action === "run" || action === "stop" || action === "suspend" || action === "resume" ? action : "";
  if (!kind) return json({ error: "פעולה לא נתמכת" }, 400, request, env);
  const result = await recordZoneCommand(env.RULES, env.HYDRAWISE_API_KEY, {
    action: kind,
    relayId,
    runSeconds: kind === "run" ? minutes * 60 : undefined,
    suspendUntilEpoch: kind === "suspend" ? now + hours * 3600 : undefined,
  }, Date.now());
  await invalidateSnapshot(env.RULES);
  const ok = result.message_type !== "error";
  const verb = kind === "run" ? `השקיה ${minutes} דק׳` : kind === "stop" ? "עצירה" : kind === "resume" ? "חידוש" : `השהיה ${hours} שע׳`;
  await appendActivity(env.RULES, { ok, message: `${zone.name}: ${ok ? verb : result.message || "נכשל"}` });
  if (!ok) return json({ error: result.message || "Hydrawise דחה את הפקודה" }, 502, request, env);
  return json({ ok: true, message: result.message || verb }, 200, request, env);
}

async function putPref(request: Request, env: Env, save: (patch: { hidden?: boolean; name?: string | null }) => Promise<unknown>): Promise<Response> {
  const body = await readJson(request);
  const parsed = readPrefPatch(body);
  if (!parsed.patch) return json({ error: parsed.error || "אין מה לעדכן" }, 400, request, env);
  const prefs = await save(parsed.patch);
  return json(prefs, 200, request, env);
}

async function previewRule(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 1000) return json({ error: "כתבו תרחיש קצר" }, 400, request, env);
  const snap = await buildSnapshot(env);
  const draft = await interpretRule(text, snap.catalog, (t, catalog) => askWorkersAi(env.AI, env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast", t, catalog));
  return json({ draft, summaryHe: draft.summaryHe, issues: draft.issues, parsedBy: draft.parsedBy, usedFallback: draft.usedFallback }, 200, request, env);
}

async function createRule(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  const snap = await buildSnapshot(env);
  const draft = checkedDraft(body.draft, snap);
  const rules = await loadRules(env.RULES);
  if (rules.length >= 50) return json({ error: "אפשר לשמור עד 50 תרחישים" }, 400, request, env);
  const rule = draftToRule(draft);
  rules.unshift(rule);
  await saveRules(env.RULES, rules);
  await appendActivity(env.RULES, { ok: true, message: `נשמר תרחיש «${rule.name}»`, ruleId: rule.id, ruleName: rule.name });
  return json({ rule }, 200, request, env);
}

async function updateRule(request: Request, env: Env, id: string): Promise<Response> {
  const body = await readJson(request);
  const rules = await loadRules(env.RULES);
  const idx = rules.findIndex((r) => r.id === id);
  if (idx < 0) return json({ error: "התרחיש לא נמצא" }, 404, request, env);
  const current = rules[idx];
  if (body.draft) {
    const snap = await buildSnapshot(env);
    const draft = checkedDraft(body.draft, snap);
    const reset = draft.sourceText !== current.sourceText;
    rules[idx] = draftToRule(draft, reset ? { ...current, lastFiredAt: null, lastFiredSlot: null } : current);
    if (typeof body.enabled === "boolean") rules[idx].enabled = body.enabled;
  } else if (typeof body.enabled === "boolean") {
    current.enabled = body.enabled;
    current.updatedAt = new Date().toISOString();
    rules[idx] = current;
  } else {
    return json({ error: "אין מה לעדכן" }, 400, request, env);
  }
  await saveRules(env.RULES, rules);
  return json({ rule: rules[idx] }, 200, request, env);
}

async function deleteRule(env: Env, request: Request, id: string): Promise<Response> {
  const rules = await loadRules(env.RULES);
  const next = rules.filter((r) => r.id !== id);
  if (next.length === rules.length) return json({ error: "התרחיש לא נמצא" }, 404, request, env);
  await saveRules(env.RULES, next);
  return json({ ok: true }, 200, request, env);
}

async function runRule(env: Env, request: Request, id: string): Promise<Response> {
  const rules = await loadRules(env.RULES);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return json({ error: "התרחיש לא נמצא" }, 404, request, env);
  const snap = await buildSnapshot(env, { fresh: true });
  const result = await executeSavedRule(env, rule, snap, false);
  await appendActivity(env.RULES, { ok: result.ok, message: result.message, ruleId: rule.id, ruleName: rule.name });
  await invalidateSnapshot(env.RULES);
  return json(result, result.ok ? 200 : 502, request, env);
}

function checkedDraft(input: unknown, snap: Snapshot): Draft {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const source = typeof raw.sourceText === "string" ? raw.sourceText : "";
  const parsedBy = raw.parsedBy === "ai" ? "ai" : "local";
  const draft = normalizeDraft(raw, snap.catalog, source, parsedBy);
  assertSavable(draft);
  return draft;
}

function draftToRule(draft: Draft, prev?: Rule): Rule {
  const now = new Date().toISOString();
  return {
    id: prev?.id || crypto.randomUUID(),
    name: draft.name,
    enabled: prev ? prev.enabled : true,
    sourceText: draft.sourceText,
    summaryHe: draft.summaryHe,
    cooldownMinutes: draft.cooldownMinutes,
    lastFiredAt: prev?.lastFiredAt ?? null,
    lastFiredSlot: prev?.lastFiredSlot ?? null,
    trigger: draft.trigger,
    conditions: draft.conditions,
    actions: draft.actions,
    createdAt: prev?.createdAt || now,
    updatedAt: now,
    parsedBy: draft.parsedBy,
  };
}

function tuya(env: Env): TuyaClient {
  return new TuyaClient({
    accessId: env.TUYA_ACCESS_ID,
    accessSecret: env.TUYA_ACCESS_SECRET,
    base: env.TUYA_BASE,
  });
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

async function readJson(request: Request): Promise<Record<string, any>> {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 100_000) throw new Error("הבקשה גדולה מדי");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON לא תקין");
  return value as Record<string, any>;
}

function matchRoute(method: string, pathname: string): { name: string; params: Record<string, string> } | null {
  const routes: { method: string; re: RegExp; name: string; keys: string[] }[] = [
    { method: "GET", re: /^\/api\/health$/, name: "health", keys: [] },
    { method: "POST", re: /^\/api\/login$/, name: "login", keys: [] },
    { method: "GET", re: /^\/api\/snapshot$/, name: "snapshot", keys: [] },
    { method: "POST", re: /^\/api\/devices\/([^/]+)\/commands$/, name: "commands", keys: ["id"] },
    { method: "POST", re: /^\/api\/devices\/([^/]+)\/ac$/, name: "ac", keys: ["id"] },
    { method: "POST", re: /^\/api\/zones\/(\d+)\/(run|stop|suspend|resume)$/, name: "zone", keys: ["relayId", "action"] },
    { method: "POST", re: /^\/api\/rules\/preview$/, name: "preview", keys: [] },
    { method: "GET", re: /^\/api\/rules$/, name: "rules", keys: [] },
    { method: "POST", re: /^\/api\/rules$/, name: "createRule", keys: [] },
    { method: "PUT", re: /^\/api\/rules\/([^/]+)$/, name: "updateRule", keys: ["id"] },
    { method: "DELETE", re: /^\/api\/rules\/([^/]+)$/, name: "deleteRule", keys: ["id"] },
    { method: "POST", re: /^\/api\/rules\/([^/]+)\/run$/, name: "runRule", keys: ["id"] },
    { method: "GET", re: /^\/api\/activity$/, name: "activity", keys: [] },
    { method: "GET", re: /^\/api\/prefs$/, name: "prefs", keys: [] },
    { method: "PUT", re: /^\/api\/prefs\/devices\/([^/]+)\/channels\/([^/]+)$/, name: "prefChannel", keys: ["id", "code"] },
    { method: "PUT", re: /^\/api\/prefs\/devices\/([^/]+)$/, name: "prefDevice", keys: ["id"] },
  ];
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.re.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, i) => {
      params[key] = m[i + 1];
    });
    return { name: route.name, params };
  }
  return null;
}

function json(data: unknown, status: number, request: Request, env: Env): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Dash-Password",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  });
  const origin = request.headers.get("Origin");
  if (origin && origin === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(status === 204 ? null : JSON.stringify(data), { status, headers });
}
