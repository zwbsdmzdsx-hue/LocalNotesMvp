declare module "../../web/node_modules/pptx-preview/dist/pptx-preview.es.js" {
  export function init(dom: HTMLElement, options: { width: number; height: number; mode: "list" | "slide" }): { preview(data: ArrayBuffer): Promise<unknown> };
}
