import { sendZone } from "./hydrawise";
import type { Action, Rule } from "./rules";
import { TuyaClient } from "./tuya";
import type { DeviceView, Env, Snapshot } from "./types";

export type Planned =
  | { type: "switch"; deviceId: string; code: string; value: boolean; label: string }
  | { type: "dimmer"; deviceId: string; code: string; on?: boolean; percent?: number; label: string }
  | { type: "curtain"; deviceId: string; command?: "open" | "close" | "stop"; position?: number; label: string }
  | { type: "ac"; deviceId: string; infraredId: string; remoteId: string; power: number; mode: number; temp: number; wind: number; label: string }
  | { type: "zone"; relayId: number; command: "run" | "stop" | "suspend"; minutes?: number; suspendHours?: number; label: string };

export function planRuleActions(rule: Pick<Rule, "actions">, snap: Snapshot, opts: { skipIfZoneRunning: boolean }): { planned: Planned[]; notes: string[] } {
  const devices = snap.sections.flatMap((s) => s.devices);
  const zones = snap.sections.flatMap((s) => s.zones);
  const planned: Planned[] = [];
  const notes: string[] = [];
  for (const action of rule.actions) {
    const step = planOne(action, devices, zones, opts, notes);
    if (step) planned.push(step);
  }
  return { planned, notes };
}

function planOne(
  action: Action,
  devices: DeviceView[],
  zones: Snapshot["sections"][number]["zones"],
  opts: { skipIfZoneRunning: boolean },
  notes: string[],
): Planned | null {
  if (action.type === "zone") {
    const zone = zones.find((z) => (action.relayId != null ? z.relayId === action.relayId : z.name === action.zoneName));
    if (!zone || zone.relayId == null) {
      notes.push(`אזור ${action.zoneName || ""} לא זמין`);
      return null;
    }
    if (opts.skipIfZoneRunning && action.command === "run" && zone.running) {
      notes.push(`${zone.name} כבר משקה, דילוג`);
      return null;
    }
    return {
      type: "zone",
      relayId: zone.relayId,
      command: action.command,
      minutes: action.minutes,
      suspendHours: action.suspendHours,
      label: zone.name,
    };
  }
  const device = devices.find((d) => d.id === action.deviceId) || devices.find((d) => d.name === action.deviceName);
  if (!device) {
    notes.push(`מכשיר ${action.deviceName || action.deviceId || ""} לא נמצא`);
    return null;
  }
  if (action.type === "switch") {
    const code = action.code || device.switches[0]?.code;
    if (!code) {
      notes.push(`${device.name}: אין מתג`);
      return null;
    }
    return { type: "switch", deviceId: device.id, code, value: action.on, label: device.name };
  }
  if (action.type === "dimmer") {
    const code = action.code || device.dimmers[0]?.code;
    if (!code) {
      notes.push(`${device.name}: אין דימר`);
      return null;
    }
    return { type: "dimmer", deviceId: device.id, code, on: action.on, percent: action.percent, label: device.name };
  }
  if (action.type === "curtain") {
    return { type: "curtain", deviceId: device.id, command: action.command, position: action.position, label: device.name };
  }
  if (action.type === "ac") {
    const infraredId = device.ac?.infraredId;
    const remoteId = device.ac?.remoteId;
    if (!infraredId || !remoteId) {
      notes.push(`${device.name}: לא נמצא שלט IR`);
      return null;
    }
    const power = action.power === false ? 0 : 1;
    const mode = Number(action.mode ?? device.ac?.mode ?? 0);
    const temp = Number(action.temp ?? device.ac?.temp ?? 24);
    const wind = Number(action.wind ?? device.ac?.wind ?? 0);
    return { type: "ac", deviceId: device.id, infraredId, remoteId, power, mode, temp, wind, label: device.name };
  }
  return null;
}

