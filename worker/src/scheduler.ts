import { planRuleActions, runPlanned } from "./execute";
import { shouldFire, worldFromSnapshot, type Rule } from "./rules";
import { buildSnapshot } from "./snapshot";
import { appendActivity, loadRules, saveRules } from "./store";
import type { Env } from "./types";

export async function runScheduler(env: Env, now = new Date()): Promise<void> {
  const rules = await loadRules(env.RULES);
  const auto = rules.filter((r) => r.enabled && r.trigger.type !== "manual");
  if (!auto.length) return;
  let snap;
  try {
    snap = await buildSnapshot(env, { fresh: true, now });
  } catch (err) {
    await appendActivity(env.RULES, {
      ok: false,
      message: `בדיקת תרחישים נכשלה: ${err instanceof Error ? err.message : "שגיאה"}`,
    });
    return;
  }
  if (snap.errors.length) {
    await appendActivity(env.RULES, { ok: false, message: `קריאת מצב חלקית: ${snap.errors.join(" · ")}` });
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
