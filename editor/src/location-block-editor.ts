import type { Block, EditorState } from "../../protocol/types";
import { previewLocation } from "./block-preview";
import type { BlockSnapshotReader } from "./block-snapshot";

export function locationSignature(block: Block, state: EditorState, mode: "rich" | "source" | "preview") {
  const location = state.locations?.find(item => item.id === block.properties.locationId);
  return JSON.stringify([mode, block.properties.locationId ?? "", block.properties.locationLabelOverride ?? "",
    location?.updatedAt ?? "", location?.deletedAt ?? ""]);
}

export function syncLocationRow(
  shell: HTMLElement, block: Block, state: EditorState, mode: "rich" | "source" | "preview",
  render: () => HTMLElement
) {
  const signature = locationSignature(block, state, mode);
  if (shell.dataset.locationSignature === signature || document.activeElement?.closest(".location-source")) return;
  shell.querySelector<HTMLElement>(":scope > .block-row")?.replaceWith(render());
  shell.dataset.locationSignature = signature;
}

export function locationPropertiesFromSource(source: string | null, block: Block | undefined) {
  if (source === null) return {
    locationId: block?.properties.locationId,
    locationLabelOverride: block?.properties.locationLabelOverride
  };
  const lines = source.split(/\r?\n/);
  const value = (key: string) => lines.find(line => line.startsWith(`${key}:`))?.slice(key.length + 1).trim();
  return {
    locationId: value("id") || block?.properties.locationId,
    locationLabelOverride: value("label") || undefined
  };
}

export const readLocationBlockSnapshot: BlockSnapshotReader = (shell, previous) => ({
  content: previous?.content ?? { text: "", html: "" },
  properties: {
    ...(previous?.properties ?? {}),
    ...locationPropertiesFromSource(shell.querySelector<HTMLElement>(":scope > .block-row > .location-source")?.textContent ?? null, previous)
  }
});

export function renderLocationRow(
  block: Block, state: EditorState, mode: "rich" | "source" | "preview",
  onSourceInput: () => void, onRemove: (row: HTMLElement) => void
) {
  const row = document.createElement("div"); row.className = "block-row location-row";
  const grip = document.createElement("button"); grip.type = "button"; grip.className = "grip";
  grip.setAttribute("aria-label", "位置块菜单"); grip.title = "位置块菜单";
  grip.draggable = mode !== "preview"; grip.textContent = "⠿";
  if (mode === "source") {
    const source = document.createElement("pre"); source.className = "location-source";
    source.contentEditable = "plaintext-only"; source.spellcheck = false;
    source.textContent = `\`\`\`localnotes-location\nid: ${block.properties.locationId ?? ""}\nlabel: ${block.properties.locationLabelOverride ?? ""}\n\`\`\``;
    source.addEventListener("input", onSourceInput);
    row.append(grip, source);
  } else row.append(grip, previewLocation(block, state));
  const remove = document.createElement("button"); remove.type = "button";
  remove.className = "delete-block"; remove.title = "删除位置块";
  remove.textContent = "×"; remove.disabled = mode === "preview";
  remove.onclick = () => onRemove(row);
  row.append(remove);
  return row;
}
