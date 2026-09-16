import { mountEditor } from "./core";
import { EditorHostApi } from "./editor-host-api";
import { BrowserMockHost } from "./browser-mock-host";
import "./style.css";

const transport = new BrowserMockHost();
const host = new EditorHostApi(transport);
const editor = mountEditor(host);
void host.loadDocument("alpha").then(state => editor.load(state)).catch(editor.showError);
const bar = document.createElement("nav");
bar.className = "browser-devbar";
bar.innerHTML = '<strong>浏览器开发模式 · 仅内存数据，刷新即重置</strong><button id="dev-back" title="后退">←</button><button id="dev-forward" title="前进">→</button><button data-doc="alpha">Alpha</button><button data-doc="beta">Beta</button><button id="dev-fail">模拟下次保存失败</button><button id="dev-retry">重试保存</button>';
document.body.prepend(bar);
bar.querySelectorAll<HTMLButtonElement>("[data-doc]").forEach(b => b.onclick = () => void editor.flush().then(() => host.openDocument(b.dataset.doc!)).catch(editor.showError));
bar.querySelector<HTMLButtonElement>("#dev-back")!.onclick = () => void editor.flush().then(() => host.navigateBack()).catch(editor.showError);
bar.querySelector<HTMLButtonElement>("#dev-forward")!.onclick = () => void editor.flush().then(() => host.navigateForward()).catch(editor.showError);
bar.querySelector<HTMLButtonElement>("#dev-fail")!.onclick = () => transport.failNextSave = true;
bar.querySelector<HTMLButtonElement>("#dev-retry")!.onclick = () => editor.retry();
// Only the development harness exposes diagnostics.
Object.assign(window, { mockHost: transport });
