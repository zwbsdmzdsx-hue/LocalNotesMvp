import { mountEditor } from "./core";
import { EditorHostApi } from "./editor-host-api";
import { BrowserMockHost } from "./browser-mock-host";
import { mountShell } from "./shell";
import { createBrowserWorkspace } from "./browser-workspace";
import "./style.css";

const transport = new BrowserMockHost();
const host = new EditorHostApi(transport);

const workspace = createBrowserWorkspace(transport, {
  flush: () => editor.flush(),
  reloadCurrent: async () => {
    if (transport.current) editor.load(await host.loadDocument(transport.current));
    else editor.clear();
  }
});
const shell = mountShell(workspace, {
  onFocusBlock: id => editor.focusBlock(id),
  onError: error => editor.showError(error),
  onRestoreHistory: entryId => void editor.restoreHistory(entryId),
  onOpenDocument: (id, blockId) => {
    void editor.flush().then(() => host.openDocument(id, blockId)).then(() => {
      shell.highlightActiveDocument(id);
    }).catch(editor.showError);
  },
  onNavigateBack: () => {
    void editor.flush().then(() => host.navigateBack()).catch(editor.showError);
  },
  onNavigateForward: () => {
    void editor.flush().then(() => host.navigateForward()).catch(editor.showError);
  },
  onOpenSticky: () => {
    alert("便签窗口：浏览器模式下是占位提示。桌面端请从主窗口新建便签。");
  },
  onCreateNote: () => {
    void editor.flush().then(async () => {
      const id = transport.createDocument("新建笔记 " + new Date().toLocaleTimeString());
      await host.openDocument(id);
      shell.highlightActiveDocument(id);
    }).catch(editor.showError);
  }
});

const editor = mountEditor(host, {
  showReferences: () => shell.showReferences(),
  showHistory: () => shell.showHistory(),
  setDatabaseContext: (visible, activate) => shell.setDatabaseContext(visible, activate),
  updateHistory: model => shell.updateHistory(model)
});
host.onEvent(event => { if (event.kind === "documentLoaded") shell.highlightActiveDocument(event.payload.state.note.id); });
transport.subscribe(message => {
  if ("requestId" in message && message.ok && message.kind === "saveDocument") shell.refresh();
});

void host.loadDocument("alpha").then(state => editor.load(state)).then(() => {
  shell.highlightActiveDocument("alpha");
}).catch(editor.showError);

const bar = document.createElement("nav");
bar.className = "browser-devbar";
bar.innerHTML = '<strong>浏览器开发模式 · 仅内存数据，刷新即重置</strong><button id="dev-back" title="后退">←</button><button id="dev-forward" title="前进">→</button><button data-doc="alpha">Alpha</button><button data-doc="beta">Beta</button><button data-doc="gamma">Gamma</button><button id="dev-fail">模拟下次保存失败</button><button id="dev-retry">重试保存</button><button id="dev-reset-layout">重置布局</button>';
document.body.prepend(bar);
bar.querySelectorAll<HTMLButtonElement>("[data-doc]").forEach(b => b.onclick = () => void editor.flush().then(() => host.openDocument(b.dataset.doc!)).then(() => shell.highlightActiveDocument(b.dataset.doc!)).catch(editor.showError));
bar.querySelector<HTMLButtonElement>("#dev-back")!.onclick = () => void editor.flush().then(() => host.navigateBack()).catch(editor.showError);
bar.querySelector<HTMLButtonElement>("#dev-forward")!.onclick = () => void editor.flush().then(() => host.navigateForward()).catch(editor.showError);
bar.querySelector<HTMLButtonElement>("#dev-fail")!.onclick = () => transport.failNextSave = true;
bar.querySelector<HTMLButtonElement>("#dev-retry")!.onclick = () => editor.retry();
bar.querySelector<HTMLButtonElement>("#dev-reset-layout")!.onclick = () => { localStorage.removeItem("lnm-shell-layout-v1"); location.reload(); };
Object.assign(window, { mockHost: transport, shell });
