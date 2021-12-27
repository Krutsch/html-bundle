import { access, copyFile, mkdir, readFile } from "fs/promises";
import path from "path";
import Fastify from "fastify";
import fastifyStatic from "fastify-static";
import postcssrc from "postcss-load-config";
import cssnano from "cssnano";
import { parse, parseFragment, serialize } from "parse5";
import { createScript, getTagName, findElement, appendChild, } from "@web/parse5-utils";
export const bundleConfig = await getBundleConfig();
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
const CONNECTIONS = []; // In order to send the HMR information
export let serverSentEvents;
export async function createDefaultServer(isSecure) {
    const fastify = Fastify(isSecure
        ? {
            http2: true,
            https: {
                key: await readFile(path.join(process.cwd(), "localhost-key.pem")),
                cert: await readFile(path.join(process.cwd(), "localhost.pem")),
            },
        }
        : void 0);
    fastify.setNotFoundHandler(async (_req, reply) => {
        const file = await readFile(path.join(process.cwd(), bundleConfig.build, "/index.html"), {
            encoding: "utf-8",
        });
        reply.header("Content-Type", "text/html; charset=UTF-8");
        return reply.send(addHMRCode(file, `${bundleConfig.src}/index.html`));
    });
    fastify.register(fastifyStatic, {
        root: path.join(process.cwd(), bundleConfig.build),
    });
    fastify.get("/events", (_req, reply) => {
        reply.raw.setHeader("Content-Type", "text/event-stream");
        reply.raw.setHeader("Cache-Control", "no-cache");
        !isSecure && reply.raw.setHeader("Connection", "keep-alive");
        CONNECTIONS.push(reply.raw);
        serverSentEvents = (data) => CONNECTIONS.forEach((rep) => {
            rep.write(`data: ${JSON.stringify(data)}\n\n`);
        });
    });
    return fastify;
}
export function getPostCSSConfig() {
    try {
        return postcssrc({});
    }
    catch {
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
        critical: {},
    };
    try {
        const cfgPath = path.resolve(process.cwd(), "bundle.config.cjs");
        await access(cfgPath, 0);
        const config = await import(`file://${cfgPath}`);
        return { ...base, ...config.default };
    }
    catch {
        console.log("catch");
        return base;
    }
}
const htmlIdMap = new Map();
export function addHMRCode(html, file, ast) {
    if (!htmlIdMap.has(file)) {
        htmlIdMap.set(file, randomText());
    }
    const script = createScript({ type: "module" }, getHMRCode(file, htmlIdMap.get(file), bundleConfig.src, bundleConfig.build));
    let DOM;
    if (html.includes("<!DOCTYPE html>") || html.includes("<html")) {
        DOM = ast || parse(html);
        const headNode = findElement(DOM, (e) => getTagName(e) === "head");
        appendChild(headNode, script);
    }
    else {
        DOM = ast || parseFragment(html);
        appendChild(DOM, script);
    }
    //@ts-ignore
    DOM.childNodes.forEach((node) => node.attrs?.push({ name: "data-hmr", value: htmlIdMap.get(file) }));
    return serialize(DOM);
}
function randomText() {
    return Math.random().toString(32).slice(2);
}
function getHMRCode(file, id, src, build) {
    return `import { render, html, $, $$, setInsertDiffing } from "hydro-js";
  if (!window.eventsource${id}) {
    setInsertDiffing(true);
    window.eventsource${id} = new EventSource("/events");
    window.eventsource${id}.addEventListener("message", ({ data }) => {
      const dataObj = JSON.parse(data);
      const file = "${file}";

      if (file === dataObj.file && "html" in dataObj) {
        if (dataObj.html.startsWith('<!DOCTYPE html>') || dataObj.html.startsWith('<html')) {
          document.head.remove(); // Don't try to diff the head – just re-run the scripts
          render(html\`\${dataObj.html}\`, document.documentElement);
        } else {
          const hmrID = "${id}";
          const newHTML = html\`\${dataObj.html}\`;
          const hmrElems = Array.from(newHTML.childNodes);
          const hmrWheres = Array.from($$(\`[data-hmr="\${hmrID}"]\`))
          // render new elements for old elements. Then, remove rest old elements and add add new elements after the last old one
          hmrWheres.forEach((where, index) => {
            if (index < hmrElems.length) {
              render(hmrElems[index], where, false);
            } else {
              where.remove();
            }
          });
          for (let rest = hmrWheres.length; rest < hmrElems.length; rest++) {
            if (hmrWheres.length) {
              const template = document.createElement('template');
              hmrElems[hmrWheres.length - 1].after(template);
              render(hmrElems[rest], template, false);
              template.remove();
            } else {
              render(hmrElems[rest], false, false)
            }
          }
        }
        
        setTimeout(() => dispatchEvent(new Event("popstate")));
      } else if (dataObj.file.endsWith("css")) {
        updateElem("link");
      } else if (dataObj.file.endsWith("js")) {
        updateElem("script")
      }

      function updateElem(type) {
        const hmrId = "${id}";
        const noSrcFile = dataObj.file.replace(\`${src}/\`, '');
        const attr = type === "script" ? "src" : "href";
        const elem = $(\`[data-hmr="\${hmrId}"] \${type}[\${attr}^="\${noSrcFile}"]\`); // could be $(\`\${type}[data-hmr="\${hmrId}"][\${attr}^="\${noSrcFile}"]\`) ?
        
        if (elem) {
          const clone = document.createElement(type);
          for (const key of elem.getAttributeNames()) {
            clone.setAttribute(key, elem.getAttribute(key));
          }
          clone.setAttribute(attr, elem.getAttribute(attr) + "?v=" + String(Math.random().toFixed(4)).slice(2));
          render(clone, elem, false);
        }
      }
    });
  }
`;
}
