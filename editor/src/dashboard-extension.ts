import type { DashboardSettingValue } from "../../protocol/types";

export type DashboardExternalSetting = {
  key: string;
  label: string;
  control: "text" | "url" | "number" | "checkbox" | "select";
  defaultValue?: DashboardSettingValue;
  options?: Array<{ value: string; label: string }>;
};

export type DashboardExternalContext = {
  widgetId: string;
  settings: Readonly<Record<string, DashboardSettingValue>>;
  signal: AbortSignal;
  refresh(): void;
};

// Extensions are registered by trusted application code. Loading third-party code,
// credentials, crawling and cross-origin requests need a separate host capability.
export type DashboardExternalWidget = {
  kind: string;
  title: string;
  icon?: string;
  settings?: DashboardExternalSetting[];
  mount(container: HTMLElement, context: DashboardExternalContext): void | (() => void) | Promise<void | (() => void)>;
};
