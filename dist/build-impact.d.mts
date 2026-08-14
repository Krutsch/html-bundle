export type ChangeKind = "html" | "module" | "json" | "css" | "asset";
export type HTMLScope = "changed" | "all" | "none";
export type BuildImpact = {
    kind: ChangeKind;
    rebuildCSS: boolean;
    rebuildInlineScripts: boolean;
    htmlScope: HTMLScope;
    copySource: boolean;
    event: "html" | "css" | "asset";
};
export type HTMLUpdate = {
    type: "html";
    file: string;
    html: string;
    previousHtml?: string;
};
export type FullReload = {
    type: "full-reload";
    file: string;
};
export declare function classifyChange(file: string): ChangeKind;
export declare function getBuildImpact(file: string): BuildImpact;
export declare function createHTMLUpdate(file: string, html: string, previousHtml?: string): HTMLUpdate;
export declare function createHTMLRebuildEvents(sourceFile: string, outputs: readonly {
    file: string;
    html: string;
    previousHtml?: string;
}[]): (HTMLUpdate | FullReload)[];
