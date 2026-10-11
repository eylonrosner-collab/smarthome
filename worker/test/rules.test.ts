import assert from "node:assert/strict";
import test from "node:test";
import { planRuleActions } from "../src/execute.ts";
import { assertSavable, interpretRule, shouldFire, type Rule, type World } from "../src/rules.ts";
import type { CatalogItem, Snapshot } from "../src/types.ts";

const catalog: CatalogItem[] = [
  { kind: "zone", id: "zone-4", name: "Back Lawn", category: "zone", section: "zone", relayId: 4 },
  { kind: "zone", id: "zone-3", name: "Front lawn", category: "zone", section: "zone", relayId: 3 },
  { kind: "device", id: "path", name: "תאורת שביל", category: "tdq", section: "garden", switches: [{ code: "switch_1", label: "הפעלה" }] },
  { kind: "device", id: "c1", name: "תריס סלון", category: "clkg", section: "curtains", curtain: true },
  { kind: "device", id: "c2", name: "תריס סלון חדש", category: "clkg", section: "curtains", curtain: true },
  { kind: "device", id: "c3", name: "תריס מטבח", category: "clkg", section: "curtains", curtain: true },
  {
    kind: "device",
    id: "lights",
    name: "תאורת סלון",
    category: "kg",
    section: "lights",
    switches: [
      { code: "switch_1", label: "ספוטים" },
      { code: "switch_2", label: "אור גדול" },
    ],
  },
  { kind: "device", id: "soil", name: "לחות אדמת הדשא", category: "zwjcy", section: "garden", metrics: ["moisture", "temperature", "battery"] },
  { kind: "device", id: "ac", name: "מזגן סלון", category: "qt", section: "climate", ac: true },
];

function world(now: string, extra: Partial<World> = {}): World {
  return {
    now: new Date(now),
    metrics: extra.metrics || [],
    switches: extra.switches || [],
    zones: extra.zones || [],
  };
}

test("english moisture sentence waters Back Lawn for 10 minutes", async () => {
  const draft = await interpretRule("when soil moisture is below 30% water Back Lawn for 10 minutes", catalog);
  assert.equal(draft.issues.length, 0);
  assert.equal(draft.trigger.type, "sensor");
  if (draft.trigger.type === "sensor") {
    assert.equal(draft.trigger.metric, "moisture");
    assert.equal(draft.trigger.op, "lt");
    assert.equal(draft.trigger.value, 30);
    assert.equal(draft.trigger.deviceId, "soil");
  }
  assert.equal(draft.actions.length, 1);
  assert.deepEqual(draft.actions[0], {
    type: "zone",
    zoneName: "Back Lawn",
    relayId: 4,
    command: "run",
    minutes: 10,
    suspendHours: 24,
  });
  assert.ok(draft.cooldownMinutes >= 180);
  assert.match(draft.summaryHe, /Back Lawn/);
  assert.match(draft.summaryHe, /30%/);
  assert.match(draft.summaryHe, /180/);
});

test("moisture rule without a soil sensor warns in Hebrew and cannot be saved", async () => {
  const noSoil = catalog.filter((item) => item.id !== "soil");
  for (const text of [
    "when soil moisture is below 30% water Back Lawn for 10 minutes",
    "כשלחות הקרקע מתחת ל-30% השקה את Back Lawn ל-10 דקות",
  ]) {
    const draft = await interpretRule(text, noSoil);
    assert.equal(draft.trigger.type, "sensor", text);
    if (draft.trigger.type === "sensor") {
      assert.equal(draft.trigger.deviceId, undefined);
      assert.equal(draft.trigger.metric, "moisture");
      assert.equal(draft.trigger.value, 30);
    }
    assert.equal(draft.actions[0]?.type, "zone");
    assert.match(draft.issues.join("\n"), /אין עדיין חיישן לחות קרקע/);
    assert.match(draft.issues.join("\n"), /אי אפשר לשמור/);
    assert.throws(() => assertSavable(draft), /חיישן לחות קרקע/);
  }
});

