#!/usr/bin/env node

import fs from "fs";
import { performance } from "perf_hooks";
import Event from "events";
import glob from "glob";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import Fastify from "fastify";
import fastifyStatic from "fastify-static";
import postcss, { AcceptedPlugin, ProcessOptions } from "postcss";
import postcssrc from "postcss-load-config";
import cssnano from "cssnano";
import esbuild from "esbuild";
import critical from "critical";
import { minify } from "html-minifier";
import { watch } from "chokidar";
import { serialize, parse, parseFragment } from "parse5";
import {
  createScript,
  getTagName,
  appendChild,
  findElement,
  findElements,
} from "@web/parse5-utils";

console.clear(); // findElement is logging an array for no reason

// CLI and options
const { plugins, options } = createPostCSSConfig();
const CSSprocessor = postcss(plugins as AcceptedPlugin[]);
const isCritical = process.argv.includes("--critical");
const isHMR = process.argv.includes("--hmr");

// Performance Observer and watcher
const taskEmitter = new Event.EventEmitter();
const start = performance.now();
let expectedTasks = 0; // This will be set in globHandler
let finishedTasks = 0;
taskEmitter.on("done", () => {
  finishedTasks++;

  if (finishedTasks === expectedTasks) {
    console.log(
      `🚀 Build finished in ${(performance.now() - start).toFixed(2)}ms ✨`
    );

    if (isHMR) {
      console.log(`⌛ Waiting for file changes ...`);

      const watcher = watch(SOURCE_FOLDER);
      // The add watcher will add all the files initially - do not watch them
      let initialAdd = 0;

      watcher.on("add", (filename) => {
        filename = String.raw`${filename}`.replace(/\\/g, "/");
        if (
          filename.endsWith(".html") ||
          filename.endsWith(".css") ||
          filename.endsWith(".js") ||
          filename.endsWith(".ts")
        ) {
          initialAdd++;
        }
        if (initialAdd <= expectedTasks) return;

        const [buildFilename, buildPathDir] = getBuildNames(filename);
        fs.mkdir(buildPathDir, { recursive: true }, (err) => {
          if (err) {
            console.error(err);
            process.exit(1);
          }

          rebuild(filename);
          console.log(`⚡ added ${buildFilename}`);
        });
      });
      watcher.on("change", (filename) => {
        filename = String.raw`${filename}`.replace(/\\/g, "/");
        rebuild(filename);
        const [buildFilename] = getBuildNames(filename);
        console.log(`⚡ modified ${buildFilename}`);
      });
      watcher.on("unlink", (filename) => {
        filename = String.raw`${filename}`.replace(/\\/g, "/");
        const [buildFilename, buildPathDir] = getBuildNames(filename);
        fs.rm(buildFilename, (err) => {
          if (err) throw err;

          console.log(`⚡ deleted ${buildFilename}`);
          const length = fs.readdirSync(buildPathDir).length;
          if (!length)
            fs.rmdir(buildPathDir, () => {
              if (err) throw err;
            });
        });
      });
    }
  }
});

// Basic configuration
const SOURCE_FOLDER = "src";
const BUILD_FOLDER = "build";
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const CONNECTIONS: Array<any> = [];

// Remove old build dir
fs.rmSync(BUILD_FOLDER, { recursive: true, force: true });

// Server for HMR
type serverSentEventObject =
  | { css: string }
  | { html: string }
  | { js: string };
let serverSentEvents: undefined | ((data: serverSentEventObject) => void);
if (isHMR) {
  const fastify = Fastify();
  const __dirname = dirname(fileURLToPath(import.meta.url));
  fastify.register(fastifyStatic, {
    root: path.join(__dirname, BUILD_FOLDER),
  });
  //@ts-ignore
  fastify.get("/", function (_req, reply) {
    let content = fs.readFileSync(`${BUILD_FOLDER}/index.html`, {
      encoding: "utf-8",
    });
    reply.header("Content-Type", "text/html; charset=UTF-8");
    content = addHMRCode(content);
    return reply.send(content);
  });

  fastify.get("/events", (_req, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");

    CONNECTIONS.push(reply.raw);

    serverSentEvents = (data) =>
      CONNECTIONS.forEach((rep) => {
        rep.write(`data: ${JSON.stringify(data)}\n\n`);
      });
  });

  fastify.listen(5000);
  console.log(`💻 Sever listening on port 5000.`);
}

