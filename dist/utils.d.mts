import type { Config } from "./bundle.mjs";
import type { Router } from "express-serve-static-core";
import { type Server } from "http";
import { type Server as HTTPSServer } from "https";
import postcssrc from "postcss-load-config";
import cssnano from "cssnano";
import { parse, parseFragment } from "parse5";
export declare const bundleConfig: Config;
export declare function fileCopy(file: string): Promise<void>;
export declare function createDir(file: string): Promise<string | undefined>;
export declare function getBuildPath(file: string): string;
export declare let serverSentEvents: undefined | (({ file, html }: {
    file: string;
    html?: string;
}) => void);
export declare function createDefaultServer(isSecure: boolean): Promise<[Router, Server | HTTPSServer]>;
export declare function getPostCSSConfig(): Promise<postcssrc.Result | {
    plugins: (typeof cssnano)[];
    options: {};
    file: string;
}>;
export declare function addHMRCode(html: string, file: string, ast?: ReturnType<typeof parse | typeof parseFragment>): string;
