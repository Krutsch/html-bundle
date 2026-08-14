import { copyFile, mkdir, readFile } from "fs/promises";
import path from "path";
import http from "http";
import express from "express";
import httpolyglot from "httpolyglot";
import postcssrc from "postcss-load-config";
import cssnano from "cssnano";
import { createSSEAdapter } from "./hmr-sse.mjs";
import { addHMRCode as transformHMRCode, } from "./html-transformation.mjs";
export const bundleConfig = await getBundleConfig();
export function addHMRCode(html, file, ast) {
    return transformHMRCode(html, file, ast, bundleConfig.src);
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
    const sse = createSSEAdapter({ keepAlive: !isSecure });
    serverSentEvents = sse.publish;
    router.get("/hmr", (req, reply) => {
        sse.connect(req, reply);
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
export function listenOnAvailablePort(server, port, host) {
    return new Promise((resolve, reject) => {
        let candidatePort = port;
        const listen = () => {
            const onListening = () => {
                server.removeListener("error", onError);
                const address = server.address();
                if (!address || typeof address === "string") {
                    reject(new Error("Server did not expose a listening port"));
                    return;
                }
                resolve(address.port);
            };
            const onError = (error) => {
                server.removeListener("listening", onListening);
                if (error.code !== "EADDRINUSE") {
                    reject(error);
                    return;
                }
                if (candidatePort >= 65535) {
                    reject(error);
                    return;
                }
                candidatePort += 1;
                listen();
            };
            server.once("listening", onListening);
            server.once("error", onError);
            server.listen({ port: candidatePort, host });
        };
        listen();
    });
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
