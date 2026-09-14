declare global {
  interface Window {
    chrome?: { webview?: { postMessage(message: string): void } };
  }
}
export {};
