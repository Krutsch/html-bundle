#!/usr/bin/env node
import { performance } from "perf_hooks";
import { readFile, rm, writeFile, readdir, lstat } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { dirname, join, sep } from "path";
import { availableParallelism } from "os";
import { glob } from "glob";
import postcss from "postcss";
import esbuild from "esbuild";
import pLimit from "p-limit";
import Beasties from "beasties";
import { minify } from "html-minifier-terser";
import { watch } from "chokidar";
import awaitSpawn from "await-spawn";
import { fileCopy, createDefaultServer, getPostCSSConfig, getBuildPath, createDir, bundleConfig, serverSentEvents, listenOnAvailablePort, } from "./utils.mjs";
import { HTMLTransformer } from "./html-transformation.mjs";
import { createHTMLRebuildEvents, getBuildImpact } from "./build-impact.mjs";
const isHMR = process.argv.includes("--hmr") || bundleConfig.hmr;
const isCritical = process.argv.includes("--isCritical") || bundleConfig.isCritical;
const beasties = new Beasties({
    path: bundleConfig.build,
    logLevel: "silent",
    ...bundleConfig.critical,
});
const isSecure = process.argv.includes("--secure") || bundleConfig.secure; // uses CSP for critical too
const handlerFile = process.argv.includes("--handler")
    ? process.argv[process.argv.indexOf("--handler") + 1]
    : bundleConfig.handler;