test("hebrew moisture sentence matches the same zone", async () => {
  const draft = await interpretRule("כשלחות הקרקע מתחת ל-30% השקה את Back Lawn ל-10 דקות", catalog);
  assert.equal(draft.issues.length, 0);
  assert.equal(draft.actions[0]?.type, "zone");
  if (draft.actions[0]?.type === "zone") assert.equal(draft.actions[0].relayId, 4);
});

test("evening routine closes living-room shutters and turns on path lights", async () => {
  for (const text of [
    "every day at 19:00 close the living room shutters and turn on path lights",
    "כל יום ב-19:00 סגור את תריסי הסלון והדלק תאורת שביל",
  ]) {
    const draft = await interpretRule(text, catalog);
    assert.equal(draft.issues.length, 0, draft.issues.join(" ") + " / " + text);
    assert.equal(draft.trigger.type, "time");
    if (draft.trigger.type === "time") assert.equal(draft.trigger.time, "19:00");
    const curtains = draft.actions.filter((a) => a.type === "curtain");
    assert.deepEqual(curtains.map((a) => (a.type === "curtain" ? a.deviceId : "")).sort(), ["c1", "c2"]);
    const lights = draft.actions.filter((a) => a.type === "switch");
    assert.equal(lights.length, 1);
    if (lights[0]?.type === "switch") {
      assert.equal(lights[0].deviceId, "path");
      assert.equal(lights[0].on, true);
    }
    assert.match(draft.summaryHe, /19:00/);
    assert.match(draft.summaryHe, /תאורת שביל/);
  }
});

test("movie night is a manual scene for the living room", async () => {
  for (const text of ["scene: movie night", "סצנה: ערב סרט"]) {
    const draft = await interpretRule(text, catalog);
    assert.equal(draft.issues.length, 0, text);
    assert.equal(draft.trigger.type, "manual");
    assert.equal(draft.name, "ערב סרט");
    const closed = draft.actions.filter((a) => a.type === "curtain").map((a) => (a.type === "curtain" ? a.deviceId : ""));
    assert.deepEqual(closed.sort(), ["c1", "c2"]);
    const off = draft.actions.filter((a) => a.type === "switch" && a.on === false);
    assert.equal(off.length, 2);
    assert.match(draft.summaryHe, /לחיצה/);
  }
});

test("Workers AI result is used when it is valid, otherwise the local parser", async () => {
  const ai = async () => ({
    name: "כיבוי מזגן",
    cooldownMinutes: 0,
    trigger: { type: "time", time: "23:30", days: [0, 1, 2, 3, 4] },
    conditions: [],
    actions: [{ type: "ac", deviceId: "ac", deviceName: "מזגן סלון", power: 0 }],
  });
  const draft = await interpretRule("turn the living room ac off at 23:30 on weekdays", catalog, ai);
  assert.equal(draft.parsedBy, "ai");
  assert.equal(draft.usedFallback, false);
  assert.equal(draft.trigger.type, "time");
  assert.ok(draft.cooldownMinutes >= 10);
  assert.equal(draft.actions[0]?.type, "ac");
  if (draft.actions[0]?.type === "ac") assert.equal(draft.actions[0].power, false);
  assert.match(draft.summaryHe, /23:30/);
  assert.match(draft.summaryHe, /ימי חול|ראשון/);

  const fallback = await interpretRule("when soil moisture is below 30% water Back Lawn for 10 minutes", catalog, async () => {
    throw new Error("model down");
  });
  assert.equal(fallback.parsedBy, "local");
  assert.equal(fallback.usedFallback, true);
  assert.equal(fallback.issues.length, 0);
});

