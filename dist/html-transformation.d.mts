import type { TextNode } from "@web/parse5-utils";
import { parse, parseFragment } from "parse5";
export type ParsedHTML = ReturnType<typeof parse | typeof parseFragment>;
type InlineScript = {
    index: number;
    node: TextNode;
    sourceFile: string;
};
export type HTMLTransformerOptions = {
    src: string;
    build: string;
    hmr: boolean;
};
export declare class HTMLFileTransformation {
    readonly file: string;
    readonly DOM: ParsedHTML;
    readonly scripts: readonly InlineScript[];
    constructor(file: string, DOM: ParsedHTML, scripts: InlineScript[]);
    getInlineStyles(): TextNode[];
    applyBundledScripts(buildFile: string): Promise<void>;
    serialize(): string;
}
export declare class HTMLTransformer {
    private readonly options;
    private readonly files;
    private readonly generatedFilesSet;
    private readonly removedFilesSet;
    constructor(options: HTMLTransformerOptions);
    prepare(file: string): Promise<HTMLFileTransformation>;
    get(file: string): HTMLFileTransformation | undefined;
    generatedFiles(): string[];
    takeRemovedFiles(): string[];
    remove(file: string): Promise<void>;
    cleanupGeneratedFiles(): Promise<void>;
    cleanupStaleInlineBundleFiles(): Promise<void>;
    private removeGeneratedFile;
    private getBuildPath;
}
export declare function addHMRCode(html: string, file: string, ast?: ParsedHTML, src?: string): string;
export {};
