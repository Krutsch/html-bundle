import { readFile, rm, writeFile } from "fs/promises";
import { glob } from "glob";
import { sep } from "path";
import { parse, parseFragment, serialize } from "parse5";
import { createScript, findElement, findElements, getTagName, } from "@web/parse5-utils";
const INLINE_BUNDLE_FILE = /-bundle-\d+.tsx$/;
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const hmrIds = new Map();
let hmrClientTemplate = "";
try {
    hmrClientTemplate = await readFile(new URL("./hmr-client.js", import.meta.url), "utf-8");
}
catch {
    // The template is optional outside a compiled package, such as type checks.
}
export class HTMLFileTransformation {
    file;
    DOM;
    scripts;
    constructor(file, DOM, scripts) {
        this.file = file;
        this.DOM = DOM;
        this.scripts = scripts;
    }
    getInlineStyles() {
        return findElements(this.DOM, (e) => getTagName(e) === "style").map((style) => style.childNodes[0]);
    }
    async applyBundledScripts(buildFile) {
        for (const { index, node } of this.scripts) {
            const buildInlineScript = buildFile.replace(".html", `-bundle-${index}.js`);
            try {
                const scriptContent = await readFile(buildInlineScript, {
                    encoding: "utf-8",
                });
                await rm(buildInlineScript);
                node.value = scriptContent.replace(TEMPLATE_LITERAL_MINIFIER, " ");
            }
            catch {
                // esbuild may not emit a file after a recoverable transformation error.
            }
        }
    }
    serialize() {
        return serialize(this.DOM);
    }
}
export class HTMLTransformer {
    options;
    files = new Map();
    generatedFilesSet = new Set();
    removedFilesSet = new Set();
    constructor(options) {
        this.options = options;
    }
    async prepare(file) {
        const previous = this.files.get(file);
        let fileText = await readFile(file, { encoding: "utf-8" });
        let DOM = parseHTML(fileText);
        if (this.options.hmr) {
            fileText = addHMRCode(fileText, file, DOM, this.options.src);
            DOM = parseHTML(fileText);
        }
        const scripts = findElements(DOM, (e) => getTagName(e) === "script")
            .map((script, index) => {
            const scriptTextNode = script.childNodes[0];
            const isReferencedScript = script.attrs.find((a) => a.name === "src");
            const type = script.attrs.find((a) => a.name === "type");
            const scriptContent = scriptTextNode?.value;
            if (!scriptContent ||
                isReferencedScript ||
                type?.value === "importmap" ||
                type?.value === "application/ld+json") {
                return undefined;
            }
            const sourceFile = file.replace(".html", `-bundle-${index}.tsx`);
            return { index, node: scriptTextNode, sourceFile };
        })
            .filter((script) => script !== undefined);
        const currentFiles = new Set(scripts.map(({ sourceFile }) => sourceFile));
        const staleFiles = previous?.scripts
            .map(({ sourceFile }) => sourceFile)
            .filter((sourceFile) => !currentFiles.has(sourceFile)) || [];
        await Promise.all(staleFiles.map((sourceFile) => this.removeGeneratedFile(sourceFile)));
        await Promise.all(scripts.map(({ sourceFile, node }) => {
            this.generatedFilesSet.add(sourceFile);
            return writeFile(sourceFile, node.value);
        }));
        const transformation = new HTMLFileTransformation(file, DOM, scripts);
        this.files.set(file, transformation);
        return transformation;
    }
    get(file) {
        return this.files.get(file);
    }
    generatedFiles() {
        return Array.from(this.generatedFilesSet);
    }
    takeRemovedFiles() {
        const files = Array.from(this.removedFilesSet);
        this.removedFilesSet.clear();
        return files;
    }
    async remove(file) {
        const transformation = this.files.get(file);
        if (!transformation)
            return;
        this.files.delete(file);
        await Promise.all(transformation.scripts.map(({ sourceFile }) => this.removeGeneratedFile(sourceFile)));
    }
    async cleanupGeneratedFiles() {
        const files = this.generatedFiles();
        await Promise.all(files.map((file) => rm(file, { force: true })));
        this.generatedFilesSet.clear();
    }
    async cleanupStaleInlineBundleFiles() {
        const staleFiles = await glob(`${this.options.src}/**/*-bundle-*.tsx`);
        await Promise.all(staleFiles.map((file) => rm(file.replaceAll(sep, "/"), { force: true })));
    }
    async removeGeneratedFile(sourceFile) {
        this.generatedFilesSet.delete(sourceFile);
        this.removedFilesSet.add(sourceFile);
        const buildFile = this.getBuildPath(sourceFile).replace(/\.tsx$/, ".js");
        await Promise.all([
            rm(sourceFile, { force: true }),
            rm(buildFile, { force: true }),
            rm(`${buildFile}.map`, { force: true }),
        ]);
    }
    getBuildPath(file) {
        return file.replace(`${this.options.src}/`, `${this.options.build}/`);
    }
}
export function addHMRCode(html, file, ast, src = "__HMR_SRC__") {
    if (!hmrIds.has(file))
        hmrIds.set(file, randomText());
    const id = hmrIds.get(file);
    const script = createScript({ type: "module", "data-hmr-client": id }, buildHMRClient(file, id, src));
    let DOM;
    if (isDocumentHTML(html)) {
        DOM = ast || parse(html);
        const headNode = findElement(DOM, (e) => getTagName(e) === "head");
        insertHeadClient(headNode, script);
    }
    else {
        DOM = ast || parseFragment(html);
        prependChild(DOM, script);
    }
    //@ts-ignore parse5 utility node shape is intentionally structural here.
    DOM.childNodes.forEach((node) => node.attrs?.push({ name: "data-hmr", value: id }));
    return serialize(DOM);
}
function parseHTML(html) {
    return isDocumentHTML(html) ? parse(html) : parseFragment(html);
}
function isDocumentHTML(html) {
    const trimmed = html.trimStart().toLowerCase();
    return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}
function buildHMRClient(file, id, src) {
    return hmrClientTemplate
        .replaceAll("__HMR_FILE__", file)
        .replaceAll("__HMR_ID__", id)
        .replaceAll("__HMR_SRC__", src);
}
function prependChild(parent, node) {
    node.parentNode = parent;
    parent.childNodes.unshift(node);
}
function insertHeadClient(parent, node) {
    const children = parent.childNodes;
    const lastBaseIndex = children.findLastIndex((child) => getTagName(child) === "base");
    node.parentNode = parent;
    children.splice(lastBaseIndex + 1, 0, node);
}
function randomText() {
    return Math.random().toString(32).slice(2);
}
