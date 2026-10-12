import assert from "node:assert/strict";
import test from "node:test";
import { readHydrawise, recordZoneCommand, zonesFromCache, nextStatusAt } from "../src/hydro-cache.ts";
import { tuyaUserMessage } from "../src/tuya.ts";

const t0 = Date.parse("2026-10-11T13:56:00.000Z");

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

function responder(state: { statusCode: number }) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("statusschedule")) {
      if (state.statusCode !== 200) {
        return new Response("You cannot make more than 20 requests in any 5 minute period to this endpoint.", { status: state.statusCode });
      }
      return Response.json({
        time: 1,
        nextpoll: 30,
        relays: [{ relay_id: 4, relay: 4, name: "Back Lawn", time: 120, run: 600, period: 86400 }],
      });
    }
    if (url.includes("customerdetails")) return Response.json({ controllers: [{ name: "My Controller", status: "All Good" }] });
    if (url.includes("setzone")) return Response.json({ message: "ok", message_type: "info" });
    return new Response("missing", { status: 404 });
  };
  return { impl, calls };
}

function statusCalls(calls: string[]): number {
  return calls.filter((url) => url.includes("statusschedule")).length;
}

test("status polling waits at least a minute and honors a longer nextpoll", () => {
  assert.equal(nextStatusAt(t0, 30), t0 + 60_000);
  assert.equal(nextStatusAt(t0, 180), t0 + 180_000);
  assert.equal(nextStatusAt(t0, undefined), t0 + 60_000);
  assert.equal(nextStatusAt(t0, (t0 + 90_000) / 1000), t0 + 90_000);
  assert.equal(nextStatusAt(t0, 24 * 3600), t0 + 10 * 60_000);
});

test("statusschedule is not called again inside the window, including after a 429", async () => {
  const kv = memoryKv();
  const state = { statusCode: 200 };
  const { impl, calls } = responder(state);
  const first = await readHydrawise(kv, "key", t0, impl);
  assert.equal(statusCalls(calls), 1);
  assert.equal(first.stale, false);
  assert.equal(zonesFromCache(first, new Date(t0))[0].name, "Back Lawn");

  const again = await readHydrawise(kv, "key", t0 + 45_000, impl);
  assert.equal(statusCalls(calls), 1);
  assert.deepEqual(again.schedule, first.schedule);

  state.statusCode = 429;
  const failed = await readHydrawise(kv, "key", t0 + 61_000, impl);
  assert.equal(statusCalls(calls), 2);
  assert.equal(failed.stale, true);
  const zones = zonesFromCache(failed, new Date(t0 + 61_000));
  assert.equal(zones[0].name, "Back Lawn");
  assert.match(zones[0].staleLabel || "", /נתונים ישנים · 16:56/);

  await readHydrawise(kv, "key", t0 + 90_000, impl);
  assert.equal(statusCalls(calls), 2);
  assert.equal(calls.filter((url) => url.includes("customerdetails")).length, 1);
});

test("a zone command is sent immediately and does not refresh status inside the window", async () => {
  const kv = memoryKv();
  const state = { statusCode: 200 };
  const { impl, calls } = responder(state);
  await readHydrawise(kv, "key", t0, impl);
  const result = await recordZoneCommand(kv, "key", { action: "run", relayId: 4, runSeconds: 480 }, t0 + 10_000, impl);
  assert.equal(result.message_type, "info");
  assert.equal(statusCalls(calls), 1);
  assert.equal(calls.filter((url) => url.includes("setzone")).length, 1);
  const cached = await readHydrawise(kv, "key", t0 + 20_000, impl);
  const zone = zonesFromCache(cached, new Date(t0 + 20_000))[0];
  assert.equal(zone.running, true);
  assert.equal(statusCalls(calls), 1);
});

test("a zone command refreshes status once the window is open", async () => {
  const kv = memoryKv();
  const state = { statusCode: 200 };
  const { impl, calls } = responder(state);
  await readHydrawise(kv, "key", t0, impl);
  await recordZoneCommand(kv, "key", { action: "stop", relayId: 4 }, t0 + 61_000, impl);
  assert.equal(statusCalls(calls), 2);
  assert.equal(calls.filter((url) => url.includes("setzone")).length, 1);
});

test("the Tuya trial quota is explained in Hebrew", () => {
  const text = tuyaUserMessage("Your controllable device pool quota is insufficient");
  assert.match(text, /מכסת השליטה של Tuya/);
  assert.match(text, /IoT Core/);
  assert.doesNotMatch(text, /insufficient/);
  assert.equal(tuyaUserMessage("permission deny"), "permission deny");
});
