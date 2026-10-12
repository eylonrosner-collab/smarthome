import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mockSnapshot } from "../../docs/mock.js";
import { renderActivity, renderHome, renderPreview, renderRuleList } from "../../docs/render.js";
import { extractJson } from "../src/ai.ts";
import { buildAiMessages } from "../src/ai.ts";
import { validateCommands } from "../src/execute.ts";

test("the dashboard renders the Hebrew groups, controls and soil sensor", () => {
  const html = renderHome(mockSnapshot, [
    { id: "rule-movie", name: "ערב סרט", enabled: true, trigger: { type: "manual" }, summaryHe: "סצנה" },
  ]);
  for (const text of ["גינה והשקיה", "Back Lawn", "מזגן סלון", "תאורת שביל", "תריס סלון חדש", "לחות קרקע", "28%", "השקיה", "פתיחה", "סגירה", "ערב סרט", "קירור"]) {
    assert.match(html, new RegExp(text));
  }
  assert.match(html, /data-toggle/);
  assert.match(html, /data-ac-power/);
  assert.match(html, /data-temp-step="1"/);
  assert.doesNotMatch(html, /data-temp="/);
  assert.match(html, /data-zone="1004"/);
  assert.match(html, /data-curtain="stop"/);
});

test("hidden devices and gangs stay off the dashboard until הצג מוסתרים", () => {
  const snap = structuredClone(mockSnapshot);
  const lights = snap.sections.find((s: { id: string }) => s.id === "lights") as {
    devices: { id: string; name: string; hidden?: boolean; switches: { code: string; label: string; hidden?: boolean }[] }[];
  };
  const entrance = lights.devices.find((d) => d.id === "dev-entrance")!;
  entrance.switches[0].hidden = true;
  entrance.switches[0].label = "פנס כניסה";
  const guest = lights.devices.find((d) => d.id === "dev-guest")!;
  guest.hidden = true;
  guest.name = "שירותים קטנים";
  const hidden = renderHome(snap, []);
  assert.match(hidden, /סגירה כללית/);
  assert.doesNotMatch(hidden, /פנס כניסה/);
  assert.doesNotMatch(hidden, /תאורת חוץ/);
  assert.doesNotMatch(hidden, /שירותי אורחים/);
  assert.doesNotMatch(hidden, /שירותים קטנים/);
  const shown = renderHome(snap, [], { showHidden: true });
  assert.match(shown, /פנס כניסה/);
  assert.match(shown, /שירותים קטנים/);
  assert.match(shown, /מוסתר/);
  assert.match(shown, /data-hidden-device/);
  assert.match(shown, /data-hidden-channel/);
  assert.match(shown, /data-hide-device="dev-guest"/);
  assert.doesNotMatch(shown, /שירותי אורחים/);
  assert.doesNotMatch(shown, /תאורת חוץ/);
});

test("stale irrigation zones stay on the dashboard", () => {
  const snap = structuredClone(mockSnapshot);
  const garden = snap.sections.find((s: { id: string }) => s.id === "garden") as { zones: { staleLabel?: string }[] };
  garden.zones[0].staleLabel = "נתונים ישנים · 16:56";
  const html = renderHome(snap, []);
  assert.match(html, /Back Lawn/);
  assert.match(html, /נתונים ישנים · 16:56/);
});

test("device names are escaped", () => {
  const snap = structuredClone(mockSnapshot);
  snap.sections[0].devices[0].name = `<img src=x onerror=alert(1)>`;
  const html = renderHome(snap, []);
  assert.equal(html.includes("<img"), false);
  assert.match(html, /&lt;img/);
});

test("rules, preview and activity render in Hebrew", () => {
  const rules = renderRuleList([
    { id: "1", name: "שגרה 19:00", enabled: true, trigger: { type: "time" }, summaryHe: "כל יום בשעה 19:00" },
  ]);
  assert.match(rules, /שגרה 19:00/);
  assert.match(rules, /data-run-rule="1"/);
  const preview = renderPreview({
    summaryHe: "השקיית Back Lawn ל-10 דקות",
    issues: [],
    parsedBy: "ai",
    usedFallback: false,
  });
  assert.match(preview, /זה מה שהבנתי/);
  assert.match(preview, /מודל שפה/);
  assert.match(preview, /id="save-rule"/);
  const blocked = renderPreview({ summaryHe: "", issues: ["לא נמצא אזור"], parsedBy: "local", usedFallback: true });
  assert.match(blocked, /disabled/);
  const log = renderActivity([{ id: "e", at: "2026-10-11T13:40:00.000Z", ok: false, ruleName: "השקיה", message: "נכשל" }]);
  assert.match(log, /השקיה/);
  assert.match(log, /נכשל/);
});

test("the static page is Hebrew, RTL, and relative to the project site", () => {
  const html = readFileSync(new URL("../../docs/index.html", import.meta.url), "utf8");
  assert.match(html, /<html lang="he" dir="rtl">/);
  assert.match(html, /src="\.\/app\.js(\?[^"]*)?"/);
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /הצג מוסתרים/);
  const app = readFileSync(new URL("../../docs/app.js", import.meta.url), "utf8");
  assert.match(app, /60_000\)/);
  assert.doesNotMatch(app, /, 30000\)/);
  const config = readFileSync(new URL("../../docs/config.js", import.meta.url), "utf8");
  assert.match(config, /https:\/\/smarthome\.eylonrosner\.workers\.dev/);
  assert.doesNotMatch(config, /YOUR-SUBDOMAIN|ACCESS_SECRET|HYDRAWISE|DASH_PASSWORD|api_key/i);
});

test("model output fences become JSON and the prompt sees the live catalog", () => {
  const parsed = extractJson('```json\n{"trigger":{"type":"manual"},"actions":[]}\n```');
  assert.equal((parsed as { trigger: { type: string } }).trigger.type, "manual");
  const messages = buildAiMessages("סצנה: ערב סרט", [
    { kind: "device", id: "c1", name: "תריס סלון", category: "clkg", section: "curtains", curtain: true },
  ]);
  assert.match(messages[1].content, /תריס סלון/);
  assert.match(messages[0].content, /Asia\/Jerusalem/);
});

test("device commands reject unexpected codes", () => {
  assert.equal(validateCommands([{ code: "switch_1", value: false }])[0].value, false);
  assert.throws(() => validateCommands([{ code: "scene", value: "factory_reset" }]));
});
