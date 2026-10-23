import assert from "node:assert/strict";
import test from "node:test";
import { memoryEphemeral } from "../src/ephemeral.ts";
import { buildSnapshot } from "../src/snapshot.ts";
import { runScheduler } from "../src/scheduler.ts";
import { TuyaClient, TUYA_QUOTA_MESSAGE, tuyaUserMessage } from "../src/tuya.ts";
import type { Rule } from "../src/rules.ts";
import type { Env } from "../src/types.ts";

const t0 = Date.parse("2026-10-11T13:56:00.000Z");

function countingKv() {
  const map = new Map<string, string>();
  const puts: string[] = [];
  return {
    puts,
    async get(key: string, type?: string) {
      const raw = map.get(key);
      if (raw == null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      puts.push(key);
      map.set(key, value);
    },
    async delete() {
      return;
    },
  };
}

function envFor(kv: ReturnType<typeof countingKv>): Env {
  return {
    RULES: kv as unknown as KVNamespace,
    DASH_PASSWORD: "pw",
    ALLOWED_ORIGIN: "https://eylonrosner-collab.github.io",
    TUYA_ACCESS_ID: "id",
    TUYA_ACCESS_SECRET: "secret",
    HYDRAWISE_API_KEY: "",
    TUYA_BASE: "https://openapi.tuyaeu.com",
    AI_MODEL: "",
    AI: { run: async () => ({}) },
  } as Env;
}

function count(calls: string[], part: string): number {
  return calls.filter((url) => url.includes(part)).length;
}

function fakeTuya(batchBody: () => unknown) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1.0/token")) {
      return Response.json({ success: true, result: { access_token: "tok", refresh_token: "ref", expire_time: 7200 } });
    }
    if (url.includes("thing/device")) {
      return Response.json({
        success: true,
        result: {
          devices: [
            { id: "soil", name: "לחות אדמה", category: "zwjcy", isOnline: true },
            { id: "sw", name: "מתג", category: "kg", isOnline: true },
          ],
        },
      });
    }
    if (url.includes("multiple-names")) {
      return Response.json({ success: true, result: [{ identifier: "switch_1", name: "אור" }] });
    }
    if (url.includes("iot-03/devices/status")) return Response.json(batchBody());
    if (url.includes("/status")) {
      return Response.json({ success: true, result: [{ code: "humidity_value", value: 280 }] });
    }
    return Response.json({ success: false, code: 500, msg: "unexpected" });
  };
  return { calls, fetchImpl };
}

const okBatch = () => ({
  success: true,
  result: [
    { id: "soil", status: [{ code: "humidity_value", value: 280 }] },
    { id: "sw", status: [{ code: "switch_1", value: true }] },
  ],
});

test("a viewed dashboard sweeps at most twice an hour and keeps metadata for a day", async () => {
  const kv = countingKv();
  const store = memoryEphemeral();
  let clock = t0;
  const { calls, fetchImpl } = fakeTuya(okBatch);
  const client = new TuyaClient({
    accessId: "id",
    accessSecret: "secret",
    store,
    fetchImpl,
    now: () => clock,
  });
  const env = envFor(kv);
  for (let elapsed = 0; elapsed <= 29 * 60_000; elapsed += 60_000) {
    clock = t0 + elapsed;
    const snap = await buildSnapshot(env, { fresh: true, now: new Date(clock), client, store });
    if (elapsed === 0) {
      const soil = snap.sections.flatMap((section) => section.devices).find((device) => device.id === "soil");
      assert.equal(soil?.metrics?.moisture, 28);
    }
  }
  assert.equal(count(calls, "/v1.0/token"), 1);
  assert.equal(count(calls, "thing/device"), 1);
  assert.equal(count(calls, "multiple-names"), 1);
  assert.equal(count(calls, "iot-03/devices/status"), 1);
  assert.equal(count(calls, "/v1.0/devices/soil/status"), 0);
  assert.equal(count(calls, "/v1.0/devices/sw/status"), 0);

  clock = t0 + 30 * 60_000;
  await buildSnapshot(env, { fresh: true, now: new Date(clock), client, store });
  assert.equal(count(calls, "thing/device"), 1);
  assert.equal(count(calls, "multiple-names"), 1);
  assert.equal(count(calls, "iot-03/devices/status"), 2);
  assert.equal(kv.puts.length, 0);
});

test("batch status falls back per device when the endpoint is not permitted", async () => {
  const store = memoryEphemeral();
  const { calls, fetchImpl } = fakeTuya(() => ({ success: false, code: 1106, msg: "permission deny" }));
  const client = new TuyaClient({ accessId: "id", accessSecret: "secret", store, fetchImpl, now: () => t0 });
  await buildSnapshot(envFor(countingKv()), { fresh: true, now: new Date(t0), client, store });
  assert.equal(count(calls, "iot-03/devices/status"), 1);
  assert.equal(count(calls, "/v1.0/devices/soil/status"), 1);
  assert.equal(count(calls, "/v1.0/devices/sw/status"), 1);
  assert.equal(count(calls, "shadow/properties"), 0);
});