export async function runPlanned(env: Env, planned: Planned[], client?: TuyaClient): Promise<{ ok: boolean; message: string }> {
  const tuya =
    client ||
    new TuyaClient({
      accessId: env.TUYA_ACCESS_ID,
      accessSecret: env.TUYA_ACCESS_SECRET,
      base: env.TUYA_BASE,
    });
  const done: string[] = [];
  const failed: string[] = [];
  for (const step of planned) {
    try {
      if (step.type === "zone") {
        const now = Math.floor(Date.now() / 1000);
        const result = await sendZone(env.HYDRAWISE_API_KEY, {
          action: step.command,
          relayId: step.relayId,
          runSeconds: step.command === "run" ? Math.round((step.minutes || 10) * 60) : undefined,
          suspendUntilEpoch: step.command === "suspend" ? now + Math.round((step.suspendHours || 24) * 3600) : undefined,
        });
        if (result.message_type === "error") throw new Error(result.message || "hydrawise");
        const verb = step.command === "run" ? `השקיה ${step.minutes} דק׳` : step.command === "stop" ? "עצירה" : "השהיה";
        done.push(`${step.label}: ${verb}`);
      } else if (step.type === "switch") {
        const r = await tuya.sendCommands(step.deviceId, [{ code: step.code, value: step.value }]);
        if (!r.success) throw new Error(r.msg || "tuya");
        done.push(`${step.label}: ${step.value ? "דולק" : "כבוי"}`);
      } else if (step.type === "dimmer") {
        const commands: { code: string; value: unknown }[] = [];
        if (step.on != null) commands.push({ code: step.code, value: step.on });
        if (step.percent != null) {
          const brightCode = step.code.replace("switch_led_", "bright_value_");
          commands.push({ code: brightCode, value: Math.round((step.percent / 100) * 1000) });
        }
        const r = await tuya.sendCommands(step.deviceId, commands);
        if (!r.success) throw new Error(r.msg || "tuya");
        done.push(`${step.label}: דימר`);
      } else if (step.type === "curtain") {
        const commands: { code: string; value: unknown }[] = [];
        if (step.command) commands.push({ code: "control", value: step.command });
        if (step.position != null) commands.push({ code: "percent_control", value: step.position });
        const r = await tuya.sendCommands(step.deviceId, commands);
        if (!r.success) throw new Error(r.msg || "tuya");
        done.push(`${step.label}: ${step.command || step.position + "%"}`);
      } else if (step.type === "ac") {
        const r = await tuya.sendAcCommand(step.infraredId, step.remoteId, {
          power: step.power,
          mode: step.mode,
          temp: step.temp,
          wind: step.wind,
        });
        if (!r.success) throw new Error(r.msg || "tuya ir");
        done.push(`${step.label}: ${step.power ? "דולק" : "כבוי"} ${step.temp}°`);
      }
    } catch (err) {
      failed.push(`${step.label}: ${err instanceof Error ? err.message : "שגיאה"}`);
    }
  }
  const ok = failed.length === 0 && done.length > 0;
  const message = [...done, ...failed].join(" · ") || "אין פעולות";
  return { ok, message };
}

const SWITCH_CODE = /^(switch(_led)?_\d+|PowerOnOff)$/;
const BRIGHT_CODE = /^bright_value_\d+$/;

export function validateCommands(commands: { code?: string; value?: unknown }[]): { code: string; value: boolean | number | string }[] {
  if (!Array.isArray(commands) || !commands.length || commands.length > 8) {
    throw new Error("פקודה לא תקינה");
  }
  return commands.map((c) => {
    const code = String(c.code || "");
    if (SWITCH_CODE.test(code)) {
      const on = c.value === true || c.value === 1 || c.value === "1" || c.value === "true";
      const off = c.value === false || c.value === 0 || c.value === "0" || c.value === "false";
      if (!on && !off) throw new Error("ערך מתג לא תקין");
      return { code, value: on };
    }
    if (BRIGHT_CODE.test(code)) {
      const n = Number(c.value);
      if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error("בהירות לא תקינה");
      return { code, value: Math.round(n) };
    }
    if (code === "control") {
      const v = String(c.value);
      if (v !== "open" && v !== "close" && v !== "stop") throw new Error("פקודת תריס לא תקינה");
      return { code, value: v };
    }
    if (code === "percent_control") {
      const n = Number(c.value);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error("מיקום תריס לא תקין");
      return { code, value: Math.round(n) };
    }
    throw new Error("קוד פקודה לא נתמך");
  });
}

export function validateAcBody(body: { power?: unknown; mode?: unknown; temp?: unknown; wind?: unknown }): {
  power: number;
  mode: number;
  temp: number;
  wind: number;
} {
  const power = body.power === true || body.power === 1 || body.power === "1" ? 1 : 0;
  const mode = Number(body.mode ?? 0);
  const temp = Number(body.temp ?? 24);
  const wind = Number(body.wind ?? 0);
  if (![0, 1, 2, 3, 4].includes(mode)) throw new Error("מצב מזגן לא תקין");
  if (![0, 1, 2, 3].includes(wind)) throw new Error("עוצמת מאוורר לא תקינה");
  if (!Number.isFinite(temp) || temp < 16 || temp > 30) throw new Error("טמפרטורה בין 16 ל-30");
  return { power, mode, temp: Math.round(temp), wind };
}
