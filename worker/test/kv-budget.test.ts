import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildSnapshot } from "../src/snapshot.ts";
import { runScheduler } from "../src/scheduler.ts";
import { saveRules } from "../src/store.ts";
import type { Rule } from "../src/rules.ts";
import type { Env } from "../src/types.ts";

const t0 = Date.parse("2026-10-11T13:56:00.000Z");

function countingKv() {
  const map = new Map<string, string>();
  const puts: { key: string; value: string }[] = [];
  const deletes: string[] = [];
  return {
    puts,
    deletes,
    async get(key: string, type?: string) {
      const raw = map.get(key);
      if (raw == null) return null;
      return type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      puts.push({ key, value });
      map.set(key, value);
    },
    async delete(key: string) {
      deletes.push(key);
      map.delete(key);
    },
  };
}

function envWith(kv: ReturnType<typeof countingKv>): Env {
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

function rule(time: string): Rule {
  return {
    id: "r1",
    name: "בדיקה",
    enabled: true,
    sourceText: "test",
    summaryHe: "בדיקה",
    cooldownMinutes: 10,
    lastFiredAt: null,
    lastFiredSlot: null,
    trigger: { type: "time", time, days: [0, 1, 2, 3, 4, 5, 6] },
    conditions: [],
    actions: [{ type: "switch", deviceName: "אין מכשיר כזה", on: true }],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

async function seed(kv: ReturnType<typeof countingKv>, time: string) {
  await kv.put("rules", JSON.stringify([rule(time)]));
  kv.puts.length = 0;
  kv.deletes.length = 0;
}

test("a cron tick with nothing to run does not write KV, even when status reads fail", async () => {
  const kv = countingKv();
  await seed(kv, "03:00");
  const env = envWith(kv);
  await runScheduler(env, new Date(t0));
  for (let i = 0; i < 30; i++) {
    await buildSnapshot(env, { fresh: true, now: new Date(t0 + i * 10_000) });
  }
  assert.deepEqual(kv.puts, []);
  assert.deepEqual(kv.deletes, []);
});

test("a cron tick that fires writes the rule and one activity event", async () => {
  const kv = countingKv();
  await seed(kv, "16:56");
  await runScheduler(envWith(kv), new Date(t0));
  assert.deepEqual(kv.puts.map((put) => put.key), ["activity", "rules"]);
  assert.deepEqual(kv.deletes, []);
});

test("saving unchanged rules does not write KV again", async () => {
  const kv = countingKv();
  const rules = [rule("03:00")];
  await saveRules(kv as unknown as KVNamespace, rules);
  assert.equal(kv.puts.length, 1);
  await saveRules(kv as unknown as KVNamespace, rules);
  assert.equal(kv.puts.length, 1);
});

test("status cache modules do not touch KV", () => {
  const hydro = readFileSync(new URL("../src/hydro-cache.ts", import.meta.url), "utf8");
  const snapshot = readFileSync(new URL("../src/snapshot.ts", import.meta.url), "utf8");
  const scheduler = readFileSync(new URL("../src/scheduler.ts", import.meta.url), "utf8");
  assert.doesNotMatch(hydro, /KVNamespace|env\.RULES/);
  assert.doesNotMatch(snapshot, /env\.RULES\.(put|delete|get)|snapshot_cache/);
  assert.doesNotMatch(scheduler, /קריאת מצב חלקית|בדיקת תרחישים נכשלה/);
});