test("a 19:00 rule fires inside the Jerusalem window once", () => {
  const rule = {
    enabled: true,
    cooldownMinutes: 10,
    lastFiredAt: null,
    lastFiredSlot: null,
    trigger: { type: "time" as const, time: "19:00" },
    conditions: [],
  };
  assert.equal(shouldFire(rule, world("2026-07-15T16:00:00Z")).fire, true);
  assert.equal(shouldFire(rule, world("2026-07-15T16:04:00Z")).slot, "2026-07-15T19:00");
  assert.equal(shouldFire(rule, world("2026-07-15T16:11:00Z")).fire, false);
  assert.equal(shouldFire(rule, world("2026-01-15T17:00:00Z")).fire, true);
  const fired = { ...rule, lastFiredSlot: "2026-07-15T19:00" };
  assert.equal(shouldFire(fired, world("2026-07-15T16:03:00Z")).reason, "already-fired-slot");
  const weekday = { ...rule, trigger: { type: "time" as const, time: "19:00", days: [0, 1, 2, 3, 4] } };
  assert.equal(shouldFire(weekday, world("2026-07-18T16:00:00Z")).reason, "wrong-day");
});

test("sensor rules respect the threshold and the cooldown", () => {
  const rule = {
    enabled: true,
    cooldownMinutes: 180,
    lastFiredAt: null as string | null,
    lastFiredSlot: null,
    trigger: { type: "sensor" as const, deviceId: "soil", metric: "moisture", op: "lt" as const, value: 30 },
    conditions: [],
  };
  const wet = world("2026-07-15T16:00:00Z", { metrics: [{ deviceId: "soil", deviceName: "לחות", metric: "moisture", value: 40 }] });
  const dry = world("2026-07-15T16:00:00Z", { metrics: [{ deviceId: "soil", deviceName: "לחות", metric: "moisture", value: 25 }] });
  assert.equal(shouldFire(rule, wet).reason, "threshold");
  assert.equal(shouldFire(rule, dry).fire, true);
  assert.equal(shouldFire(rule, world("2026-07-15T16:00:00Z")).reason, "no-reading");
  const recent = { ...rule, lastFiredAt: new Date(Date.parse("2026-07-15T16:00:00Z") - 179 * 60_000).toISOString() };
  assert.equal(shouldFire(recent, dry).reason, "cooldown");
  const old = { ...rule, lastFiredAt: new Date(Date.parse("2026-07-15T16:00:00Z") - 181 * 60_000).toISOString() };
  assert.equal(shouldFire(old, dry).fire, true);
  assert.equal(shouldFire({ ...rule, enabled: false }, dry).reason, "disabled");
  assert.equal(shouldFire({ ...rule, trigger: { type: "manual" } }, dry).reason, "manual");
});

test("a running zone is not started again by the scheduler", () => {
  const rule = {
    actions: [{ type: "zone" as const, zoneName: "Back Lawn", relayId: 4, command: "run" as const, minutes: 10 }],
  };
  const snap = {
    sections: [
      {
        id: "garden",
        icon: "",
        title: "",
        online: 0,
        total: 0,
        devices: [],
        zones: [
          {
            relayId: 4,
            relay: 4,
            name: "Back Lawn",
            running: true,
            stateLabel: "",
            nextLabel: "",
            durationLabel: "",
            periodLabel: "",
          },
        ],
      },
    ],
  } as unknown as Snapshot;
  const skipped = planRuleActions(rule, snap, { skipIfZoneRunning: true });
  assert.equal(skipped.planned.length, 0);
  assert.match(skipped.notes.join(" "), /כבר משקה/);
  const manual = planRuleActions(rule, snap, { skipIfZoneRunning: false });
  assert.equal(manual.planned.length, 1);
});

test("manual rules never fire from the clock", () => {
  const rule = {
    enabled: true,
    cooldownMinutes: 0,
    lastFiredAt: null,
    lastFiredSlot: null,
    trigger: { type: "manual" as const },
    conditions: [],
  } satisfies Pick<Rule, "enabled" | "cooldownMinutes" | "lastFiredAt" | "lastFiredSlot" | "trigger" | "conditions">;
  assert.equal(shouldFire(rule, world("2026-07-15T16:00:00Z")).fire, false);
});
