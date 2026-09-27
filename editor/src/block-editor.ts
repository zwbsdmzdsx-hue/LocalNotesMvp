import type { Block, EditorState, ReferenceInstance } from "../../protocol/types";
import { locationSignature, syncLocationRow } from "./location-block-editor";
import { renderReferenceBody, renderReferenceHostShell, syncReferenceHostShell } from "./reference-card";
import { splitTodoSource, todoTextVariant } from "./todo-block-editor";
import type { BlockContent } from "../../protocol/types";
import { headingTextVariant } from "./heading-block-editor";
import type { TextBlockVariant } from "./text-block-editor";

export type BlockEditorServices = {
  state(): EditorState;
  mode(): "rich" | "source" | "preview";
  textRow(block: Block, variant?: TextBlockVariant): HTMLElement;
  mediaRow(block: Block): HTMLElement;
  locationRow(block: Block): HTMLElement;
  databaseRow(block: Block): HTMLElement;
  referenceCard(reference: ReferenceInstance): HTMLElement;
  referenceSignature(reference: ReferenceInstance): string;
  detachReference(hostBlockId: string): void;
};

export type BlockEditorAdapter = {
  mount(shell: HTMLElement, block: Block, services: BlockEditorServices): void;
  reconcile?(shell: HTMLElement, block: Block, services: BlockEditorServices): void;
  remountOnUpdate?: boolean;
  ordinaryReferenceHost?: boolean;
  activatesDatabasePanel?: boolean;
  splitSource?(current: Block, next: Block, source: string, start: number, end: number,
    fromMarkdown: (source: string, fallback: BlockContent) => BlockContent): string;
};

export const textBlockEditor: BlockEditorAdapter = {
  ordinaryReferenceHost: true,
  mount(shell, block, services) { shell.append(services.textRow(block)); }
};

export const headingBlockEditor: BlockEditorAdapter = {
  ordinaryReferenceHost: true,
  mount(shell, block, services) { shell.append(services.textRow(block, headingTextVariant)); }
};

export const todoBlockEditor: BlockEditorAdapter = {
  ordinaryReferenceHost: true,
  mount(shell, block, services) { shell.append(services.textRow(block, todoTextVariant)); },
  splitSource: splitTodoSource
};

export const mediaBlockEditor: BlockEditorAdapter = {
  ordinaryReferenceHost: true,
  mount(shell, block, services) { shell.append(services.mediaRow(block)); }
};

export const locationBlockEditor: BlockEditorAdapter = {
  ordinaryReferenceHost: true,
  mount(shell, block, services) {
    shell.append(services.locationRow(block));
    shell.dataset.locationSignature = locationSignature(block, services.state(), services.mode());
  },
  reconcile(shell, block, services) {
    syncLocationRow(shell, block, services.state(), services.mode(), () => services.locationRow(block));
  }
};

export const databaseBlockEditor: BlockEditorAdapter = {
  ordinaryReferenceHost: true,
  remountOnUpdate: true,
  activatesDatabasePanel: true,
  mount(shell, block, services) { shell.append(services.databaseRow(block)); }
};

function referenceFor(block: Block, services: BlockEditorServices) {
  return services.state().references.find(reference => reference.hostBlockId === block.id);
}

export const referenceBlockEditor: BlockEditorAdapter = {
  ordinaryReferenceHost: false,
  mount(shell, block, services) {
    const reference = referenceFor(block, services);
    const body = renderReferenceBody(reference, reference?.mode ?? "inline",
      services.referenceCard, services.referenceSignature);
    renderReferenceHostShell(shell, body, () => services.detachReference(block.id));
  },
  reconcile(shell, block, services) {
    syncReferenceHostShell(shell, referenceFor(block, services), services.referenceCard,
      services.referenceSignature, () => services.detachReference(block.id));
  }
};
