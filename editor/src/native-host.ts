import type { HostTransport } from "./editor-host-api";
import type { HostRequest, HostResponse, HostEvent } from "../../protocol/types";
declare global { interface Window {
  localNotesHostReceive?: (message: HostResponse | HostEvent) => void;
  chrome?: { webview?: { postMessage(message: string): void } };
} }
export class NativeHostTransport implements HostTransport {
  private listeners = new Set<(message: HostResponse | HostEvent) => void>();
  constructor() { window.localNotesHostReceive = message => { for (const listener of this.listeners) listener(message); }; }
  subscribe(listener: (message: HostResponse | HostEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  send(message: HostRequest | HostEvent) {
    const raw = JSON.stringify(message);
    const bridge = window.chrome?.webview;
    const legacy = window.external as unknown as { postMessage?(raw: string): void; sendMessage?(raw: string): void };
    if (bridge) bridge.postMessage(raw);
    else if (legacy?.postMessage) legacy.postMessage(raw);
    else if (legacy?.sendMessage) legacy.sendMessage(raw);
    else throw new Error("桌面桥接不可用");
  }
}
