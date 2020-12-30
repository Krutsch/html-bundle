#!/usr/bin/env node
import fs from "fs";
import glob from "glob";
import csso from "csso";
import esbuild from "esbuild";
import { minify } from "html-minifier";
import { performance } from "perf_hooks";
import Event from "events";
// Performance Observer
const taskEmitter = new Event.EventEmitter();
const start = performance.now();
let expectedTasks = 0; // This will be set in globHandler
let finishedTasks = 0;
taskEmitter.on("done", () => {
    finishedTasks++;
    if (finishedTasks === expectedTasks) {
        console.log(`🚀 Build finished in ${(performance.now() - start).toFixed(2)}ms ✨`);
    }
});
// Remove old dir
fs.rmSync("build", { recursive: true, force: true });
const SOURCE_FOLDER = "src";
const BUILD_FOLDER = "build";
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const IMPORT_STATEMENT = /import(\s|.)*?from\s+['"](\s|.)*?['"]/g;
const IMPORT_FEATURES = /(?<=import)(\s|.)*(?=from)/;
const IMPORT_PACKAGE = /(?<=from\s+)(\s|.)*/;
const UNSTRINGIFY = /['"]/g;
const DESTRUCTURE = /[^,{}]+/g;
const SCRIPT_CONTENT = /<script(\s|.)*?<\/script>/g;
const UNSCRIPT_START = /<script.*?>/;
const UNSCRIPT_END = /<\/script>/;
const STYLE_CONTENT = /<style>(\s|.)*?<\/style>/g;
// Glob all files and transform the code
glob(`${SOURCE_FOLDER}/**/*.html`, {}, createGlobalJS); // Create importable and treeshaked esm files that will be imported in HTML
glob(`${SOURCE_FOLDER}/**/*.html`, {}, globHandler(minifyHTML));
glob(`${SOURCE_FOLDER}/**/*.{ts,js}`, {}, globHandler(minifyTSJS));
glob(`${SOURCE_FOLDER}/**/*.css`, {}, globHandler(minifyCSS));
function globHandler(minifyFn) {
    return (err, files) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        expectedTasks += files.length;
        files.forEach((filename) => {
            const buildFilename = filename.replace(`${SOURCE_FOLDER}/`, `${BUILD_FOLDER}/`);
            const buildFilenameArr = buildFilename.split("/");
            buildFilenameArr.pop(); // In order to create the dir
            const buildPathDir = buildFilenameArr.join("/");
            fs.mkdir(buildPathDir, { recursive: true }, (err) => {
                if (err) {
                    console.error(err);
                    process.exit(1);
                }
                minifyFn(filename, buildFilename);
                taskEmitter.emit("done");
            });
        });
    };
}
const HTMLGlobalDependency = new Map();
function createGlobalJS(err, files) {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    // Create folders
    fs.mkdirSync(`${BUILD_FOLDER}/tmp`, { recursive: true }); // for esbuild
    fs.mkdirSync(`${BUILD_FOLDER}/globals`, { recursive: true });
    // Glob all import statements in order to create one global importable file for each package
    let imports = [];
    files.forEach((filename) => {
        const fileText = fs.readFileSync(filename, { encoding: "utf-8" });
        const importStatements = fileText.match(IMPORT_STATEMENT);
        importStatements && imports.push(...importStatements);
    });
    imports.forEach((importLine) => {
        let [pkg] = importLine.match(IMPORT_PACKAGE);
        pkg = pkg.trim().replace(UNSTRINGIFY, "");
        if (pkg.startsWith("."))
            return; // File will be transformed already
        const [importFeatureString] = importLine.match(IMPORT_FEATURES);
        const importFeatures = importFeatureString
            .match(DESTRUCTURE)
            .map((singleImport) => singleImport.trim())
            .filter(Boolean);
        if (HTMLGlobalDependency.has(pkg)) {
            const pkgSet = HTMLGlobalDependency.get(pkg);
            importFeatures.forEach((feature) => pkgSet.add(feature));
        }
        else {
            HTMLGlobalDependency.set(pkg, new Set(importFeatures));
        }
    });
    // Create TS file
    HTMLGlobalDependency.forEach((importLines, pkg) => {
        fs.writeFileSync(`${BUILD_FOLDER}/tmp/${pkg}.ts`, `export { ${Array.from(importLines).join(",")} } from "${pkg}";`);
    });
    // Bundle TS files
    esbuild.buildSync({
        entryPoints: Array.from(HTMLGlobalDependency.keys()).map((pkg) => `${BUILD_FOLDER}/tmp/${pkg}.ts`),
        format: "esm",
        bundle: true,
        minify: true,
        outdir: `${BUILD_FOLDER}/globals`,
    });
    fs.rmSync(`${BUILD_FOLDER}/tmp`, { recursive: true, force: true });
}
function minifyTSJS(filename, buildFilename) {
    esbuild.buildSync({
        entryPoints: [filename],
        format: "esm",
        bundle: true,
        minify: true,
        outfile: buildFilename.replace(".ts", ".js"),
    });
}
function minifyCSS(filename, buildFilename) {
    const fileText = fs.readFileSync(filename, { encoding: "utf-8" });
    fs.writeFileSync(buildFilename, csso.minify(fileText).css);
}
function minifyHTML(filename, buildFilename) {
    let fileText = fs.readFileSync(filename, { encoding: "utf-8" });
    // Minify Code
    // Transpile Inline Script (TS)
    const scriptElements = fileText.match(SCRIPT_CONTENT);
    scriptElements?.forEach((scriptElement) => {
        let script = scriptElement
            .replace(UNSCRIPT_START, "")
            .replace(UNSCRIPT_END, "");
        const unmodifiedScript = script;
        const importStatements = script.match(IMPORT_STATEMENT);
        importStatements?.forEach((importLine) => {
            script = script.replace(importLine, importLine.replace(IMPORT_PACKAGE, (originalPKG) => {
                const pkg = originalPKG.trim().replace(UNSTRINGIFY, "");
                return pkg.startsWith(".") ? originalPKG : ` "./globals/${pkg}.js"`;
            }));
        });
        const transpiled = esbuild.transformSync(script, {
            charset: "utf8",
            color: true,
            loader: "ts",
            format: "esm",
            minify: true,
        });
        // Replace script with generated code
        fileText = fileText.replace(unmodifiedScript, transpiled.code.replace(TEMPLATE_LITERAL_MINIFIER, ""));
    });
    // Minify Inline Style
    const styleElements = fileText.match(STYLE_CONTENT);
    styleElements?.forEach((styleElement) => {
        const style = styleElement.replace(/<\/?style>/g, "");
        fileText = fileText.replace(style, csso.minify(style).css);
    });
    // Minify HTML
    fileText = minify(fileText, {
        collapseWhitespace: true,
    });
    fs.writeFileSync(buildFilename, fileText);
}
