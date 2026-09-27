import type { ModuleRegistry, PanelDefinition, PanelHandle } from "./module-registry";
import type { PanelContext } from "./panel-context";

export function mountPanelHost(tabs: HTMLElement, body: HTMLElement, registry: ModuleRegistry<PanelDefinition>) {
  const handles = new Map<string, PanelHandle>();
  tabs.replaceChildren();
  body.replaceChildren();
  for (const panel of registry.entries().sort((a, b) => a.order - b.order)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sidebar-tab";
    button.dataset.paneBtn = panel.id;
    button.title = panel.label;
    button.setAttribute("aria-label", panel.label);
    button.textContent = panel.icon;
    tabs.append(button);

    const section = document.createElement("section");
    section.id = `${panel.id}-section`;
    section.dataset.panel = panel.id;
    section.className = "relations-section";
    const head = document.createElement("div");
    head.className = "panel-head";
    const title = document.createElement("span");
    title.textContent = panel.label;
    head.append(title);
    const slot = document.createElement("div");
    slot.id = panel.slotId ?? panel.id;
    slot.className = "relations-slot";
    slot.dataset.slot = panel.id;
    section.append(head, slot);
    body.append(section);
    const handle = panel.mount(slot);
    if (!handle?.update || !handle.dispose) throw new Error(`右栏面板 ${panel.id} 缺少更新或销毁接口`);
    handles.set(panel.id, handle);
  }
  return {
    handle<T extends PanelHandle = PanelHandle>(id: string): T {
      const handle = handles.get(id);
      if (!handle) throw new Error(`右栏面板未挂载：${id}`);
      return handle as T;
    },
    activate(id: string) {
      const handle = handles.get(id);
      if (!handle) throw new Error(`右栏面板未挂载：${id}`);
      handle.activate?.();
    },
    update(context: PanelContext | null, active: string) {
      for (const panel of registry.entries()) {
        const available = panel.available(context);
        const button = tabs.querySelector<HTMLElement>(`[data-pane-btn="${CSS.escape(panel.id)}"]`)!;
        const section = body.querySelector<HTMLElement>(`[data-panel="${CSS.escape(panel.id)}"]`)!;
        button.hidden = !available;
        button.classList.toggle("active", panel.id === active && available);
        section.hidden = panel.id !== active || !available;
        handles.get(panel.id)!.update(context);
      }
    },
    dispose() {
      handles.forEach(handle => handle.dispose());
      handles.clear();
      tabs.replaceChildren();
      body.replaceChildren();
    }
  };
}