test("batch status groups up to 20 devices per call", async () => {
  const store = memoryEphemeral();
  const calls: string[] = [];
  const client = new TuyaClient({
    accessId: "id",
    accessSecret: "secret",
    store,
    now: () => t0,
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/v1.0/token")) {
        return Response.json({ success: true, result: { access_token: "tok", refresh_token: "r", expire_time: 7200 } });
      }
      return Response.json({ success: true, result: [] });
    },
  });
  const ids = Array.from({ length: 21 }, (_, i) => `d${i}`);
  const statuses = await client.batchStatus(ids);
  assert.ok(statuses);
  assert.equal(count(calls, "/v1.0/token"), 1);
  assert.equal(count(calls, "iot-03/devices/status"), 2);
});

test("a shared token is reused across clients for about two hours", async () => {
  const store = memoryEphemeral();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    if (String(input).includes("/v1.0/token")) {
      return Response.json({ success: true, result: { access_token: "tok", refresh_token: "r", expire_time: 7200 } });
    }
    return Response.json({ success: true, result: { devices: [] } });
  };
  const opts = { accessId: "id", accessSecret: "secret", store, fetchImpl, now: () => t0 };
  await new TuyaClient(opts).listDevices();
  await new TuyaClient(opts).listDevices();
  assert.equal(count(calls, "/v1.0/token"), 1);
  assert.equal(count(calls, "thing/device"), 2);
});

test("quota 28841004 keeps the last devices, explains it in Hebrew, and pauses calls for an hour", async () => {
  const kv = countingKv();
  const store = memoryEphemeral();
  let clock = t0;
  let quota = false;
  const { calls, fetchImpl } = fakeTuya(() =>
    quota
      ? { success: false, code: 28841004, msg: "IoT Core trial quota is exhausted" }
      : okBatch(),
  );
  const client = new TuyaClient({
    accessId: "id",
    accessSecret: "secret",
    store,
    fetchImpl,
    now: () => clock,
  });
  const env = envFor(kv);
  const first = await buildSnapshot(env, { fresh: true, now: new Date(clock), client, store });
  assert.equal(first.errors.includes(TUYA_QUOTA_MESSAGE), false);

  quota = true;
  clock = t0 + 31 * 60_000;
  const blocked = await buildSnapshot(env, { fresh: true, now: new Date(clock), client, store });
  assert.ok(blocked.errors.includes(TUYA_QUOTA_MESSAGE));
  const soil = blocked.sections.flatMap((section) => section.devices).find((device) => device.id === "soil");
  assert.equal(soil?.name, "לחות אדמה");
  assert.equal(soil?.metrics?.moisture, 28);
  assert.equal(count(calls, "/v1.0/devices/soil/status"), 0);
  assert.equal(count(calls, "/v1.0/devices/sw/status"), 0);
  const afterQuota = calls.length;

  clock = t0 + 40 * 60_000;
  const held = await buildSnapshot(env, { fresh: true, now: new Date(clock), client, store });
  assert.equal(calls.length, afterQuota);
  assert.ok(held.errors.includes(TUYA_QUOTA_MESSAGE));
  assert.equal(kv.puts.length, 0);
  assert.equal(tuyaUserMessage("IoT Core trial quota is exhausted"), TUYA_QUOTA_MESSAGE);
});

function rule(trigger: Rule["trigger"]): Rule {
  return {
    id: "r1",
    name: "בדיקה",
    enabled: true,
    sourceText: "test",
    summaryHe: "בדיקה",
    cooldownMinutes: 10,
    lastFiredAt: null,
    lastFiredSlot: null,
    trigger,
    conditions: [],
    actions: [{ type: "switch", deviceName: "אין", on: true }],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

test("cron does not call Tuya for a time rule, and only batches a sensor rule's device", async () => {
  const kv = countingKv();
  await kv.put("rules", JSON.stringify([rule({ type: "time", time: "03:00", days: [0, 1, 2, 3, 4, 5, 6] })]));
  kv.puts.length = 0;
  const store = memoryEphemeral();
  let clock = t0;
  const quiet = fakeTuya(okBatch);
  const quietClient = new TuyaClient({
    accessId: "id",
    accessSecret: "secret",
    store,
    fetchImpl: quiet.fetchImpl,
    now: () => clock,
  });
  await runScheduler(envFor(kv), new Date(clock), { client: quietClient, store });
  assert.equal(quiet.calls.length, 0);
  assert.equal(kv.puts.length, 0);

  const sensorKv = countingKv();
  await sensorKv.put("rules", JSON.stringify([
    rule({ type: "sensor", deviceId: "soil", metric: "moisture", op: "lt", value: 1 }),
  ]));
  sensorKv.puts.length = 0;
  const sensorStore = memoryEphemeral();
  const sensor = fakeTuya(okBatch);
  const sensorClient = new TuyaClient({
    accessId: "id",
    accessSecret: "secret",
    store: sensorStore,
    fetchImpl: sensor.fetchImpl,
    now: () => clock,
  });
  await runScheduler(envFor(sensorKv), new Date(clock), { client: sensorClient, store: sensorStore });
  assert.equal(count(sensor.calls, "/v1.0/token"), 1);
  assert.equal(count(sensor.calls, "iot-03/devices/status"), 1);
  assert.equal(count(sensor.calls, "thing/device"), 0);
  assert.equal(count(sensor.calls, "multiple-names"), 0);
  assert.equal(sensorKv.puts.length, 0);

  const before = sensor.calls.length;
  clock = t0 + 60_000;
  await runScheduler(envFor(sensorKv), new Date(clock), { client: sensorClient, store: sensorStore });
  assert.equal(sensor.calls.length, before);
});
