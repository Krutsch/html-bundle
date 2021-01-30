#!/usr/bin/env node
import fs from "fs";
import { performance } from "perf_hooks";
import Event from "events";
import glob from "glob";
import path from "path";
import Fastify from "fastify";
import fastifyStatic from "fastify-static";
import postcss from "postcss";
import postcssrc from "postcss-load-config";
import cssnano from "cssnano";
import esbuild from "esbuild";
import critical from "critical";
import { minify } from "html-minifier";
import { watch } from "chokidar";
import { serialize, parse, parseFragment } from "parse5";
import { createScript, getTagName, appendChild, findElement, findElements, } from "@web/parse5-utils";
console.clear(); // findElement is logging an array for no reason
// CLI and options
const isCritical = process.argv.includes("--critical");
const isHMR = process.argv.includes("--hmr");
if (isHMR) {
    process.env.NODE_ENV = "development";
}
else {
    process.env.NODE_ENV = "production";
}
const { plugins, options } = createPostCSSConfig();
const CSSprocessor = postcss(plugins);
// Performance Observer and file watcher
const globHTML = new Event.EventEmitter();
const taskEmitter = new Event.EventEmitter();
const start = performance.now();
let expectedTasks = 0; // This will be increased in globHandlers
let finishedTasks = 0; // Current status
taskEmitter.on("done", () => {
    finishedTasks++;
    if (finishedTasks === expectedTasks) {
        console.log(`🚀 Build finished in ${(performance.now() - start).toFixed(2)}ms ✨`);
        if (isHMR) {
            console.log(`⌛ Waiting for file changes ...`);
            const watcher = watch(SOURCE_FOLDER);
            // The add watcher will add all the files initially - do not rebuild them
            let initialAdd = 0;
            let hasJSTS = false;
            watcher.on("add", (filename) => {
                filename = String.raw `${filename}`.replace(/\\/g, "/");
                if (filename.endsWith(".html") || filename.endsWith(".css")) {
                    initialAdd++;
                }
                else if (hasJSTS === false &&
                    (filename.endsWith(".js") || filename.endsWith(".ts"))) {
                    hasJSTS = true;
                    initialAdd++;
                }
                if (initialAdd <= expectedTasks)
                    return;
                const [buildFilename, buildPathDir] = getBuildNames(filename);
                fs.mkdir(buildPathDir, { recursive: true }, (err) => {
                    errorHandler(err);
                    rebuild(filename);
                    console.log(`⚡ added ${buildFilename}`);
                });
            });
            watcher.on("change", (filename) => {
                filename = String.raw `${filename}`.replace(/\\/g, "/");
                rebuild(filename);
                const [buildFilename] = getBuildNames(filename);
                console.log(`⚡ modified ${buildFilename}`);
            });
            watcher.on("unlink", (filename) => {
                filename = String.raw `${filename}`.replace(/\\/g, "/");
                const [buildFilename, buildPathDir] = getBuildNames(filename);
                fs.rm(buildFilename.replace(".ts", ".js"), (err) => {
                    errorHandler(err);
                    console.log(`⚡ deleted ${buildFilename}`);
                    const length = fs.readdirSync(buildPathDir).length;
                    if (!length)
                        fs.rmdir(buildPathDir, errorHandler);
                });
            });
        }
    }
});
// Basic configuration
const SOURCE_FOLDER = "src";
const BUILD_FOLDER = "build";
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const CONNECTIONS = []; // HMR
let htmlTasks = 0;
let serverSentEvents;
let fastify;
if (isHMR) {
    fastify = Fastify();
    fastify.register(fastifyStatic, {
        root: path.join(process.cwd(), BUILD_FOLDER),
    });
    fastify.get("/events", (_req, reply) => {
        reply.raw.setHeader("Content-Type", "text/event-stream");
        reply.raw.setHeader("Cache-Control", "no-cache");
        reply.raw.setHeader("Connection", "keep-alive");
        CONNECTIONS.push(reply.raw);
        serverSentEvents = (data) => CONNECTIONS.forEach((rep) => {
            rep.write(`data: ${JSON.stringify(data)}\n\n`);
        });
    });
}
// THE BUNDLE CODE
// Glob all files and transform the code
glob(`${SOURCE_FOLDER}/**/*.html`, {}, (err, files) => {
    errorHandler(err);
    expectedTasks += files.length;
    htmlTasks += files.length;
    if (isHMR) {
        createHMRHandlers(files);
        fastify.listen(5000);
        console.log(`💻 Sever listening on port 5000.`);
    }
});
glob(`${SOURCE_FOLDER}/**/*.css`, {}, (err, files) => {
    errorHandler(err);
    expectedTasks += files.length;
    for (const filename of files) {
        const [buildFilename, buildPathDir] = getBuildNames(filename);
        fs.mkdirSync(buildPathDir, { recursive: true });
        minifyCSS(filename, buildFilename);
    }
});
glob(`${SOURCE_FOLDER}/**/*.{ts,js}`, {}, (err, files) => {
    errorHandler(err);
    if (files.length) {
        expectedTasks += 1;
    }
    else {
        globHTML.emit("getReady");
    }
    minifyTSJS(files);
});
globHTML.on("getReady", () => {
    if (expectedTasks - htmlTasks === finishedTasks) {
        // After CSS and JS because critical needs file built css files and inline script might reference js files.
        glob(`${SOURCE_FOLDER}/**/*.html`, {}, (err, files) => {
            errorHandler(err);
            createGlobalJS(files);
            files.forEach((filename) => {
                const [buildFilename, buildPathDir] = getBuildNames(filename);
                fs.mkdirSync(buildPathDir, { recursive: true });
                minifyHTML(filename, buildFilename);
            });
        });
    }
});
function createGlobalJS(files) {
    const scriptFilenames = [];
    files.forEach((filename) => {
        const [buildFilename, buildPathDir] = getBuildNames(filename);
        const fileText = fs.readFileSync(filename, { encoding: "utf-8" });
        let DOM;
        if (fileText.includes("<!DOCTYPE html>") || fileText.includes("<html")) {
            DOM = parse(fileText);
        }
        else {
            DOM = parseFragment(fileText);
        }
        const scripts = findElements(DOM, (e) => getTagName(e) === "script");
        scripts.forEach((script, index) => {
            const scriptTextNode = script.childNodes[0];
            const isReferencedScript = script.attrs.find((a) => a.name === "src");
            //@ts-ignore
            const scriptContent = scriptTextNode?.value;
            if (!scriptContent || isReferencedScript)
                return;
            const jsFilename = buildFilename.replace(".html", `-${index}.ts`);
            fs.mkdirSync(buildPathDir, { recursive: true });
            scriptFilenames.push(jsFilename);
            fs.writeFileSync(jsFilename, scriptContent);
        });
    });
    try {
        esbuild.buildSync({
            entryPoints: scriptFilenames,
            charset: "utf8",
            format: "esm",
            define: {
                "process.env.NODE_ENV": isHMR ? '"development"' : '"production"',
            },
            splitting: true,
            bundle: true,
            minify: true,
            outdir: BUILD_FOLDER,
            outbase: BUILD_FOLDER,
        });
    }
    catch (err) {
        console.error(err);
    }
    finally {
        scriptFilenames.forEach((file) => {
            fs.rmSync(file);
        });
    }
}
function minifyTSJS(files) {
    esbuild
        .build({
        entryPoints: files,
        charset: "utf8",
        format: "esm",
        incremental: isHMR,
        splitting: true,
        define: {
            "process.env.NODE_ENV": isHMR ? '"development"' : '"production"',
        },
        bundle: true,
        minify: true,
        outdir: BUILD_FOLDER,
        outbase: "src",
    })
        .then(() => {
        taskEmitter.emit("done");
        globHTML.emit("getReady");
        if (serverSentEvents) {
            const file = files.pop().replace(".ts", ".js"); // Only one filed was modified
            const [buildFilename] = getBuildNames(file);
            const js = fs.readFileSync(buildFilename, { encoding: "utf8" });
            serverSentEvents({
                js,
                filename: buildFilename.split(`${BUILD_FOLDER}/`).pop(),
            });
        }
    })
        .catch((err) => {
        console.error(err);
    });
}
function minifyCSS(filename, buildFilename) {
    const fileText = fs.readFileSync(filename, { encoding: "utf-8" });
    CSSprocessor.process(fileText, {
        ...options,
        from: filename,
        to: buildFilename,
    })
        .then((result) => {
        fs.writeFileSync(buildFilename, result.css);
        taskEmitter.emit("done");
        globHTML.emit("getReady");
        if (serverSentEvents) {
            serverSentEvents({
                css: result.css,
                filename: buildFilename.split(`${BUILD_FOLDER}/`).pop(),
            });
        }
    })
        .catch((err) => {
        console.error(err);
    });
}
function minifyHTML(filename, buildFilename) {
    fs.readFile(filename, { encoding: "utf-8" }, async (err, fileText) => {
        errorHandler(err);
        let DOM;
        if (fileText.includes("<!DOCTYPE html>") || fileText.includes("<html")) {
            DOM = parse(fileText);
        }
        else {
            DOM = parseFragment(fileText);
        }
        // Minify Code
        const scripts = findElements(DOM, (e) => getTagName(e) === "script");
        scripts.forEach((script, index) => {
            const scriptTextNode = script.childNodes[0];
            const isReferencedScript = script.attrs.find((a) => a.name === "src");
            //@ts-ignore
            if (!scriptTextNode?.value || isReferencedScript)
                return;
            // Use bundled file and remove it from fs
            const bundledFilename = buildFilename.replace(".html", `-${index}.js`);
            try {
                const scriptContent = fs.readFileSync(bundledFilename, {
                    encoding: "utf-8",
                });
                fs.rmSync(bundledFilename);
                // Replace src with bundled code
                //@ts-ignore
                scriptTextNode.value = scriptContent.replace(TEMPLATE_LITERAL_MINIFIER, " ");
            }
            catch { }
        });
        // Minify Inline Style
        const styles = findElements(DOM, (e) => getTagName(e) === "style");
        for (const style of styles) {
            const node = style.childNodes[0];
            //@ts-ignore
            const styleContent = node?.value;
            if (!styleContent)
                continue;
            const { css } = await CSSprocessor.process(styleContent, {
                ...options,
                from: undefined,
            });
            //@ts-ignore
            node.value = css;
        }
        fileText = serialize(DOM);
        // Minify HTML
        fileText = minify(fileText, {
            collapseWhitespace: true,
        });
        if (isCritical) {
            const buildFilenameArr = buildFilename.split("/");
            const fileWithBase = buildFilenameArr.pop();
            const buildDir = buildFilenameArr.join("/");
            // critical is generating the files on the fs
            critical
                .generate({
                base: buildDir,
                html: fileText,
                target: fileWithBase,
                minify: true,
                inline: true,
                extract: true,
                rebase: () => { },
            })
                .then(({ html }) => {
                taskEmitter.emit("done");
                if (serverSentEvents) {
                    serverSentEvents({
                        html: addHMRCode(html, buildFilename),
                        filename: buildFilename,
                    });
                }
            })
                .catch((err) => {
                console.error(err);
            });
        }
        else {
            fs.writeFile(buildFilename, fileText, (err) => {
                errorHandler(err);
                taskEmitter.emit("done");
                if (serverSentEvents) {
                    serverSentEvents({
                        html: addHMRCode(fileText, buildFilename),
                        filename: buildFilename,
                    });
                }
            });
        }
    });
}
// Helper functions from here
function createPostCSSConfig() {
    try {
        return postcssrc.sync({});
    }
    catch {
        return { plugins: [cssnano], options: {} };
    }
}
function getBuildNames(filename) {
    const buildFilename = filename.replace(`${SOURCE_FOLDER}/`, `${BUILD_FOLDER}/`);
    const buildFilenameArr = buildFilename.split("/");
    buildFilenameArr.pop();
    const buildPathDir = buildFilenameArr.join("/");
    return [buildFilename, buildPathDir];
}
function rebuild(filename) {
    const [buildFilename] = getBuildNames(filename);
    if (filename.endsWith(".html")) {
        glob(`${SOURCE_FOLDER}/**/*.html`, {}, (err, files) => {
            errorHandler(err);
            createGlobalJS(files);
            minifyHTML(filename, buildFilename);
        });
    }
    else if (filename.endsWith(".ts") || filename.endsWith(".js")) {
        minifyTSJS([filename]);
    }
    else if (filename.endsWith(".css")) {
        minifyCSS(filename, buildFilename);
        if (isCritical) {
            glob(`${SOURCE_FOLDER}/**/*.html`, {}, (err, files) => {
                errorHandler(err);
                createGlobalJS(files);
                files.forEach((file) => {
                    const [buildFilenameHTML] = getBuildNames(file);
                    minifyHTML(file, buildFilenameHTML);
                });
            });
        }
    }
}
const getHMRCode = (filename, id) => `import { render, html, setShouldSetReactivity, $$, setGlobalSchedule, setInsertDiffing } from "https://unpkg.com/hydro-js/dist/library.js";

if (!window.eventsource${id}) {
  setGlobalSchedule(false);
  setShouldSetReactivity(false);

  window.eventsource${id} = new EventSource("/events");
  window.eventsource${id}.addEventListener("message", ({ data }) => {
    const dataObj = JSON.parse(data);

    if ("html" in dataObj && "${filename}" === dataObj.filename) {
      setInsertDiffing(true);

      let newHTML;
      let isBody;

      if (dataObj.html.startsWith('<!DOCTYPE html>') || dataObj.html.startsWith('<html')) {
        newHTML = html\`\${dataObj.html}\`;
      } else {
        newHTML = html\`<body>\${dataObj.html}</body>\`
        isBody = true
      }

      if (isBody) {
        const hmrID = "${id}";
        const hmrElems = Array.from(newHTML.childNodes);
        const hmrWheres = Array.from($$(\`[data-hmr="\${hmrID}"]\`))
        // Render new Elements in old Elements, also remove rest old Elements and add add new elements after the last old one
        hmrWheres.forEach((where, index) => {
            if (index < hmrElems.length) {
              render(hmrElems[index], where);
            } else {
              where.remove();
            }
        });
        for (let rest = hmrWheres.length; rest < hmrElems.length; rest++) {
          const template = document.createElement('template');
          hmrElems[hmrWheres.length].after(template);
          render(hmrElems[rest], template);
          template.remove();
        }
      } else {
        render(newHTML, document.documentElement);
      }
      setInsertDiffing(false);
    } else if ("css" in dataObj) {
      window.onceEveryXTime(100, window.updateCSS, [updateAttr]);
    } else if ("js" in dataObj) {
      window.onceEveryXTime(100, window.updateJS, [updateAttr]);
    }

    function updateAttr (attr, forceUpdate = false) {
      return (elem) => {
        const attrValue = elem[attr].replace(/\\?v=.*/, "");
        if (forceUpdate || attrValue.endsWith(dataObj.filename)) {
          elem[attr] = \`\${attrValue}?v=\${Math.random().toFixed(4)}\`;
        } else if (elem.localName === 'script' && !elem.src && new RegExp(\`["']\${dataObj.filename}["']\`).test(elem.textContent)) {
          elem.setAttribute('data-inline', String(Math.random().toFixed(4)).slice(2));
        }
      }
    };
  });

  if (!window.updateCSS) {
    window.updateCSS = function updateCSS(updateAttr) {
      $$('link').forEach(updateAttr("href"));
      window.fnToLastCalled.set(window.updateCSS, performance.now())
    }
  }
  if (!window.updateJS) {
    window.updateJS = function updateJS(updateAttr) {
      window.fnToLastCalled.set(window.updateJS, performance.now());
      const copy = html\`\${document.documentElement.outerHTML}\`;
      copy.querySelectorAll('script').forEach(updateAttr("src"));
      render(copy, document.documentElement);
    }
  }
  if (!window.fnToLastCalled) {
    window.fnToLastCalled = new Map();
  }
  if (!window.onceEveryXTime) {
    window.onceEveryXTime = function (time, fn, params) {
      if (!window.fnToLastCalled.has(fn) || performance.now() - window.fnToLastCalled.get(fn) > time) {
        fn(...params)
      }
    }
  }
}`;
function randomText() {
    return Math.random().toString(32).slice(2);
}
const htmlIdMap = new Map();
function addHMRCode(html, filename) {
    if (!htmlIdMap.has(filename)) {
        htmlIdMap.set(filename, randomText());
    }
    const script = createScript({ type: "module" }, getHMRCode(filename, htmlIdMap.get(filename)));
    let ast;
    if (html.includes("<!DOCTYPE html>") || html.includes("<html")) {
        ast = parse(html);
        const headNode = findElement(ast, (e) => getTagName(e) === "head");
        appendChild(headNode, script);
    }
    else {
        ast = parseFragment(html);
        appendChild(ast, script);
        ast.childNodes.forEach((node) => 
        //@ts-ignore
        node.attrs?.push({ name: "data-hmr", value: htmlIdMap.get(filename) }));
    }
    // Burst CSS cache
    findElements(ast, (e) => getTagName(e) === "link").forEach((link) => {
        const href = link.attrs.find((attr) => attr.name === "href");
        href.value += `?v=${Math.random().toFixed(4)}`;
    });
    return serialize(ast);
}
function createHMRHandlers(files) {
    files.forEach((filename) => {
        const newFilename = "/" + filename.replace(/src\//, "");
        const filePath = newFilename.split("/");
        const endName = filePath.pop();
        if (endName.endsWith("index.html")) {
            //@ts-ignore
            fastify.get(filePath.join("/") + "/", HMRHandler);
        }
        //@ts-ignore
        fastify.get(newFilename, HMRHandler);
    });
}
function HMRHandler(request, reply) {
    let filename = request.url;
    if (filename.endsWith("/")) {
        filename += "index.html";
    }
    filename = BUILD_FOLDER + filename;
    const file = fs.readFileSync(filename, {
        encoding: "utf-8",
    });
    reply.header("Content-Type", "text/html; charset=UTF-8");
    return reply.send(addHMRCode(file, filename));
}
function errorHandler(err) {
    if (err) {
        console.error(err);
        process.exit(1);
    }
}
