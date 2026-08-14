export type ParsedDOM = Document | Element | DocumentFragment | Text;
export type HTMLPatchMessage = {
    html: string;
    previousHtml?: string;
};
export type DOMRenderer = {
    parse(htmlText: string): ParsedDOM;
    render(element: Node, where?: Node | string | false, shouldSchedule?: boolean): void;
    withoutReactivity<T>(parse: () => T): T;
};
export type DOMPatcherOptions = {
    regionSelector: string;
    clientSelector: string;
    getLastHTML(): string | undefined;
    setLastHTML(html: string): void;
    bust(url: string): string;
};
export declare function createDOMPatcher(renderer: DOMRenderer, options: DOMPatcherOptions): {
    patch(message: HTMLPatchMessage, liveDocument: Document): boolean;
};
export declare function createNativeDOMRenderer(): DOMRenderer;