const defaultHandlerConcurrency = availableParallelism();
const handlerConcurrency = getHandlerConcurrency();
const limitHandler = pLimit(handlerConcurrency);
const htmlTransformer = new HTMLTransformer({
    src: bundleConfig.src,
    build: bundleConfig.build,
    hmr: Boolean(isHMR),
});
process.env.NODE_ENV = isHMR ? "development" : "production"; // just in case other tools are using it
let timer = performance.now();
let { plugins, options, file: postcssFile } = await getPostCSSConfig();
let CSSprocessor = postcss(plugins);
let router;
const inlineFiles = new Set();
const INLINE_BUNDLE_FILE = /-bundle-\d+.tsx$/;
const SUPPORTED_FILES = /\.(html|css|jsx?|tsx?)$/;
const CONFIG_EXTENSIONS = ["js", "mjs", "cjs", "ts", "mts", "cts"];
const execFilePromise = promisify(execFile);
if (bundleConfig.deletePrev) {
    await rm(bundleConfig.build, { force: true, recursive: true });
}
async function cleanupStaleInlineBundleFiles() {
    await htmlTransformer.cleanupStaleInlineBundleFiles();
}
async function bundleInlineCode() {
    try {
        await minifyCode();
    }
    finally {
        const generatedFiles = htmlTransformer.generatedFiles();
        await htmlTransformer.cleanupGeneratedFiles();
        generatedFiles.forEach((file) => inlineFiles.delete(file));
    }
}
async function build(files, firstRun = true) {
    const handlerTasks = [];
    for (const file of files) {
        if (INLINE_BUNDLE_FILE.test(file)) {
            continue;
        }
        await createDir(file);
        if (!SUPPORTED_FILES.test(file)) {
            if ((await lstat(file)).isDirectory())
                continue;
            if (handlerFile) {
                handlerTasks.push(limitHandler(() => runHandler(file)));
            }
            else {
                await fileCopy(file);
            }
        }
        else {
            if (file.endsWith(".html")) {
                await writeInlineScripts(file);
            }
            else if (file.endsWith(".css")) {
                await minifyCSS(file, getBuildPath(file));
            }
            else {
                inlineFiles.add(file);
            }
        }
    }
    await bundleInlineCode();
    for (const file of files) {
        if (file.endsWith(".html")) {
            await minifyHTML(file, getBuildPath(file));
        }
    }
    await Promise.all(handlerTasks);
    console.log(`🚀 Build finished in ${(performance.now() - timer).toFixed(2)}ms ✨`);
    if (isHMR && firstRun) {
        const [dynamicRouter, server] = await createDefaultServer(isSecure);
        router = dynamicRouter;
        bundleConfig.port = await listenOnAvailablePort(server, bundleConfig.port, bundleConfig.host);
        console.log(`💻 Server listening on http${isSecure ? "s" : ""}://${bundleConfig.host === "::" ? "localhost" : bundleConfig.host}:${bundleConfig.port} and is shared in the local network.`);
        console.log(`⌛ Waiting for file changes ...`);
        const chokidarOptions = { awaitWriteFinish: false };
        let rebuildQueue = Promise.resolve();
        const enqueueRebuild = (file) => {
            rebuildQueue = rebuildQueue
                .then(() => rebuild(file))
                .catch(console.error);
            return rebuildQueue;
        };
        if (postcssFile) {
            const configDirectory = dirname(postcssFile);
            const postCSSWatcher = watch(postcssFile, chokidarOptions);
            const tailwindCSSWatcher = watch(CONFIG_EXTENSIONS.map((extension) => join(configDirectory, `tailwind.config.${extension}`)), chokidarOptions);
            const tsConfigWatcher = watch(join(configDirectory, "tsconfig.json"), chokidarOptions);
            const cssFiles = files.filter((file) => file.endsWith(".css"));
            postCSSWatcher.on("change", async () => await rebuildCSS(cssFiles, "postcss"));
            tailwindCSSWatcher.on("change", async () => await rebuildCSS(cssFiles, "tailwind"));
            tsConfigWatcher.on("change", async () => {
                timer = performance.now();
                await build(files, false);
            });
        }
        const watcher = watch(bundleConfig.src, chokidarOptions);
        watcher.on("add", async (file) => {
            file = String.raw `${file}`.replace(/\\/g, "/"); // glob and chokidar diff
            if (files.includes(file) || INLINE_BUNDLE_FILE.test(file)) {
                return;
            }
            try {
                files.push(file);
                await enqueueRebuild(file);
            }
            catch { }
            console.log(`⚡ added ${file} to the build`);
        });
        watcher.on("change", async (file) => {
            if (INLINE_BUNDLE_FILE.test(file)) {
                return;
            }
            file = String.raw `${file}`.replace(/\\/g, "/");
            await enqueueRebuild(file);
            console.log(`⚡ modified ${file} on the build`);
        });
        watcher.on("unlink", async (file) => {
            if (INLINE_BUNDLE_FILE.test(file)) {
                return;
            }
            file = String.raw `${file}`.replace(/\\/g, "/");
            const fileIndex = files.indexOf(file);
            if (fileIndex !== -1)
                files.splice(fileIndex, 1);
            inlineFiles.delete(file);
            await htmlTransformer.remove(file);
            htmlTransformer
                .takeRemovedFiles()
                .forEach((removedFile) => inlineFiles.delete(removedFile));
            const buildFile = getBuildPath(file).replace(/\.(jsx?|tsx?)$/, ".js");
            try {
                await rm(buildFile);
                const bfDir = buildFile.split("/").slice(0, -1).join("/");
                const stats = await readdir(bfDir);
                if (!stats.length)
                    await rm(bfDir);
            }
            catch { }
            serverSentEvents?.({ type: "full-reload", file });
            console.log(`⚡ deleted ${file} from the build`);
        });
        async function rebuild(file) {
            const impact = getBuildImpact(file);
            // Rebuild all CSS because a change in any file might need to trigger PostCSS zu rebuild(e.g. Tailwind CSS)
            if (impact.rebuildCSS) {
                await rebuildCSS(files.filter((file) => file.endsWith(".css")));
            }
            const htmlFiles = files.filter((f) => f.endsWith(".html"));
            if (impact.kind === "html") {
                const previousHtml = builtHTMLCache.get(file);
                // To refill the inlineFiles needed to build JS
                for (const htmlFile of htmlFiles) {
                    await writeInlineScripts(htmlFile);
                }
                await bundleInlineCode();
                const html = await minifyHTML(file, getBuildPath(file));
                serverSentEvents?.({ type: "html", file, html, previousHtml });
            }
            else if (impact.kind === "module" || impact.kind === "json") {
                // A module change alters the inlined output of whichever page(s) import
                // it. Rebuild every page, then emit only the pages whose HTML actually
                // changed; the client diff re-runs just the scripts that differ, so
                // unrelated pages keep their state.
                if (impact.copySource) {
                    if (handlerFile) {
                        try {
                            await limitHandler(() => runHandler(file));
                        }
                        catch (err) {
                            console.error(err);
                        }
                    }
                    else {
                        await fileCopy(file);
                    }
                }
                else {
                    inlineFiles.add(file);
                }
                for (const htmlFile of htmlFiles) {
                    await writeInlineScripts(htmlFile);
                }
                await bundleInlineCode();
                const outputs = [];
                for (const htmlFile of htmlFiles) {
                    const previousHtml = builtHTMLCache.get(htmlFile);
                    const html = await minifyHTML(htmlFile, getBuildPath(htmlFile));
                    outputs.push({ file: htmlFile, html, previousHtml });
                }
                for (const event of createHTMLRebuildEvents(file, outputs)) {
                    serverSentEvents?.(event);
                }
            }
            else if (impact.event === "css") {
                serverSentEvents?.({ type: "css", file });
            }
            else {
                if (handlerFile) {
                    try {
                        await limitHandler(() => runHandler(file));
                    }
                    catch (err) {
                        console.error(err);
                    }
                }
                else {
                    await fileCopy(file);
                }
                serverSentEvents?.({ type: "asset", file });
            }
        }
    }
}
function getHandlerConcurrency() {
    const value = getArgValue("--handlerConcurrency") ??
        getArgValue("--maxHandlerConcurrency") ??
        bundleConfig.handlerConcurrency ??
        bundleConfig.maxHandlerConcurrency ??
        defaultHandlerConcurrency;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        return defaultHandlerConcurrency;
    }
    return parsed;
}
function getArgValue(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}
function getInstallablePackageName(message) {
    const specifier = message.match(/"([^"]+)"/)?.[1];
    if (!specifier ||
        specifier.startsWith(".") ||
        specifier.startsWith("/") ||
        specifier.startsWith("#") ||
        specifier.includes(":")) {
        return undefined;
    }
    const parts = specifier.split("/");
    return specifier.startsWith("@")
        ? parts.length >= 2
            ? parts.slice(0, 2).join("/")
            : undefined
        : parts[0];
}
async function runHandler(file) {
    if (!handlerFile)
        return;
    const { stdout } = await execFilePromise("node", [handlerFile, file]);
    const output = String(stdout).trim();
    if (output)
        console.log("📋 Logging Handler: ", output);
}
function getErrorMessage(error) {
    if (typeof error === "object" && error !== null && "reason" in error) {
        const reason = error.reason;
        if (typeof reason === "string")
            return reason;
    }
    return error instanceof Error ? error.message : String(error);
}
async function minifyCSS(file, buildFile) {
    try {
        const fileText = await readFile(file, { encoding: "utf-8" });
        const result = await CSSprocessor.process(fileText, {
            ...options,
            from: file,
            to: buildFile,
        });
        await writeFile(buildFile, result.css);
    }
    catch (err) {
        console.error(getErrorMessage(err));
    }
}
async function minifyCode() {
    try {
        await esbuild.build({
            entryPoints: Array.from(inlineFiles),
            charset: "utf8",
            format: "esm",
            sourcemap: isHMR,
            splitting: true,
            define: {
                "process.env.NODE_ENV": `"${process.env.NODE_ENV}"`,
            },
            loader: { ".js": "jsx", ".ts": "tsx" },
            bundle: true,
            minify: true,
            outdir: bundleConfig.build,
            outbase: bundleConfig.src,
            ...bundleConfig.esbuild,
        });
    }
    catch (err) {
        let missingPkg = false;
        if (err?.errors) {
            for (const error of err.errors) {
                if (error.location && error.text?.startsWith("Could not resolve")) {
                    const pkgName = getInstallablePackageName(error.text);
                    if (!pkgName)
                        continue;
                    missingPkg = true;
                    await awaitSpawn(process.platform === "win32" ? "npm.cmd" : "npm", [
                        "install",
                        pkgName,
                    ]);
                    console.log(`📦 Package ${pkgName} was installed for you`);
                }
            }
            if (missingPkg) {
                return minifyCode();
            }
        }
        throw err;
    }
}
const builtHTMLCache = new Map();
async function writeInlineScripts(file) {
    const transformation = await htmlTransformer.prepare(file);
    htmlTransformer
        .takeRemovedFiles()
        .forEach((removedFile) => inlineFiles.delete(removedFile));
    transformation.scripts.forEach(({ sourceFile }) => inlineFiles.add(sourceFile));
}
async function minifyHTML(file, buildFile) {
    const transformation = htmlTransformer.get(file) || (await htmlTransformer.prepare(file));
    await transformation.applyBundledScripts(buildFile);
    // Minify Inline Style
    for (const node of transformation.getInlineStyles()) {
        const styleContent = node?.value;
        if (!styleContent)
            continue;
        try {
            const { css } = await CSSprocessor.process(styleContent, {
                ...options,
                from: undefined,
            });
            node.value = css;
        }
        catch (err) {
            console.error(getErrorMessage(err));
        }
    }
    let fileText = transformation.serialize();
    // Minify HTML
    try {
        fileText = await minify(fileText, {
            collapseWhitespace: true,
            removeComments: true,
            ...bundleConfig["html-minifier-terser"],
        });
    }
    catch (e) {
        console.error(e);
    }
    if (isCritical) {
        try {
            const isPartical = !fileText.startsWith("<!DOCTYPE html>");
            fileText = await beasties.process(fileText);
            // fix beasties jsdom
            if (isPartical) {
                fileText = fileText.replace(/<\/?(html|head|body)>/g, "");
            }
        }
        catch (err) {
            console.error(err);
        }
    }
    await writeFile(buildFile, fileText);
    builtHTMLCache.set(file, fileText);
    return fileText;
}
async function rebuildCSS(files, config) {
    const newConfig = await getPostCSSConfig();
    plugins = newConfig.plugins;
    options = newConfig.options;
    CSSprocessor = postcss(plugins);
    for (const file of files) {
        await minifyCSS(file, getBuildPath(file));
    }
    if (config)
        console.log(`⚡ modified ${config}.config`);
}
try {
    await cleanupStaleInlineBundleFiles();
    const files = await glob(`${bundleConfig.src}/**/*`);
    await build(files
        .map((file) => file.replaceAll(sep, "/"))
        .filter((file) => !INLINE_BUNDLE_FILE.test(file)));
}
catch (err) {
    console.error(err);
    process.exit(1);
}
export default router;
