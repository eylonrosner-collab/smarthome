import { planRuleActions, runPlanned } from "./execute";
import { shouldFire, worldFromSnapshot, type Rule } from "./rules";
import { buildSnapshot } from "./snapshot";
import { appendActivity, loadRules, saveRules } from "./store";
import type { Ephemeral } from "./ephemeral";
import type { TuyaClient } from "./tuya";
import type { Env } from "./types";

export function sensorRefs(rules: Rule[]): { deviceId?: string; deviceName?: string }[] {
  const refs: { deviceId?: string; deviceName?: string }[] = [];
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger.type !== "sensor") continue;
    refs.push({ deviceId: rule.trigger.deviceId, deviceName: rule.trigger.deviceName });
    for (const condition of rule.conditions) {
      if (condition.type === "sensor") refs.push({ deviceId: condition.deviceId, deviceName: condition.deviceName });
    }
  }
  return refs;
}

export async function runScheduler(env: Env, now = new Date(), opts?: { client?: TuyaClient; store?: Ephemeral }): Promise<void> {
  const rules = await loadRules(env.RULES);
  const auto = rules.filter((r) => r.enabled && r.trigger.type !== "manual");
  if (!auto.length) return;
  let snap;
  try {
    snap = await buildSnapshot(env, {
      fresh: true,
      now,
      client: opts?.client,
      store: opts?.store,
      tuya: { mode: "sensors", refs: sensorRefs(rules) },
    });
  } catch {
    // A snapshot failure is visible on the next dashboard load. Logging it here
    // would write KV on every quiet tick.
    return;
  }
  const world = worldFromSnapshot(snap, now);
  let changed = false;
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger.type === "manual") continue;
    const decision = shouldFire(rule, world);
    if (!decision.fire) continue;
    const result = await executeSavedRule(env, rule, snap, true);
    if (result.ok) {
      rule.lastFiredAt = now.toISOString();
      if (decision.slot) rule.lastFiredSlot = decision.slot;
    } else if (rule.trigger.type === "sensor") {
      rule.lastFiredAt = now.toISOString();
    }
    rule.updatedAt = now.toISOString();
    changed = true;
    await appendActivity(env.RULES, {
      ok: result.ok,
      message: result.message,
      ruleId: rule.id,
      ruleName: rule.name,
    });
  }
  if (changed) await saveRules(env.RULES, rules);
}

export async function executeSavedRule(env: Env, rule: Rule, snap: Awaited<ReturnType<typeof buildSnapshot>>, skipIfZoneRunning: boolean) {
  const { planned, notes } = planRuleActions(rule, snap, { skipIfZoneRunning });
  if (!planned.length) return { ok: false, message: notes.join(" · ") || "אין פעולות לביצוע" };
  const result = await runPlanned(env, planned);
  if (notes.length) result.message = `${result.message} · ${notes.join(" · ")}`;
  return result;
}
