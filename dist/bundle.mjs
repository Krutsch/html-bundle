#!/usr/bin/env node
import { performance } from "perf_hooks";
import { readFile, rm, writeFile, readdir, lstat } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import glob from "glob";
import postcss from "postcss";
import esbuild from "esbuild";
import Critters from "critters";
import { minify } from "html-minifier-terser";
import { watch } from "chokidar";
import { serialize, parse, parseFragment } from "parse5";
import { getTagName, findElements } from "@web/parse5-utils";
import awaitSpawn from "await-spawn";
import { fileCopy, createDefaultServer, getPostCSSConfig, getBuildPath, createDir, bundleConfig, serverSentEvents, addHMRCode, } from "./utils.mjs";
const isHMR = process.argv.includes("--hmr") || bundleConfig.hmr;
const isCritical = process.argv.includes("--isCritical") || bundleConfig.isCritical;
const critters = new Critters({
    path: bundleConfig.build,
    logLevel: "silent",
});
const isSecure = process.argv.includes("--secure") || bundleConfig.secure; // uses CSP for critical too
const handlerFile = process.argv.includes("--handler")
    ? process.argv[process.argv.indexOf("--handler") + 1]
    : bundleConfig.handler;
process.env.NODE_ENV = isHMR ? "development" : "production"; // just in case other tools are using it
let timer = performance.now();
let { plugins, options, file: postcssFile } = await getPostCSSConfig();
let CSSprocessor = postcss(plugins);
let fastify;
const inlineFiles = new Set();
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const INLINE_BUNDLE_FILE = /-bundle-\d+.tsx$/;
const SUPPORTED_FILES = /\.(html|css|jsx?|tsx?)$/;
const execFilePromise = promisify(execFile);
if (bundleConfig.deletePrev) {
    await rm(bundleConfig.build, { force: true, recursive: true });
}
glob(`${bundleConfig.src}/**/*`, build);
async function build(err, files, firstRun = true) {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    if (isHMR && firstRun) {
        fastify = await createDefaultServer(isSecure);
        fastify.listen(bundleConfig.port);
        console.log(`💻 Sever listening on port ${bundleConfig.port}.`);
    }
    for (const file of files) {
        await createDir(file);
        if (!SUPPORTED_FILES.test(file)) {
            if (handlerFile) {
                const { stdout } = await execFilePromise("node", [handlerFile, file]);
                if (String(stdout))
                    console.log("📋 Logging Handler: ", String(stdout));
            }
            else {
                if ((await lstat(file)).isDirectory())
                    continue;
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
    await minifyCode();
    for (const file of inlineFiles) {
        if (INLINE_BUNDLE_FILE.test(file)) {
            inlineFiles.delete(file);
            await rm(file);
        }
    }
    for (const file of files) {
        if (file.endsWith(".html")) {
            await minifyHTML(file, getBuildPath(file));
        }
    }
    console.log(`🚀 Build finished in ${(performance.now() - timer).toFixed(2)}ms ✨`);
    if (isHMR && firstRun) {
        console.log(`⌛ Waiting for file changes ...`);
        if (postcssFile) {
            const postCSSWatcher = watch(postcssFile);
            const tailwindCSSWatcher = watch(postcssFile.replace("postcss", "tailwind")); // Assuming that the file ext is the same
            const tsConfigWatcher = watch(postcssFile.split("\\").slice(0, -1).join("\\") + "\\tsconfig.json");
            const cssFiles = files.filter((file) => file.endsWith(".css"));
            postCSSWatcher.on("change", async () => await rebuildCSS(cssFiles, "postcss"));
            tailwindCSSWatcher.on("change", async () => await rebuildCSS(cssFiles, "tailwind"));
            tsConfigWatcher.on("change", async () => {
                timer = performance.now();
                await build(null, files, false);
            });
        }
        const watcher = watch(bundleConfig.src);
        watcher.on("add", async (file) => {
            file = String.raw `${file}`.replace(/\\/g, "/"); // glob and chokidar diff
            if (files.includes(file) || INLINE_BUNDLE_FILE.test(file)) {
                return;
            }
            await rebuild(file);
            console.log(`⚡ added ${file} to the build`);
        });
        watcher.on("change", async (file) => {
            if (INLINE_BUNDLE_FILE.test(file)) {
                return;
            }
            file = String.raw `${file}`.replace(/\\/g, "/");
            await rebuild(file);
            console.log(`⚡ modified ${file} on the build`);
        });
        watcher.on("unlink", async (file) => {
            if (INLINE_BUNDLE_FILE.test(file)) {
                return;
            }
            file = String.raw `${file}`.replace(/\\/g, "/");
            inlineFiles.delete(file);
            const buildFile = getBuildPath(file)
                .replace(".ts", ".js")
                .replace(".jsx", ".js");
            await rm(buildFile);
            const bfDir = buildFile.split("/").slice(0, -1).join("/");
            const stats = await readdir(bfDir);
            if (!stats.length)
                await rm(bfDir);
            console.log(`⚡ deleted ${file} from the build`);
        });
        async function rebuild(file) {
            // Rebuild all CSS because a change in any file might need to trigger PostCSS zu rebuild(e.g. Tailwind CSS)
            await rebuildCSS(files.filter((file) => file.endsWith(".css")));
            let html;
            if (file.endsWith(".html")) {
                // To refill the inlineFiles needed to build JS
                for (const htmlFile of files.filter((file) => file.endsWith(".html"))) {
                    await writeInlineScripts(htmlFile);
                }
                await minifyCode();
                for (const file of inlineFiles) {
                    if (INLINE_BUNDLE_FILE.test(file)) {
                        inlineFiles.delete(file);
                        await rm(file);
                    }
                }
                html = await minifyHTML(file, getBuildPath(file));
            }
            else if (/\.(jsx?|tsx?)$/.test(file)) {
                inlineFiles.add(file);
                await minifyCode();
            }
            else if (!file.endsWith(".css")) {
                if (handlerFile) {
                    const { stdout } = await execFilePromise("node", [handlerFile, file]);
                    if (String(stdout))
                        console.log("📋 Logging Handler: ", String(stdout));
                }
                else {
                    await fileCopy(file);
                }
            }
            serverSentEvents?.({ file, html });
        }
    }
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
        console.error(err);
    }
}
async function minifyCode() {
    try {
        return await esbuild.build({
            entryPoints: Array.from(inlineFiles),
            charset: "utf8",
            format: "esm",
            incremental: isHMR,
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
        // Stop app from crashing.
    }
    catch (err) {
        if (!isHMR) {
            console.error(err);
        }
        let missingPkg = false;
        if (err?.errors) {
            for (const error of err.errors) {
                if (error.text?.startsWith("Could not resolve")) {
                    missingPkg = true;
                    const packageNameRegex = /(?<=").*(?=")/;
                    const [pkgName] = error.text.match(packageNameRegex);
                    await awaitSpawn(process.platform === "win32" ? "npm.cmd" : "npm", [
                        "install",
                        pkgName,
                    ]);
                    console.log(`📦 Package ${pkgName} was installed for you`);
                }
            }
            if (missingPkg) {
                missingPkg = false;
                return minifyCode();
            }
        }
    }
}
const htmlFilesCache = new Map();
async function writeInlineScripts(file) {
    let fileText = await readFile(file, { encoding: "utf-8" });
    let DOM;
    if (fileText.includes("<!DOCTYPE html>") || fileText.includes("<html")) {
        DOM = parse(fileText);
    }
    else {
        DOM = parseFragment(fileText);
    }
    if (isHMR) {
        fileText = addHMRCode(fileText, file, DOM);
    }
    htmlFilesCache.set(file, [fileText, DOM]);
    const scripts = findElements(DOM, (e) => getTagName(e) === "script");
    for (let index = 0; index < scripts.length; index++) {
        const script = scripts[index];
        const scriptTextNode = script.childNodes[0];
        const isReferencedScript = script.attrs.find((a) => a.name === "src");
        const scriptContent = scriptTextNode?.value;
        if (!scriptContent || isReferencedScript)
            continue;
        const jsFile = file.replace(".html", `-bundle-${index}.tsx`);
        inlineFiles.add(jsFile);
        await writeFile(jsFile, scriptContent);
    }
}
async function minifyHTML(file, buildFile) {
    let fileText, DOM;
    if (htmlFilesCache.has(file)) {
        const cache = htmlFilesCache.get(file);
        fileText = cache[0];
        DOM = cache[1];
    }
    else {
        fileText = await readFile(file, { encoding: "utf-8" });
        if (fileText.includes("<!DOCTYPE html>") || fileText.includes("<html")) {
            DOM = parse(fileText);
        }
        else {
            DOM = parseFragment(fileText);
        }
    }
    // Minify Code
    const scripts = findElements(DOM, (e) => getTagName(e) === "script");
    for (let index = 0; index < scripts.length; index++) {
        const script = scripts[index];
        const scriptTextNode = script.childNodes[0];
        const isReferencedScript = script.attrs.find((a) => a.name === "src");
        if (!scriptTextNode?.value || isReferencedScript)
            continue;
        // Use bundled file
        const buildInlineScript = buildFile.replace(".html", `-bundle-${index}.js`);
        const scriptContent = await readFile(buildInlineScript, {
            encoding: "utf-8",
        });
        await rm(buildInlineScript);
        scriptTextNode.value = scriptContent.replace(TEMPLATE_LITERAL_MINIFIER, " ");
    }
    // Minify Inline Style
    const styles = findElements(DOM, (e) => getTagName(e) === "style");
    for (const style of styles) {
        const node = style.childNodes[0];
        const styleContent = node?.value;
        if (!styleContent)
            continue;
        const { css } = await CSSprocessor.process(styleContent, {
            ...options,
            from: undefined,
        });
        node.value = css;
    }
    fileText = serialize(DOM);
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
            fileText = await critters.process(fileText);
            // fix critters jsdom
            if (isPartical) {
                fileText = fileText.replace(/<\/?(html|head|body)>/g, "");
            }
        }
        catch (err) {
            console.error(err);
        }
    }
    await writeFile(buildFile, fileText);
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