// THE BUNDLE CODE
// Glob all files and transform the code
glob(`${SOURCE_FOLDER}/**/*.html`, {}, (err, files) => {
  // Create importable and treeshaked esm files that will be imported in HTML
  createGlobalJS(err, files);

  globHandler(minifyHTML)(err, files);
  glob(`${SOURCE_FOLDER}/**/*.{ts,js}`, {}, globHandler(minifyTSJS));
  glob(`${SOURCE_FOLDER}/**/*.css`, {}, globHandler(minifyCSS));
});

type globCB = Parameters<Parameters<typeof glob>[2]>;
function globHandler(minifyFn: Function) {
  return (err: globCB[0], files: globCB[1]) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }

    if (
      files.length &&
      (files[0].endsWith(".ts") || files[0].endsWith(".js"))
    ) {
      expectedTasks += 1;
      minifyFn(files);
      return;
    }

    expectedTasks += files.length;

    files.forEach((filename) => {
      const [buildFilename, buildPathDir] = getBuildNames(filename);

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

function createGlobalJS(err: globCB[0], files: globCB[1]) {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  // Create folders
  fs.mkdirSync(BUILD_FOLDER, { recursive: true });

  // Glob all inline scripts and create importable files
  const scriptFilenames: string[] = [];

  files.forEach((filename) => {
    const fileText = fs.readFileSync(filename, { encoding: "utf-8" });

    let DOM;
    if (fileText.includes("<html")) {
      DOM = parse(fileText);
    } else {
      DOM = parseFragment(fileText);
    }

    const scripts = findElements(DOM, (e) => getTagName(e) === "script");
    scripts.forEach((script, index) => {
      const src = script.childNodes[0];
      //@ts-ignore
      const srcValue = src?.value;
      if (!srcValue) return;

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
      fs.writeFileSync(buildFilename, srcValue);
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
          if (err) throw err;
        });
    }
  });
}

function minifyTSJS(files: Array<string>) {
  esbuild
    .build({
      entryPoints: files,
      charset: "utf8",
      format: "esm",
      incremental: isHMR,
      splitting: true,
      bundle: true,
      minify: true,
      outdir: BUILD_FOLDER,
    })
    .then(() => {
      taskEmitter.emit("done");

      if (serverSentEvents) {
        const file = files.pop()!; // Only one filed was modified
        const [buildFilename] = getBuildNames(file);
        const filetext = fs.readFileSync(buildFilename, { encoding: "utf8" });
        serverSentEvents({ js: filetext });
      }
    });
}

function minifyCSS(filename: string, buildFilename: string) {
  fs.readFile(filename, { encoding: "utf-8" }, (err, fileText) => {
    if (err) throw err;

    CSSprocessor.process(fileText, {
      ...(options as ProcessOptions),
      from: filename,
      to: buildFilename,
    }).then((result) =>
      fs.writeFile(buildFilename, result.css, (err) => {
        if (err) throw err;

        taskEmitter.emit("done");

        if (serverSentEvents) {
          serverSentEvents({ css: result.css });
        }
      })
    );
  });
}

function minifyHTML(filename: string, buildFilename: string) {
  fs.readFile(filename, { encoding: "utf-8" }, async (err, fileText) => {
    if (err) throw err;

    let DOM;
    if (fileText.includes("<html")) {
      DOM = parse(fileText);
    } else {
      DOM = parseFragment(fileText);
    }

    // Minify Code
    const scripts = findElements(DOM, (e) => getTagName(e) === "script");
    scripts.forEach((script, index) => {
      const node = script.childNodes[0];
      //@ts-ignore
      const src = node?.value;
      if (!src) return;

      // Use bundled file and remove it from fs
      const bundledFilename = buildFilename.replace(".html", `-${index}.js`);
      const scriptContent = fs.readFileSync(bundledFilename, {
        encoding: "utf-8",
      });
      fs.rmSync(bundledFilename);

      // Replace src with bundled code
      //@ts-ignore
      node.value = scriptContent.replace(TEMPLATE_LITERAL_MINIFIER, "");
    });

    // Minify Inline Style
    const styles = findElements(DOM, (e) => getTagName(e) === "style");
    for (const style of styles) {
      const node = style.childNodes[0];
      //@ts-ignore
      const styleContent = node?.value;
      if (!styleContent) continue;

      const { css } = await CSSprocessor.process(styleContent, {
        ...(options as ProcessOptions),
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
          rebase: () => {},
        })
        .then(({ html }: any) => {
          taskEmitter.emit("done");

          if (serverSentEvents) {
            serverSentEvents({ html });
          }
        })
        .catch((err: Error) => {
          if (err) throw err;
        });
    } else {
      fs.writeFile(buildFilename, fileText, (err) => {
        if (err) throw err;

        taskEmitter.emit("done");

        if (serverSentEvents) {
          serverSentEvents({ html: fileText });
        }
      });
    }
  });
}

// Helper functions from here
function createPostCSSConfig() {
  try {
    return postcssrc.sync({});
  } catch {
    return { plugins: [cssnano], options: {} };
  }
}

function getBuildNames(filename: string) {
  const buildFilename = filename.replace(
    `${SOURCE_FOLDER}/`,
    `${BUILD_FOLDER}/`
  );
  const buildFilenameArr = buildFilename.split("/");
  buildFilenameArr.pop();
  const buildPathDir = buildFilenameArr.join("/");
  return [buildFilename, buildPathDir];
}

function rebuild(filename: string) {
  const [buildFilename] = getBuildNames(filename);

  if (filename.endsWith(".html")) {
    glob(`${SOURCE_FOLDER}/**/*.html`, {}, (err, files) => {
      if (err) throw err;

      createGlobalJS(err, files);
      minifyHTML(filename, buildFilename);
    });
  } else if (filename.endsWith(".ts") || filename.endsWith(".js")) {
    minifyTSJS([filename]);
  } else if (filename.endsWith(".css")) {
    minifyCSS(filename, buildFilename);
  }
}

const HMRCODE = `
import { render, html, setShouldSetReactivity, $$, setInsertDiffing } from "https://unpkg.com/hydro-js@1.2.10/dist/library.js";

if (!window.eventsource) {
  setShouldSetReactivity(false);
  setInsertDiffing(true);

  window.eventsource = new EventSource("/events");
  window.eventsource.addEventListener("message", ({ data }) => {
    const dataObj = JSON.parse(data);
    const updateCSS = (link) => {
      const href = link.getAttribute("href")?.replace(/\\?v=.*/, "");
      href &&
        link.setAttribute("href", \`\${href}?v=\${Math.random().toFixed(4)}\`);
    };

    if ("html" in dataObj) {
      const newHTML = html\`\${dataObj.html}\`;
      newHTML.querySelectorAll("link").forEach(updateCSS); // Burst cache for Firefox
      render(newHTML, document.documentElement, false);
    } else if ("css" in dataObj) {
      $$(\`link\`).forEach(updateCSS);
    } else if ("js" in dataObj) {
      const copy = html\`\${document.documentElement.outerHTML}\`;
      document.documentElement.innerHTML = "";
      render(copy, document.documentElement, false);
    }
  });
}
`.trimStart();

function addHMRCode(html: string) {
  const ast = parse(html);
  const headNode = findElement(ast, (e) => getTagName(e) === "head");
  const script = createScript({ type: "module" }, HMRCODE);
  appendChild(headNode as any, script);
  return serialize(ast);
}
