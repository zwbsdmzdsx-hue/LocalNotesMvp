import type { EditorCommand } from "../../protocol/types";
import type { PanelHandle } from "./module-registry";
import { panelDataState } from "./panel-context";
import { LocationManager, type LocationManagerState } from "./location-manager";

export type LocationPanelActions = {
  execute(command: EditorCommand, label: string): Promise<void>;
  insert(locationId: string): void;
  onError(error: unknown): void;
};

export function mountLocationsPanel(slot: HTMLElement, actions: LocationPanelActions): PanelHandle {
  let current: LocationManagerState | null = null;
  let signature = "";
  const manager = new LocationManager({
    panel: slot,
    getState: () => current,
    execute: actions.execute,
    insert: actions.insert,
    onError: actions.onError
  });
  return {
    update(context) {
      const state = context ? panelDataState(context) : null;
      current = state ? {
        locations: state.locations ?? [],
        locationVersion: state.locationVersion ?? 0,
        notebookId: state.note.workspaceId
      } : null;
      const next = state ? `${state.note.id}:${JSON.stringify(current)}` : "";
      if (next === signature) return;
      signature = next;
      manager.render();
    },
    dispose() {
      manager.dispose();
      slot.replaceChildren();
    }
  };
}
