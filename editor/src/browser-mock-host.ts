import type { HostTransport } from "./editor-host-api";
import type { HostRequest, HostResponse, HostEvent, EditorState, RequestMap, BlockContent, BlockProperties } from "../../protocol/types";

const block = (blockId: string, text: string) => ({ id: blockId, parentId: null, position: "00001000", type: "paragraph" as const, content: { text, html: text }, properties: {}, revision: 1 });
export class BrowserMockHost implements HostTransport {
  private listeners = new Set<(message: HostResponse | HostEvent) => void>();
  private docs = new Map<string, EditorState>();
  private history = ["alpha"];
  private index = 0;
  private current = "alpha";
  failNextSave = false;
  lastRequest: HostRequest | null = null;
  constructor() {
    const alpha: EditorState = { note: { id: "alpha", title: "Alpha", isSticky: false, clientVersion: 0 }, blocks: [block("a1", "浏览器编辑器核心"), { ...block("ar1", ""), type: "reference" }], documents: [{ id: "alpha", title: "Alpha" }, { id: "beta", title: "Beta" }], backlinks: [], overrideNotices: [], references: [{ id: "ref1", hostBlockId: "ar1", targetDocumentId: "beta", targetBlockId: "b1", targetTitle: "Beta", mode: "inline", blocks: [block("b1", "Beta 的实时内容")], overrides: [], hiddenBlockIds: [] }] };
    const beta: EditorState = { note: { id: "beta", title: "Beta", isSticky: false, clientVersion: 0 }, blocks: [block("b1", "Beta 的内容"), block("b2", "Beta 文档中的其他块")], documents: alpha.documents, backlinks: [], overrideNotices: [], references: [] };
    this.docs.set("alpha", alpha); this.docs.set("beta", beta);
  }
  subscribe(listener: (message: HostResponse | HostEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private respond<K extends keyof RequestMap>(request: HostRequest<K>, payload: unknown, ok = true, error?: string) {
    const response: HostResponse = { protocolVersion: 1, requestId: request.requestId, kind: request.kind, ok, payload: payload as never, error: error ? { code: "mock_error", message: error } : undefined };
    for (const listener of this.listeners) listener(response);
  }
  private state(documentId = this.current) {
    this.refreshReferenceSnapshots();
    return structuredClone(this.docs.get(documentId)!);
  }
  private refreshReferenceSnapshots() {
    for (const document of this.docs.values()) {
      for (const reference of document.references) {
        const source = this.docs.get(reference.targetDocumentId);
        reference.broken = !source || !!reference.targetBlockId && !source.blocks.some(block => block.id === reference.targetBlockId);
        if (!source) { reference.blocks = []; continue; }
        reference.targetTitle = source.note.title;
        const sourceBlocks = reference.targetBlockId
          ? this.subtree(source.blocks, reference.targetBlockId)
          : source.blocks;
        reference.blocks = [...structuredClone(sourceBlocks), ...reference.blocks.filter(block => block.scopeType === "reference_instance")];
      }
    }
  }
  private subtree(blocks: EditorState["blocks"], rootId: string) {
    const included = new Set<string>([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of blocks) {
        if (candidate.parentId && included.has(candidate.parentId) && !included.has(candidate.id)) {
          included.add(candidate.id);
          changed = true;
        }
      }
    }
    return blocks.filter((candidate) => included.has(candidate.id));
  }
  updateSourceBlock(documentId: string, blockId: string, text: string) {
    const source = this.docs.get(documentId);
    const target = source?.blocks.find((candidate) => candidate.id === blockId);
    if (!target) throw new Error("源块不存在");
    target.content = { ...target.content, text, html: text };
    target.revision += 1;
    this.refreshReferenceSnapshots();
    const event: HostEvent = { protocolVersion: 1, kind: "documentChanged", payload: { documentId } };
    for (const listener of this.listeners) listener(event);
  }
  send(message: HostRequest | HostEvent) {
    if (!("requestId" in message)) return;
    const request = message as HostRequest;
    this.lastRequest = request;
    queueMicrotask(() => {
      try {
        switch (request.kind) {
          case "ready": this.respond(request, null); break;
          case "loadDocument":
          case "reloadDocument": this.respond(request, { state: this.state(request.sourceDocumentId ?? this.current) }); break;
          case "saveDocument": {
            if (this.failNextSave) { this.failNextSave = false; this.respond(request, undefined, false, "Mock 保存失败"); break; }
            const payload = request.payload as Extract<RequestMap["saveDocument"], { documentId: string }>;
            const current = this.docs.get(payload.documentId)!;
            const previous = new Map(current.blocks.map(block => [block.id, block]));
            current.note.title = payload.title; current.note.clientVersion += 1; current.blocks = structuredClone(payload.blocks);
            current.blocks.forEach(block => {
              const old = previous.get(block.id);
              block.revision = old ? old.revision + (JSON.stringify(old.content) !== JSON.stringify(block.content) || JSON.stringify(old.properties) !== JSON.stringify(block.properties) ? 1 : 0) : 1;
            });
            for (const document of this.docs.values()) {
              const info = document.documents.find(item => item.id === current.note.id);
              if (info) info.title = current.note.title;
            }
            this.respond(request, { documentId: payload.documentId, mutationId: payload.mutationId, clientVersion: current.note.clientVersion });
            break;
          }
          case "openDocument": {
            const payload = request.payload as RequestMap["openDocument"];
            this.current = payload.documentId; this.history.splice(this.index + 1); this.history.push(this.current); this.index = this.history.length - 1; this.respond(request, null); this.emitLoaded(); break;
          }
          case "navigateBack": if (this.index > 0) this.index--; this.current = this.history[this.index]; this.respond(request, null); this.emitLoaded(); break;
          case "navigateForward": if (this.index + 1 < this.history.length) this.index++; this.current = this.history[this.index]; this.respond(request, null); this.emitLoaded(); break;
          case "executeCommand": {
            const payload = request.payload as { operation?: string; referenceInstanceId?: string; mode?: string; hostBlockId?: string; targetDocumentId?: string; targetBlockId?: string; content?: BlockContent; properties?: BlockProperties };
            const current = this.docs.get(request.sourceDocumentId ?? this.current)!;
            if (payload.operation === "create-reference" && payload.hostBlockId && payload.targetDocumentId) {
              const target = this.docs.get(payload.targetDocumentId);
              const documentInfo = current.documents.find((item) => item.id === payload.targetDocumentId);
              if (target) current.references.push({
                id: `ref-${payload.hostBlockId}`,
                hostBlockId: payload.hostBlockId,
                targetDocumentId: payload.targetDocumentId,
                targetBlockId: payload.targetBlockId,
                targetTitle: documentInfo?.title ?? "目标文档",
                mode: "inline",
                blocks: structuredClone(payload.targetBlockId ? this.subtree(target.blocks, payload.targetBlockId) : target.blocks),
                overrides: [],
                hiddenBlockIds: []
              });
            }
            if (payload.operation === "set-reference-mode" && payload.referenceInstanceId && (payload.mode === "inline" || payload.mode === "collapsed" || payload.mode === "sidebar")) {
              const reference = current.references.find((item) => item.id === payload.referenceInstanceId);
              if (reference) reference.mode = payload.mode;
            }
            const reference = current.references.find(item => item.id === payload.referenceInstanceId);
            if (reference && payload.operation === "save-override" && payload.targetBlockId && payload.content && payload.properties) {
              const source = this.docs.get(reference.targetDocumentId)?.blocks.find(block => block.id === payload.targetBlockId);
              if (!source) throw new Error("源块不存在");
              const previous = reference.overrides.find(item => item.targetBlockId === payload.targetBlockId);
              reference.overrides = reference.overrides.filter(item => item.targetBlockId !== payload.targetBlockId);
              reference.overrides.push({ targetBlockId: payload.targetBlockId, baseRevision: previous?.baseRevision ?? source.revision, patch: structuredClone({ content: payload.content, properties: payload.properties }) });
            }
            if (reference && payload.operation === "reset-override") {
              reference.overrides = reference.overrides.filter(item => item.targetBlockId !== payload.targetBlockId);
              reference.hiddenBlockIds = reference.hiddenBlockIds.filter(id => id !== payload.targetBlockId);
            }
            if (reference && payload.operation === "reset-reference") {
              reference.overrides = []; reference.hiddenBlockIds = [];
              reference.blocks = reference.blocks.filter(block => block.scopeType !== "reference_instance");
            }
            this.respond(request, { state: this.state(current.note.id) });
            break;
          }
          default: this.respond(request, { state: this.state() }); break;
        }
      } catch (error) { this.respond(request, undefined, false, error instanceof Error ? error.message : String(error)); }
    });
  }
  private emitLoaded() {
    const event: HostEvent = { protocolVersion: 1, kind: "documentLoaded", payload: { state: this.state() } };
    for (const listener of this.listeners) listener(event);
  }
}
