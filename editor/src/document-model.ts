import type { Block, BlockContent, BlockProperties, BlockType, EditorState, StyleSheet } from "../../protocol/types";

type BlockOptions = {
  id: string;
  type?: BlockType;
  parentId?: string | null;
  position?: string;
  content?: Partial<BlockContent>;
  properties?: BlockProperties;
  revision?: number;
};

export function todayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function createBlock(options: BlockOptions): Block {
  const type = options.type ?? "paragraph";
  return {
    id: options.id,
    parentId: options.parentId ?? null,
    position: options.position ?? "",
    type,
    content: { text: "", html: "", markdown: "", ...options.content },
    properties: { ...options.properties },
    revision: options.revision ?? 1
  };
}

export function createDocumentState(id: string, title: string, workspaceId?: string, systemStyles: StyleSheet[] = []): EditorState {
  return {
    note: { id, title, isSticky: false, clientVersion: 0, workspaceId },
    blocks: [], documents: [], backlinks: [], overrideNotices: [], references: [],
    databases: [], databaseRecords: {}, systemStyles: structuredClone(systemStyles),
    documentStyles: [], notebookStyles: []
  };
}
