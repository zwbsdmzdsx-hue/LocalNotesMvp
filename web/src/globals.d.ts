declare global {
  interface Window {
    chrome?: { webview?: { postMessage(message: string): void } };
    localNotesError?: (message: string) => void;
    localNotesSaved?: (documentId: string) => void;
    localNotesFlush?: (requestId?: string) => void;
    localNotesRunAcceptanceEdit?: (marker: string) => void;
  }
}
export {};
