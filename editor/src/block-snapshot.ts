import type { Block, BlockContent, BlockProperties } from "../../protocol/types";

export type BlockSnapshotContext = {
  mode: "rich" | "source" | "preview";
  columnGroup: string | undefined;
  column: number | undefined;
  sourceText(editable: HTMLElement): string;
  contentFromMarkdown(source: string, fallback: BlockContent): BlockContent;
  contentFromRichEditable(editable: HTMLElement, fallback: BlockContent): BlockContent;
  headingLevelFromMarkdown(content: BlockContent): 1 | 2 | 3 | 4 | 5 | 6 | undefined;
};

export type BlockSnapshotReader = (
  shell: HTMLElement, previous: Block | undefined, context: BlockSnapshotContext
) => { content: BlockContent; properties: BlockProperties };

export const readStaticBlockSnapshot: BlockSnapshotReader = (_shell, previous) => ({
  content: previous?.content ?? { text: "", html: "" },
  properties: previous?.properties ?? {}
});
