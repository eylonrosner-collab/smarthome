export type SectionId = "garden" | "climate" | "lights" | "curtains" | "power" | "other";

export type Row = { label: string; value: string };

export type SwitchControl = { code: string; label: string; on: boolean; hidden?: boolean };

export type DimmerControl = {
  code: string;
  label: string;
  on: boolean;
  percent?: number;
  brightCode?: string;
  hidden?: boolean;
};

export type CurtainView = {
  position?: number;
  motor?: string;
  travelSeconds?: number;
};

export type AcView = {
  power: boolean;
  mode: string;
  temp: number;
  wind: string;
  infraredId?: string;
  remoteId?: string;
};

export type MetricView = {
  moisture?: number;
  temperature?: number;
  battery?: number | string;
};

export type DeviceView = {
  id: string;
  name: string;
  productName: string;
  category: string;
  online: boolean;
  icon: string;
  kindLabel: string;
  subtitle: string;
  section: SectionId;
  staleText?: string;
  rows: Row[];
  switches: SwitchControl[];
  dimmers: DimmerControl[];
  curtain?: CurtainView;
  ac?: AcView;
  metrics?: MetricView;
  readOnlyNote?: string;
  soil?: boolean;
  hidden?: boolean;
};

export type ZoneView = {
  relayId: number | null;
  relay: number;
  name: string;
  running: boolean;
  stateLabel: string;
  nextLabel: string;
  durationLabel: string;
  periodLabel: string;
  staleLabel?: string;
};

export type SectionView = {
  id: SectionId;
  icon: string;
  title: string;
  subtitle?: string;
  online: number;
  total: number;
  devices: DeviceView[];
  zones: ZoneView[];
};

export type CatalogItem = {
  kind: "device" | "zone";
  id: string;
  name: string;
  category: string;
  section: SectionId | "zone";
  relayId?: number;
  switches?: { code: string; label: string }[];
  infraredId?: string;
  remoteId?: string;
  metrics?: string[];
  curtain?: boolean;
  ac?: boolean;
  dimmer?: boolean;
};

export type Snapshot = {
  updatedAt: string;
  updatedLabel: string;
  stats: { devices: number; online: number; offline: number; zones: number };
  controller: { name: string; note: string };
  sections: SectionView[];
  errors: string[];
  catalog: CatalogItem[];
};

export type TuyaDevice = {
  id: string;
  name: string;
  customName?: string;
  category?: string;
  productName?: string;
  isOnline?: boolean;
  online?: boolean;
  updateTime?: number;
  gatewayId?: string;
  gateway_id?: string;
  parentId?: string;
  parent_id?: string;
  nodeId?: string;
  node_id?: string;
};

export interface Env {
  RULES: KVNamespace;
  AI: Ai;
  TUYA_ACCESS_ID: string;
  TUYA_ACCESS_SECRET: string;
  HYDRAWISE_API_KEY: string;
  DASH_PASSWORD: string;
  TUYA_BASE: string;
  ALLOWED_ORIGIN: string;
  AI_MODEL: string;
}
