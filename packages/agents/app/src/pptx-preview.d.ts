// pptx-preview ships no types. The surface this console uses is one function:
// init(container, size) hands back a previewer whose preview(bytes) lays the
// slides out as .pptx-preview-slide-wrapper divs inside the container.
declare module "pptx-preview" {
  export function init(
    container: HTMLElement,
    options?: { width?: number; height?: number },
  ): { preview: (data: ArrayBuffer) => Promise<unknown> };
}
