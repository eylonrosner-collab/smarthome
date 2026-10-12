import assert from "node:assert/strict";
import test from "node:test";
import { buildAiMessages } from "../src/ai.ts";
import { handle } from "../src/index.ts";
import { applyPrefs, channelKey, type Prefs } from "../src/prefs.ts";
import { interpretRule } from "../src/rules.ts";
import type { DeviceView, Env, Snapshot } from "../src/types.ts";

function memoryKv() {
  const map = new Map<string, string>();
  return {
    async get(key: string, type?: string) {
      const raw = map.get(key);
      if (raw == null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
  };
}

function envWith(kv: ReturnType<typeof memoryKv>): Env {
  return {
    RULES: kv as unknown as KVNamespace,
    DASH_PASSWORD: "pw",
    ALLOWED_ORIGIN: "https://eylonrosner-collab.github.io",
    TUYA_ACCESS_ID: "",
    TUYA_ACCESS_SECRET: "",
    HYDRAWISE_API_KEY: "",
    TUYA_BASE: "https://openapi.tuyaeu.com",
    AI_MODEL: "",
    AI: { run: async () => ({}) },
  } as Env;
}

function call(env: Env, path: string, method = "GET", body?: unknown, password = "pw") {
  return handle(new Request("https://worker.test" + path, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${password}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

const entrance: DeviceView = {
  id: "dev-entrance",
  name: "בקרת יציאה דלת כניסה",
  productName: "switch",
  category: "kg",
  online: true,
  icon: "💡",
  kindLabel: "מתג",
  subtitle: "מתג חכם",
  section: "lights",
  rows: [],
  switches: [
    { code: "switch_1", label: "תאורת חוץ", on: false },
    { code: "switch_2", label: "סגירה כללית", on: false },
  ],
  dimmers: [],
};

function snapshot(): Snapshot {
  return {
    updatedAt: "2026-10-11T13:56:00.000Z",
    updatedLabel: "בדיקה",
    stats: { devices: 1, online: 1, offline: 0, zones: 0 },
    controller: { name: "My Controller", note: "" },
    sections: [{ id: "lights", icon: "💡", title: "תאורה ומתגים", online: 1, total: 1, devices: [structuredClone(entrance)], zones: [] }],
    errors: [],
    catalog: [],
  };
}

test("display names replace Tuya names and hidden flags survive", () => {
  const prefs: Prefs = {
    devices: { "dev-entrance": { name: "כניסה ראשית", hidden: true } },
    channels: { [channelKey("dev-entrance", "switch_1")]: { name: "פנס כניסה", hidden: true } },
  };
  const original = snapshot();
  const applied = applyPrefs(original, prefs);
  assert.equal(original.sections[0].devices[0].name, "בקרת יציאה דלת כניסה");
  const device = applied.sections[0].devices[0];
  assert.equal(device.name, "כניסה ראשית");
  assert.equal(device.hidden, true);
  assert.equal(device.switches[0].label, "פנס כניסה");
  assert.equal(device.switches[0].hidden, true);
  assert.equal(device.switches[1].label, "סגירה כללית");
  const dumped = JSON.stringify(applied);
  assert.equal(dumped.includes("בקרת יציאה דלת כניסה"), false);
  assert.equal(dumped.includes("תאורת חוץ"), false);
  const catalogDevice = applied.catalog.find((item) => item.id === "dev-entrance");
  assert.equal(catalogDevice?.name, "כניסה ראשית");
  assert.equal(catalogDevice?.switches?.find((sw) => sw.code === "switch_1")?.label, "פנס כניסה");
});

test("a custom gang name is what the scenario parser and the model see", async () => {
  const prefs: Prefs = {
    devices: { "dev-entrance": { name: "כניסה ראשית" } },
    channels: { [channelKey("dev-entrance", "switch_1")]: { name: "פנס כניסה" } },
  };
  const applied = applyPrefs(snapshot(), prefs);
  const draft = await interpretRule("הדלק פנס כניסה", applied.catalog);
  assert.equal(draft.issues.length, 0, draft.issues.join(" "));
  const action = draft.actions[0];
  assert.ok(action && (action.type === "switch" || action.type === "dimmer"));
  if (action && (action.type === "switch" || action.type === "dimmer")) {
    assert.equal(action.deviceId, "dev-entrance");
    assert.equal(action.code, "switch_1");
    assert.equal(action.on, true);
  }
  assert.match(draft.summaryHe, /פנס כניסה|כניסה ראשית/);
  const prompt = buildAiMessages("הדלק פנס כניסה", applied.catalog)[1].content;
  assert.match(prompt, /פנס כניסה/);
  assert.match(prompt, /כניסה ראשית/);
  assert.doesNotMatch(prompt, /תאורת חוץ/);
  assert.doesNotMatch(prompt, /בקרת יציאה דלת כניסה/);
});

test("pref endpoints require the dashboard password and round-trip hide and rename", async () => {
  const env = envWith(memoryKv());
  const denied = await call(env, "/api/prefs", "GET", undefined, "nope");
  assert.equal(denied.status, 401);

  const empty = await call(env, "/api/prefs");
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { devices: {}, channels: {} });

  const missing = await call(env, "/api/prefs/devices/dev-entrance", "PUT", {});
  assert.equal(missing.status, 400);

  const renamed = await call(env, "/api/prefs/devices/dev-entrance", "PUT", { name: "כניסה ראשית", hidden: true });
  assert.equal(renamed.status, 200);
  const gang = await call(env, "/api/prefs/devices/dev-entrance/channels/switch_1", "PUT", { name: "פנס כניסה" });
  assert.equal(gang.status, 200);
  const dimmer = await call(env, "/api/prefs/devices/dev-entrance/channels/switch_led_1", "PUT", { hidden: true });
  assert.equal(dimmer.status, 200);

  const stored = await (await call(env, "/api/prefs")).json() as Prefs;
  assert.deepEqual(stored.devices["dev-entrance"], { name: "כניסה ראשית", hidden: true });
  assert.deepEqual(stored.channels[channelKey("dev-entrance", "switch_1")], { name: "פנס כניסה" });
  assert.deepEqual(stored.channels[channelKey("dev-entrance", "switch_led_1")], { hidden: true });

  const cleared = await call(env, "/api/prefs/devices/dev-entrance/channels/switch_1", "PUT", { name: "" });
  assert.equal(cleared.status, 200);
  const after = await (await call(env, "/api/prefs")).json() as Prefs;
  assert.equal(after.channels[channelKey("dev-entrance", "switch_1")], undefined);

  const unhide = await call(env, "/api/prefs/devices/dev-entrance", "PUT", { hidden: false });
  assert.equal(unhide.status, 200);
  const shown = await (await call(env, "/api/prefs")).json() as Prefs;
  assert.deepEqual(shown.devices["dev-entrance"], { name: "כניסה ראשית" });

  const bad = await call(env, "/api/prefs/devices/dev-entrance", "PUT", { name: "x".repeat(41) });
  assert.equal(bad.status, 400);
  const weird = await call(env, "/api/prefs/devices/%20", "PUT", { hidden: true });
  assert.equal(weird.status, 400);
});
