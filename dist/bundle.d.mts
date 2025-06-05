#!/usr/bin/env node
import type { Router } from "express-serve-static-core";
import { type BuildOptions } from "esbuild";
import { type Options } from "beasties";
import { type Options as MinifyOptions } from "html-minifier-terser";
declare let router: Router | undefined;
export default router;
export type Config = {
    build: string;
    src: string;
    port: number;
    secure: boolean;
    esbuild?: BuildOptions;
    "html-minifier-terser"?: MinifyOptions;
    critical?: Options;
    deletePrev?: boolean;
    isCritical?: boolean;
    hmr?: boolean;
    handler?: string;
    host?: string;
    key?: Buffer;
    cert?: Buffer;
};
