import type { CatalogItem } from "./types";
import { extractJsonObject } from "./json";

export const RULE_SYSTEM_PROMPT = `You translate a smart-home request into ONE JSON object and nothing else.
The user writes in Hebrew or English. Use only devices and zones from the catalog (copy ids and names exactly).
Catalog names and switch labels are the display names the user chose. Match those names.
Times are Asia/Jerusalem, 24-hour HH:MM. Weekdays: 0=Sunday ... 6=Saturday. Omit days for every day.
Schema:
{
  "name": "short name",
  "cooldownMinutes": 180,
  "trigger": { "type": "time", "time": "19:00", "days": [0,1,2,3,4,5,6] }
    | { "type": "sensor", "deviceId": "", "deviceName": "", "metric": "moisture"|"temperature"|"battery", "op": "lt"|"gt"|"lte"|"gte"|"eq", "value": 30 }
    | { "type": "manual" },
  "conditions": [],
  "actions": [
    { "type": "switch", "deviceId": "", "deviceName": "", "code": "switch_1", "on": true },
    { "type": "dimmer", "deviceId": "", "deviceName": "", "code": "switch_led_1", "on": true, "percent": 40 },
    { "type": "curtain", "deviceId": "", "deviceName": "", "command": "open"|"close"|"stop", "position": 0 },
    { "type": "ac", "deviceId": "", "deviceName": "", "power": true, "mode": "0", "temp": 24, "wind": "0" },
    { "type": "zone", "zoneName": "", "relayId": 1, "command": "run"|"stop"|"suspend", "minutes": 10, "suspendHours": 24 }
  ]
}
AC mode: 0 cool, 1 heat, 2 auto, 3 fan, 4 dry. Wind: 0 auto, 1 low, 2 medium, 3 high.
"scene:" / "סצנה:" is trigger manual. A movie/סרט scene closes living-room curtains (סלון) and turns living-room lights off.
Sensor watering rules should set cooldownMinutes to at least 180.
If several curtains match "living room" / סלון, include each of them. Do not invent devices.`;

export function catalogForPrompt(catalog: CatalogItem[]): unknown[] {
  return catalog.map((c) => ({
    kind: c.kind,
    id: c.id,
    name: c.name,
    category: c.category,
    section: c.section,
    relayId: c.relayId,
    switches: c.switches,
    curtain: c.curtain || undefined,
    ac: c.ac || undefined,
    dimmer: c.dimmer || undefined,
    metrics: c.metrics,
  }));
}

export function buildAiMessages(text: string, catalog: CatalogItem[]): { role: "system" | "user"; content: string }[] {
  return [
    { role: "system", content: RULE_SYSTEM_PROMPT },
    {
      role: "user",
      content: `Catalog:\n${JSON.stringify(catalogForPrompt(catalog))}\n\nRequest:\n${text}`,
    },
  ];
}

export function extractJson(text: string): unknown {
  return extractJsonObject(text);
}

type AiBinding = {
  run: (model: string, input: { messages: { role: string; content: string }[]; max_tokens?: number; temperature?: number }) => Promise<unknown>;
};

export async function askWorkersAi(ai: AiBinding, model: string, text: string, catalog: CatalogItem[]): Promise<unknown> {
  const result = await ai.run(model, {
    messages: buildAiMessages(text, catalog),
    max_tokens: 1200,
    temperature: 0.1,
  });
  const content = aiText(result);
  if (!content) throw new Error("empty model response");
  return extractJson(content);
}

function aiText(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return "";
  const obj = result as {
    response?: unknown;
    result?: unknown;
    choices?: { message?: { content?: unknown } }[];
  };
  if (typeof obj.response === "string") return obj.response;
  if (obj.result && typeof obj.result === "object") {
    const inner = obj.result as { response?: unknown };
    if (typeof inner.response === "string") return inner.response;
  }
  const choice = obj.choices?.[0]?.message?.content;
  return typeof choice === "string" ? choice : "";
}
