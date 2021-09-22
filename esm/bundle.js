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
import { minify } from "html-minifier-terser";
import { watch } from "chokidar";
import { serialize, parse, parseFragment } from "parse5";
import {
  createScript,
  getTagName,
  appendChild,
  findElement,
  findElements,
} from "@web/parse5-utils";
// CLI and options
const isCritical = process.argv.includes("--critical");
const isHMR = process.argv.includes("--hmr");
const isCSP = process.argv.includes("--csp");
const isSecure = process.argv.includes("--secure");
const isServeOnly = process.argv.includes("--serveOnly");
let fastify;
if (isServeOnly) {
  createDefaultServer();
  fastify.listen(5000);
  console.log(`💻 Sever listening on port 5000.`);
} else {
  process.env.NODE_ENV = isHMR ? "development" : "production";
  let { plugins, options, file } = createPostCSSConfig();
  let CSSprocessor = postcss(plugins);
  // Performance Observer and file watcher
  const globHTML = new Event.EventEmitter();
  const taskEmitter = new Event.EventEmitter();
  const start = performance.now();
  let expectedTasks = 0; // This will be increased in globHandlers
  let finishedTasks = 0; // Current status
  taskEmitter.on("done", () => {
    finishedTasks++;
    if (finishedTasks === expectedTasks) {
      console.log(
        `🚀 Build finished in ${(performance.now() - start).toFixed(2)}ms ✨`
      );
      if (isHMR) {
        if (file) {
          const postCSSWatcher = watch(file);
          postCSSWatcher.on("change", () => {
            console.log("⚡ modified postcss.config – CSS will rebuild now.");
            const newConfig = createPostCSSConfig();
            plugins = newConfig.plugins;
            options = newConfig.options;
            CSSprocessor = postcss(plugins);
            glob(`${SOURCE_FOLDER}/**/*.css`, {}, (err, files) => {
              errorHandler(err);
              expectedTasks += files.length;
              for (const filename of files) {
                const [buildFilename, buildPathDir] = getBuildNames(filename);
                fs.mkdirSync(buildPathDir, { recursive: true });
                minifyCSS(filename, buildFilename);
              }
            });
          });
        }
        console.log(`⌛ Waiting for file changes ...`);
        const watcher = watch(SOURCE_FOLDER);
        // The add watcher will add all the files initially - do not rebuild them
        let initialAdd = 0;
        let hasJSTS = false;
        watcher.on("add", (filename) => {
          // Return if it was added by the build system itself
          if (/-bundle-\d+\.(j|t)sx?$/.test(filename)) {
            return;
          }
          filename = String.raw`${filename}`.replace(/\\/g, "/");
          if (filename.endsWith(".html") || filename.endsWith(".css")) {
            initialAdd++;
          } else if (hasJSTS === false && /\.(j|t)sx?$/.test(filename)) {
            hasJSTS = true;
            initialAdd++;
          }
          if (initialAdd <= expectedTasks) return;
          const [buildFilename, buildPathDir] = getBuildNames(filename);
          fs.mkdir(buildPathDir, { recursive: true }, (err) => {
            errorHandler(err);
            rebuild(filename);
            console.log(`⚡ added ${buildFilename}`);
          });
        });
        watcher.on("change", (filename) => {
          // Return if it was changed by the build system itself
          if (/-bundle-\d+\.(j|t)sx?$/.test(filename)) {
            return;
          }
          filename = String.raw`${filename}`.replace(/\\/g, "/");
          rebuild(filename);
          const [buildFilename] = getBuildNames(filename);
          console.log(`⚡ modified ${buildFilename}`);
        });
        watcher.on("unlink", (filename) => {
          // Return if it was deleted by the build system itself
          if (/-bundle-\d+\.(j|t)sx?$/.test(filename)) {
            return;
          }
          filename = String.raw`${filename}`.replace(/\\/g, "/");
          JSTSFiles.delete(filename);
          const [buildFilename, buildPathDir] = getBuildNames(filename);
          fs.rm(tsMaybeX2JS(buildFilename), (err) => {
            errorHandler(err);
            console.log(`⚡ deleted ${buildFilename}`);
            const length = fs.readdirSync(buildPathDir).length;
            if (!length) fs.rmdir(buildPathDir, errorHandler);
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
  if (isHMR) {
    fastify = Fastify(
      isSecure
        ? {
            http2: true,
            https: {
              key: fs.readFileSync(
                path.join(process.cwd(), "localhost-key.pem")
              ),
              cert: fs.readFileSync(path.join(process.cwd(), "localhost.pem")),
            },
          }
        : void 0
    );
    fastify.setNotFoundHandler((_req, reply) => {
      const file = fs.readFileSync(
        path.join(process.cwd(), BUILD_FOLDER, "/index.html"),
        {
          encoding: "utf-8",
        }
      );
      reply.header("Content-Type", "text/html; charset=UTF-8");
      return reply.send(addHMRCode(file, "build/index.html"));
    });
    fastify.register(fastifyStatic, {
      root: path.join(process.cwd(), BUILD_FOLDER),
    });
    fastify.get("/events", (_req, reply) => {
      reply.raw.setHeader("Content-Type", "text/event-stream");
      reply.raw.setHeader("Cache-Control", "no-cache");
      !isSecure && reply.raw.setHeader("Connection", "keep-alive");
      CONNECTIONS.push(reply.raw);
      serverSentEvents = (data) =>
        CONNECTIONS.forEach((rep) => {
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
  const JSTSFiles = new Set();
  glob(`${SOURCE_FOLDER}/**/!(*.d).{ts,js,tsx,jsx}`, {}, (err, files) => {
    errorHandler(err);
    if (files.length) {
      expectedTasks += 1;
    } else {
      globHTML.emit("getReady");
    }
    files.forEach((file) => JSTSFiles.add(file));
    minifyTSJS().catch(errorHandler);
  });
  globHTML.on("getReady", () => {
    if (expectedTasks - htmlTasks === finishedTasks) {
      // After CSS and JS because critical needs file built css files and inline script might reference js files.
      glob(`${SOURCE_FOLDER}/**/*.html`, {}, async (err, files) => {
        errorHandler(err);
        await createGlobalJS(files);
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
      const fileText = fs.readFileSync(filename, { encoding: "utf-8" });
      let DOM;
      if (fileText.includes("<!DOCTYPE html>") || fileText.includes("<html")) {
        DOM = parse(fileText);
      } else {
        DOM = parseFragment(fileText);
      }
      const scripts = findElements(DOM, (e) => getTagName(e) === "script");
      scripts.forEach((script, index) => {
        const scriptTextNode = script.childNodes[0];
        const isReferencedScript = script.attrs.find((a) => a.name === "src");
        //@ts-ignore
        const scriptContent = scriptTextNode?.value;
        if (!scriptContent || isReferencedScript) return;
        const jsFilename = filename.replace(".html", `-bundle-${index}.js`);
        scriptFilenames.push(jsFilename);
        fs.writeFileSync(jsFilename, scriptContent);
      });
    });
    scriptFilenames.forEach((file) => JSTSFiles.add(file));
    return minifyTSJS(true)
      .catch(console.error)
      .finally(() =>
        scriptFilenames.forEach((file) => {
          JSTSFiles.delete(file);
          try {
            fs.rmSync(file);
          } catch {}
        })
      );
  }
  function minifyTSJS(isInline = false, file) {
    return esbuild
      .build({
        entryPoints: Array.from(JSTSFiles),
        charset: "utf8",
        format: "esm",
        incremental: isHMR,
        sourcemap: isHMR,
        splitting: true,
        define: {
          "process.env.NODE_ENV": isHMR ? '"development"' : '"production"',
        },
        loader: { ".js": "jsx", ".ts": "tsx" },
        bundle: true,
        minify: true,
        outdir: BUILD_FOLDER,
        outbase: SOURCE_FOLDER,
      })
      .then(() => {
        if (!isInline) {
          taskEmitter.emit("done");
          globHTML.emit("getReady");
          if (serverSentEvents) {
            const changedFile = tsMaybeX2JS(file);
            const [buildFilename] = getBuildNames(changedFile);
            const js = fs.readFileSync(buildFilename, { encoding: "utf8" });
            serverSentEvents({
              js,
              filename: buildFilename.split(`${BUILD_FOLDER}/`).pop(),
            });
          }
        }
      });
  }
  function minifyCSS(filename, buildFilename) {
    const fileText = fs.readFileSync(filename, { encoding: "utf-8" });
    return CSSprocessor.process(fileText, {
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
  async function minifyHTML(filename, buildFilename) {
    let fileText = fs.readFileSync(filename, { encoding: "utf-8" });
    let DOM;
    if (fileText.includes("<!DOCTYPE html>") || fileText.includes("<html")) {
      DOM = parse(fileText);
    } else {
      DOM = parseFragment(fileText);
    }
    // Minify Code
    const scripts = findElements(DOM, (e) => getTagName(e) === "script");
    scripts.forEach((script, index) => {
      const scriptTextNode = script.childNodes[0];
      const isReferencedScript = script.attrs.find((a) => a.name === "src");
      //@ts-ignore
      if (!scriptTextNode?.value || isReferencedScript) return;
      // Use bundled file and remove it from fs
      const bundledFilename = buildFilename.replace(
        ".html",
        `-bundle-${index}.js`
      );
      try {
        const scriptContent = fs.readFileSync(bundledFilename, {
          encoding: "utf-8",
        });
        fs.rmSync(bundledFilename);
        // Replace src with bundled code
        //@ts-ignore
        scriptTextNode.value = scriptContent.replace(
          TEMPLATE_LITERAL_MINIFIER,
          " "
        );
      } catch {}
    });
    // Minify Inline Style
    const styles = findElements(DOM, (e) => getTagName(e) === "style");
    for (const style of styles) {
      const node = style.childNodes[0];
      //@ts-ignore
      const styleContent = node?.value;
      if (!styleContent) continue;
      const { css } = await CSSprocessor.process(styleContent, {
        ...options,
        from: undefined,
      });
      //@ts-ignore
      node.value = css;
    }
    fileText = serialize(DOM);
    // Minify HTML
    fileText = await minify(fileText, {
      collapseWhitespace: true,
      removeComments: true,
    });
    if (isCritical) {
      const buildFilenameArr = buildFilename.split("/");
      const fileWithBase = buildFilenameArr.pop();
      const buildDir = buildFilenameArr.join("/");
      // critical is generating the files on the fs
      return critical
        .generate({
          base: buildDir,
          html: fileText,
          target: fileWithBase,
          inline: !isCSP,
          extract: true,
          rebase: () => {},
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
    } else {
      fs.writeFileSync(buildFilename, fileText);
      taskEmitter.emit("done");
      if (serverSentEvents) {
        serverSentEvents({
          html: addHMRCode(fileText, buildFilename),
          filename: buildFilename,
        });
      }
    }
  }
  // Helper functions from here
  function createPostCSSConfig() {
    try {
      return postcssrc.sync({});
    } catch {
      return { plugins: [cssnano], options: {}, file: "" };
    }
  }
  function getBuildNames(filename) {
    const buildFilename = filename.replace(
      `${SOURCE_FOLDER}/`,
      `${BUILD_FOLDER}/`
    );
    const buildFilenameArr = buildFilename.split("/");
    buildFilenameArr.pop();
    const buildPathDir = buildFilenameArr.join("/");
    return [buildFilename, buildPathDir];
  }
  async function rebuild(filename) {
    const [buildFilename] = getBuildNames(filename);
    if (/\.(j|t)sx?$/.test(filename)) {
      JSTSFiles.add(filename);
    } else if (filename.endsWith(".css")) {
      await minifyCSS(filename, buildFilename);
    }
    glob(`${SOURCE_FOLDER}/**/*.html`, {}, async (err, files) => {
      errorHandler(err);
      await createGlobalJS(files);
      if (filename.endsWith(".html")) {
        minifyHTML(filename, buildFilename);
      } else if (
        /\.(j|t)sx?$/.test(filename) ||
        (filename.endsWith(".css") && isCritical)
      ) {
        for (const htmlFilename of files) {
          const [htmlBuildFilename] = getBuildNames(htmlFilename);
          await minifyHTML(htmlFilename, htmlBuildFilename);
        }
        if (/\.(j|t)sx?$/.test(filename) && serverSentEvents) {
          const jsFile = tsMaybeX2JS(buildFilename);
          try {
            // Do not try to send empty files
            serverSentEvents({
              js: fs.readFileSync(jsFile, { encoding: "utf-8" }),
              filename: jsFile.split(`${BUILD_FOLDER}/`).pop(),
            });
          } catch {}
        }
      }
    });
  }
  const getHMRCode = (
    filename,
    id
  ) => `import { render, html, setShouldSetReactivity, $$, setGlobalSchedule, setInsertDiffing } from "https://unpkg.com/hydro-js/dist/library.js";

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
          if (hmrWheres.length) {
            const template = document.createElement('template');
            hmrElems[hmrWheres.length - 1].after(template);
            render(hmrElems[rest], template);
            template.remove();
          } else {
            render(hmrElems[rest])
          }
        }
      } else {
        const oldElementCount = document.body.querySelectorAll('*').length;
        render(newHTML, document.documentElement);
        const newElementCount = document.body.querySelectorAll('*').length;

        // Looks like JS did not reload? Last resort - hard refresh
        if (newElementCount < 5 && Math.abs(newElementCount - oldElementCount) > 10) {
          location.reload() 
        }
      }
      setInsertDiffing(false);
      if (dataObj.filename === 'build/index.html') {
        dispatchEvent(new Event("popstate"));
      }
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
    const script = createScript(
      { type: "module" },
      getHMRCode(filename, htmlIdMap.get(filename))
    );
    let ast;
    if (html.includes("<!DOCTYPE html>") || html.includes("<html")) {
      ast = parse(html);
      const headNode = findElement(ast, (e) => getTagName(e) === "head");
      appendChild(headNode, script);
    } else {
      ast = parseFragment(html);
      appendChild(ast, script);
      ast.childNodes.forEach((node) =>
        //@ts-ignore
        node.attrs?.push({ name: "data-hmr", value: htmlIdMap.get(filename) })
      );
    }
    // Burst CSS cache
    findElements(ast, (e) => getTagName(e) === "link").forEach((link) => {
      const href = link.attrs.find((attr) => attr.name === "href");
      const rel = link.attrs.find((attr) => attr.name === "rel");
      if (rel.value === "stylesheet") {
        href.value += `?v=${Math.random().toFixed(4)}`;
      }
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
  function tsMaybeX2JS(filename) {
    return filename.replace(".ts", ".js").replace(".jsx", ".js");
  }
}
function createDefaultServer(BUILD_FOLDER = "build") {
  fastify = Fastify(
    isSecure
      ? {
          http2: true,
          https: {
            key: fs.readFileSync(path.join(process.cwd(), "localhost-key.pem")),
            cert: fs.readFileSync(path.join(process.cwd(), "localhost.pem")),
          },
        }
      : void 0
  );
  fastify.register(fastifyStatic, {
    root: path.join(process.cwd(), BUILD_FOLDER),
  });
}
