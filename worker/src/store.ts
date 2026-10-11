import type { Rule } from "./rules";

export type ActivityEvent = {
  id: string;
  at: string;
  ok: boolean;
  message: string;
  ruleId?: string;
  ruleName?: string;
};

const RULES_KEY = "rules";
const ACTIVITY_KEY = "activity";
const MAX_ACTIVITY = 80;

export async function loadRules(kv: KVNamespace): Promise<Rule[]> {
  const raw = await kv.get(RULES_KEY, "json");
  return Array.isArray(raw) ? (raw as Rule[]) : [];
}

export async function saveRules(kv: KVNamespace, rules: Rule[]): Promise<void> {
  await kv.put(RULES_KEY, JSON.stringify(rules));
}

export async function loadActivity(kv: KVNamespace): Promise<ActivityEvent[]> {
  const raw = await kv.get(ACTIVITY_KEY, "json");
  return Array.isArray(raw) ? (raw as ActivityEvent[]) : [];
}

export async function appendActivity(kv: KVNamespace, event: Omit<ActivityEvent, "id" | "at"> & { at?: string }): Promise<ActivityEvent> {
  const list = await loadActivity(kv);
  const saved: ActivityEvent = {
    id: crypto.randomUUID(),
    at: event.at || new Date().toISOString(),
    ok: event.ok,
    message: event.message,
    ruleId: event.ruleId,
    ruleName: event.ruleName,
  };
  list.unshift(saved);
  await kv.put(ACTIVITY_KEY, JSON.stringify(list.slice(0, MAX_ACTIVITY)));
  return saved;
}
