import type { EditorState, SaveMutation, EditorCommand, HostRequest, HostResponse, HostEvent, RequestMap, ResultMap } from "../../protocol/types";

export interface HostTransport {
  send(message: HostRequest | HostEvent): void;
  subscribe(receive: (message: HostResponse | HostEvent) => void): () => void;
}
export class EditorHostApi {
  private pending = new Map<string, { kind: string; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(event: HostEvent) => void>();
  readonly dispose: () => void;
  constructor(private transport: HostTransport) {
    const unsubscribe = transport.subscribe(message => {
      if (message.protocolVersion !== 1) return;
      if ("requestId" in message) {
        const pending = this.pending.get(message.requestId);
        if (!pending || pending.kind !== message.kind) return;
        clearTimeout(pending.timer); this.pending.delete(message.requestId);
        message.ok ? pending.resolve(message.payload) : pending.reject(new Error(message.error?.message ?? "宿主请求失败"));
      } else for (const listener of this.listeners) listener(message);
    });
    this.dispose = () => {
      unsubscribe();
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("宿主已断开")); }
      this.pending.clear(); this.listeners.clear();
    };
  }
  request<K extends keyof RequestMap>(kind: K, payload: RequestMap[K], sourceDocumentId?: string): Promise<ResultMap[K]> {
    const requestId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    const message: HostRequest<K> = { protocolVersion: 1, requestId, kind, sourceDocumentId, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("宿主响应超时（未确认保存）")); }, 10000);
      this.pending.set(requestId, { kind, resolve, reject, timer });
      try { this.transport.send(message); } catch (error) {
        clearTimeout(timer); this.pending.delete(requestId); reject(error);
      }
    });
  }
  onEvent(listener: (event: HostEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: HostEvent) { this.transport.send(event); }
  async loadDocument(documentId: string): Promise<EditorState> { return (await this.request("loadDocument", { documentId }, documentId)).state; }
  saveDocument(payload: SaveMutation) { return this.request("saveDocument", payload, payload.documentId); }
  storeMedia(payload: RequestMap["storeMedia"]) { return this.request("storeMedia", payload); }
  openDocument(documentId: string, blockId?: string) { return this.request("openDocument", { documentId, blockId }); }
  navigateBack() { return this.request("navigateBack", {}); }
  navigateForward() { return this.request("navigateForward", {}); }
  executeCommand(command: EditorCommand, sourceDocumentId: string) {
    return this.request("executeCommand", command, sourceDocumentId);
  }
  showNotification(message: string, level: "info" | "error" = "info") { return this.request("showNotification", { message, level }); }
}
