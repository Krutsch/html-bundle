import { copyFile, mkdir, readFile } from "fs/promises";
import path from "path";
import http from "http";
import express from "express";
import httpolyglot from "httpolyglot";
import postcssrc from "postcss-load-config";
import cssnano from "cssnano";
import { parse, parseFragment, serialize } from "parse5";
import { createScript, getTagName, findElement } from "@web/parse5-utils";
export const bundleConfig = await getBundleConfig();
// The HMR client runtime is authored in src/hmr-client.ts and compiled by tsc to
// dist/hmr-client.js alongside this module (a real file, so its code is never
// mangled by template-literal escaping). Read it once and substitute the per-page
// tokens on demand in buildHMRClient().
let hmrClientTemplate = "";
try {
    hmrClientTemplate = await readFile(new URL("./hmr-client.js", import.meta.url), "utf-8");
}
catch {
    // Only needed when --hmr is active; addHMRCode tolerates an empty template.
}
export function fileCopy(file) {
    return copyFile(file, getBuildPath(file));
}
export function createDir(file) {
    const buildPath = getBuildPath(file);
    const dir = buildPath.split("/").slice(0, -1).join("/");
    return mkdir(dir, { recursive: true });
}
export function getBuildPath(file) {
    return file.replace(`${bundleConfig.src}/`, `${bundleConfig.build}/`);
}
const CONNECTIONS = new Set(); // In order to send the HMR information
export let serverSentEvents;
export async function createDefaultServer(isSecure) {
    const router = express.Router();
    const app = express();
    if (isSecure) {
        app.use((req, res, next) => {
            const socket = req.socket;
            if (socket.encrypted) {
                next();
                return;
            }
            const host = req.headers.host || getDefaultHost();
            res.redirect(307, `https://${host}${req.originalUrl || req.url}`);
        });
    }
    app.use(router);
    app.use(express.static(path.join(process.cwd(), bundleConfig.build)));
    router.get("/hmr", (req, reply) => {
        reply.setHeader("Content-Type", "text/event-stream");
        reply.setHeader("Cache-Control", "no-cache");
        !isSecure && reply.setHeader("Connection", "keep-alive");
        reply.flushHeaders();
        CONNECTIONS.add(reply);
        req.on("close", () => {
            CONNECTIONS.delete(reply);
        });
        serverSentEvents = (event) => {
            CONNECTIONS.forEach((rep) => {
                if (rep.destroyed || rep.writableEnded) {
                    CONNECTIONS.delete(rep);
                    return;
                }
                rep.write(`data: ${JSON.stringify(event)}\n\n`);
            });
        };
    });
    app.use(async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        const file = await readFile(path.join(process.cwd(), bundleConfig.build, "index.html"), {
            encoding: "utf-8",
        });
        res.send(file);
    });
    const secureOptions = isSecure
        ? {
            key: bundleConfig.key ||
                (await readFile(path.join(process.cwd(), "localhost-key.pem"))),
            cert: bundleConfig.cert ||
                (await readFile(path.join(process.cwd(), "localhost.pem"))),
        }
        : undefined;
    return [
        router,
        isSecure
            ? httpolyglot.createServer(secureOptions, app)
            : http.createServer({}, app),
    ];
}
function getDefaultHost() {
    const host = bundleConfig.host === "::" ? "localhost" : bundleConfig.host;
    return `${host}:${bundleConfig.port}`;
}
export async function getPostCSSConfig() {
    try {
        return await postcssrc({});
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // postcssrc throws "No PostCSS Config found" when the project is zero-config;
        // that is expected, so stay silent. Any other failure (e.g. a broken config
        // or a TypeScript config that cannot be loaded) would otherwise silently
        // degrade the build to cssnano-only, so surface it.
        if (!/No PostCSS Config found/i.test(message)) {
            console.error(`\u26A0\uFE0F  Could not load your PostCSS config \u2013 falling back to cssnano only. ${message}`);
        }
        return { plugins: [cssnano], options: {}, file: "" };
    }
}
async function getBundleConfig() {
    const base = {
        build: "build",
        src: "src",
        port: 5000,
        esbuild: {},
        "html-minifier-terser": {},
        deletePrev: true,
        critical: {},
        isCritical: false,
        hmr: false,
        secure: false,
        handler: "",
        host: "::",
    };
    try {
        const cfgPath = path.resolve(process.cwd(), "bundle.config.js");
        const config = await import(`file://${cfgPath}`);
        return { ...base, ...config.default };
    }
    catch {
        return base;
    }
}
const htmlIdMap = new Map();
export function addHMRCode(html, file, ast) {
    if (!htmlIdMap.has(file)) {
        htmlIdMap.set(file, randomText());
    }
    const id = htmlIdMap.get(file);
    const script = createScript({ type: "module", "data-hmr-client": id }, buildHMRClient(file, id, bundleConfig.src));
    let DOM;
    if (html.includes("<!DOCTYPE html>") || html.includes("<html")) {
        DOM = ast || parse(html);
        const headNode = findElement(DOM, (e) => getTagName(e) === "head");
        insertHeadClient(headNode, script);
    }
    else {
        DOM = ast || parseFragment(html);
        prependChild(DOM, script);
    }
    //@ts-ignore
    DOM.childNodes.forEach((node) => node.attrs?.push({ name: "data-hmr", value: id }));
    return serialize(DOM);
}
function randomText() {
    return Math.random().toString(32).slice(2);
}
// Produce the per-page HMR client by substituting tokens into the shared runtime
// template (src/hmr-client.ts). The runtime is injected as an inline module so
// esbuild bundles hydro-js for it, but it coordinates through a single global hub
// so every composed page shares one EventSource and patches its own region.
function buildHMRClient(file, id, src) {
    return hmrClientTemplate
        .replaceAll("__HMR_FILE__", file)
        .replaceAll("__HMR_ID__", id)
        .replaceAll("__HMR_SRC__", src);
}
function prependChild(parent, node) {
    // Insert as the first child so the HMR client runs before the page's own
    // scripts — required for window.htmlBundleHMR.dispose()/data to be usable on
    // initial load.
    node.parentNode = parent;
    parent.childNodes.unshift(node);
}
function insertHeadClient(parent, node) {
    const children = parent.childNodes;
    const lastBaseIndex = children.findLastIndex((child) => getTagName(child) === "base");
    node.parentNode = parent;
    children.splice(lastBaseIndex + 1, 0, node);
}
