import assert from "node:assert/strict";
import test from "node:test";
import { controllerNote, presentZones, setZoneParams } from "../src/hydrawise.ts";
import { isSoilSensor, presentDevice, sectionOf } from "../src/present.ts";
import type { TuyaDevice } from "../src/types.ts";

const now = new Date("2026-10-11T13:56:00.000Z");

test("devices land in the same groups as the read-only dashboard", () => {
  const dev = (partial: Partial<TuyaDevice>): TuyaDevice => ({ id: "x", name: "x", ...partial });
  assert.equal(sectionOf(dev({ name: "תאורת שביל", category: "tdq" })), "garden");
  assert.equal(sectionOf(dev({ name: "מזגן סלון", category: "qt" })), "climate");
  assert.equal(sectionOf(dev({ name: "מזגן סלון", category: "wnykq" })), "climate");
  assert.equal(sectionOf(dev({ name: "תריס מטבח", category: "clkg" })), "curtains");
  assert.equal(sectionOf(dev({ name: "תאורת סלון", category: "kg" })), "lights");
  assert.equal(sectionOf(dev({ name: "Boiler", category: "kg" })), "power");
  assert.equal(sectionOf(dev({ name: "דוד שמש", category: "tdq" })), "power");
  assert.equal(sectionOf(dev({ name: "ZigBee Gateway", category: "wg2" })), "other");
  assert.equal(sectionOf(dev({ name: "לחות אדמת הדשא", category: "zwjcy" })), "garden");
  assert.equal(isSoilSensor({ category: "zwjcy", name: "sensor" }), true);
});

test("soil status exposes moisture, temperature and battery", () => {
  const card = presentDevice(
    { id: "soil", name: "חיישן", category: "zwjcy", isOnline: true },
    { humidity_value: 280, temp_current: 235, battery_percentage: 86 },
    {},
    now,
  );
  assert.equal(card.soil, true);
  assert.equal(card.section, "garden");
  assert.equal(card.metrics?.moisture, 28);
  assert.equal(card.metrics?.temperature, 23.5);
  assert.equal(card.metrics?.battery, 86);
  assert.ok(card.rows.some((r) => r.label === "לחות קרקע" && r.value === "28%"));
});

test("switch gangs, curtains and AC keep the Hebrew status fields", () => {
  const sw = presentDevice(
    { id: "s", name: "תאורת סלון", customName: "תאורת סלון", category: "kg", isOnline: true, productName: "2gang" },
    { switch_1: false, switch_2: true },
    { switch_1: "ספוטים", switch_2: "אור גדול" },
    now,
  );
  assert.deepEqual(sw.switches.map((s) => [s.label, s.on]), [
    ["ספוטים", false],
    ["אור גדול", true],
  ]);

  const curtain = presentDevice(
    { id: "c", name: "תריס סלון חדש", category: "clkg", isOnline: true },
    { percent_control: 100, control: "stop" },
    {},
    now,
  );
  assert.equal(curtain.curtain?.position, 100);
  assert.equal(curtain.curtain?.motor, "עצור");

  const ac = presentDevice(
    { id: "a", name: "מזגן סלון", category: "qt", isOnline: false, updateTime: 1750000000 },
    { power: "0", mode: "4", temp: 25, wind: "1" },
    {},
    now,
    { infraredId: "ir", remoteId: "remote" },
  );
  assert.equal(ac.ac?.power, false);
  assert.equal(ac.ac?.infraredId, "ir");
  assert.equal(ac.online, false);
  assert.match(ac.staleText || "", /נראה לאחרונה/);
});

test("hydrawise run, stop and suspend parameters", () => {
  assert.deepEqual(setZoneParams({ action: "run", relayId: 5, runSeconds: 600 }), {
    action: "run",
    relay_id: "5",
    period_id: "999",
    custom: "600",
  });
  assert.deepEqual(setZoneParams({ action: "stop", relayId: 5 }), { action: "stop", relay_id: "5" });
  assert.equal(setZoneParams({ action: "suspend", relayId: 5, suspendUntilEpoch: 1_800_000_000 }).custom, "1800000000");
  assert.equal(setZoneParams({ action: "resume", relayId: 5 }).period_id, "0");
});

test("zone schedule uses Jerusalem labels", () => {
  const tomorrowSix = Math.floor(Date.parse("2026-10-12T03:00:00.000Z") / 1000);
  const base = Math.floor(now.getTime() / 1000);
  const zones = presentZones(
    {
      time: base,
      relays: [
        { relay_id: 9, relay: 4, name: "Back Lawn", time: tomorrowSix - base, run: 900, period: 3 * 86400 },
        { relay_id: 8, relay: 1, name: "Drip", time: 1, run: 600, timestr: "Now" },
      ],
    },
    now,
  );
  assert.equal(zones[0].name, "Drip");
  assert.equal(zones[0].running, true);
  assert.match(zones[0].stateLabel, /משקה/);
  assert.equal(zones[1].nextLabel, "מחר 06:00");
  assert.equal(zones[1].periodLabel, "כל 3 ימים");
  const note = controllerNote({ name: "My Controller", status: "All Good", last_contact: base - 120 }, { message: "OK" }, now);
  assert.match(note, /All Good/);
  assert.match(note, /OK/);
});
