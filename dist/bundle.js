#!/usr/bin/env node
import fs from "fs";
import { performance } from "perf_hooks";
import Event from "events";
import glob from "glob";
import csso from "csso";
import esbuild from "esbuild";
import critical from "critical";
import { minify } from "html-minifier";
const isCritical = process.argv.includes("--critical");
// Performance Observer and watcher
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
const SOURCE_FOLDER = "src";
const BUILD_FOLDER = "build";
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const SCRIPT_CONTENT = /(?<=<script)(\s|.)*?(?=<\/script>)/g;
const STYLE_CONTENT = /(?<=<style)(\s|.)*?(?=<\/style>)/g;
// Remove old build dir
fs.rmSync(BUILD_FOLDER, { recursive: true, force: true });
// Glob all files and transform the code
glob(`${SOURCE_FOLDER}/**/*.html`, {}, (err, files) => {
    // Create importable and treeshaked esm files that will be imported in HTML
    createGlobalJS(err, files);
    globHandler(minifyHTML)(err, files);
    glob(`${SOURCE_FOLDER}/**/*.{ts,js}`, {}, globHandler(minifyTSJS));
    glob(`${SOURCE_FOLDER}/**/*.css`, {}, globHandler(minifyCSS));
});
function globHandler(minifyFn) {
    return (err, files) => {
        if (err) {
            console.error(err);
            process.exit(1);
        }
        expectedTasks += files.length;
        if (files.length &&
            (files[0].endsWith(".ts") || files[0].endsWith(".js"))) {
            minifyFn(files);
            return;
        }
        files.forEach((filename) => {
            const buildFilename = filename.replace(`${SOURCE_FOLDER}/`, `${BUILD_FOLDER}/`);
            const buildFilenameArr = buildFilename.split("/");
            buildFilenameArr.pop();
            const buildPathDir = buildFilenameArr.join("/");
            fs.mkdir(buildPathDir, { recursive: true }, (err) => {
                if (err) {
                    console.error(err);
                    process.exit(1);
                }
                minifyFn(filename, buildFilename);
            });
        });
    };
}
function createGlobalJS(err, files) {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    // Create folders
    fs.mkdirSync(BUILD_FOLDER, { recursive: true });
    // Glob all inline scripts and create importable files
    const scriptFilenames = [];
    files.forEach((filename) => {
        const fileText = fs.readFileSync(filename, { encoding: "utf-8" });
        fileText.match(SCRIPT_CONTENT)?.forEach((script, index) => {
            const src = script.slice(script.indexOf(">") + 1).trim();
            let buildFilename = filename
                .slice(filename.indexOf("src/") + 4)
                .replace(".html", `-${index}.ts`);
            const buildFilenameArr = buildFilename.split("/");
            buildFilenameArr.pop();
            if (buildFilenameArr.length) {
                const buildPathDir = buildFilenameArr.join("/");
                fs.mkdirSync(buildPathDir, { recursive: true });
            }
            scriptFilenames.push(buildFilename);
            fs.writeFileSync(buildFilename, src);
        });
    });
    esbuild.buildSync({
        entryPoints: scriptFilenames,
        charset: "utf8",
        format: "esm",
        splitting: true,
        bundle: true,
        minify: true,
        outdir: BUILD_FOLDER,
    });
    scriptFilenames.forEach((file) => {
        fs.rmSync(file);
        const buildPathArr = file.split("/");
        buildPathArr.pop();
        if (buildPathArr.length) {
            const buildPathDir = buildPathArr.join("/");
            const length = fs.readdirSync(buildPathDir).length;
            if (!length)
                fs.rmdir(buildPathDir, () => {
                    if (err)
                        throw err;
                });
        }
    });
}
function minifyTSJS(files) {
    esbuild
        .build({
        entryPoints: files,
        charset: "utf8",
        format: "esm",
        splitting: true,
        bundle: true,
        minify: true,
        outdir: BUILD_FOLDER,
    })
        .then(() => {
        taskEmitter.emit("done");
    });
}
function minifyCSS(filename, buildFilename) {
    fs.readFile(filename, { encoding: "utf-8" }, (err, fileText) => {
        if (err)
            throw err;
        fs.writeFile(buildFilename, csso.minify(fileText).css, (err) => {
            if (err)
                throw err;
            taskEmitter.emit("done");
        });
    });
}
function minifyHTML(filename, buildFilename) {
    fs.readFile(filename, { encoding: "utf-8" }, (err, fileText) => {
        if (err)
            throw err;
        // Minify Code
        fileText.match(SCRIPT_CONTENT)?.forEach((script, index) => {
            const source = script.slice(script.indexOf(">") + 1).trim();
            let src = source;
            // Use bundled file and remove it from fs
            const bundledFile = buildFilename.replace(".html", `-${index}.js`);
            src = fs.readFileSync(bundledFile, { encoding: "utf-8" });
            fs.rmSync(bundledFile);
            // Replace src with generated code
            fileText = fileText.replace(source, src.replace(TEMPLATE_LITERAL_MINIFIER, ""));
        });
        // Minify Inline Style
        fileText.match(STYLE_CONTENT)?.forEach((styleElement) => {
            const style = styleElement.slice(styleElement.indexOf(">") + 1).trim();
            fileText = fileText.replace(style, csso.minify(style).css);
        });
        // Minify HTML
        fileText = minify(fileText, {
            collapseWhitespace: true,
        });
        if (isCritical) {
            const buildFilenameArr = buildFilename.split("/");
            const fileWithBase = buildFilenameArr.pop();
            const buildDir = buildFilenameArr.join("/");
            critical.generate({
                base: buildDir,
                html: fileText,
                target: fileWithBase,
                minify: true,
                inline: true,
                extract: true,
                rebase: () => { },
            });
            taskEmitter.emit("done");
        }
        else {
            fs.writeFile(buildFilename, fileText, (err) => {
                if (err)
                    throw err;
                taskEmitter.emit("done");
            });
        }
    });
}
