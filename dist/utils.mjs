import { copyFile, mkdir, readFile } from "fs/promises";
import path from "path";
import http from "http";
import https from "https";
import express from "express";
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
    const router = express.Router();
    const app = express();
    app.use(router);
    app.use(express.static(path.join(process.cwd(), bundleConfig.build)));
    router.get("/hmr", (_req, reply) => {
        reply.setHeader("Content-Type", "text/event-stream");
        reply.setHeader("Cache-Control", "no-cache");
        !isSecure && reply.setHeader("Connection", "keep-alive");
        CONNECTIONS.push(reply);
        serverSentEvents = (data) => {
            if (/\.(jsx?|tsx?)$/.test(data.file)) {
                data.file = data.file.replace(".ts", ".js").replace(".jsx", ".js");
            }
            CONNECTIONS.forEach((rep) => {
                rep.write(`data: ${JSON.stringify(data)}\n\n`);
            });
        };
    });
    app.use(async (_req, res) => {
        res.setHeader("Content-Type", "text/html");
        const file = await readFile(path.join(process.cwd(), bundleConfig.build, "index.html"), {
            encoding: "utf-8",
        });
        res.send(file);
    });
    return [
        router,
        isSecure
            ? https.createServer({
                key: bundleConfig.key ||
                    (await readFile(path.join(process.cwd(), "localhost-key.pem"))),
                cert: bundleConfig.cert ||
                    (await readFile(path.join(process.cwd(), "localhost.pem"))),
            }, app)
            : http.createServer({}, app),
    ];
}
export async function getPostCSSConfig() {
    try {
        return await postcssrc({});
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
const htmlIdMap = new Map();
export function addHMRCode(html, file, ast) {
    if (!htmlIdMap.has(file)) {
        htmlIdMap.set(file, randomText());
    }
    const script = createScript({ type: "module" }, getHMRCode(file, htmlIdMap.get(file), bundleConfig.src));
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
function getHMRCode(file, id, src) {
    return `import { render, html, $, $$, setShouldSetReactivity } from "hydro-js";
  window.isHMR = true;
  window.lastCalled = new Map();
  if (!window.eventsource${id}) {
    window.eventsource${id} = new EventSource("/hmr");
    window.eventsource${id}.addEventListener('error', (e) => {
      setTimeout(() => {
        window.eventsource${id} = new EventSource("/hmr");
      }, 1000);
    });
    window.eventsource${id}.addEventListener("message", ({ data }) => {
      if (window.lastScroll == null) {  
        window.lastScroll = window.scrollY;
      }
      const dataObj = JSON.parse(data);
      const file = "${file}";

      if (file === dataObj.file && "html" in dataObj) {
        let newHTML;
        try {
          newHTML = html\`\${dataObj.html}\`
        } catch {
          setShouldSetReactivity(false);
          newHTML = html\`\${dataObj.html}\`
          setShouldSetReactivity(true);
        }
        
        if (dataObj.html.startsWith('<!DOCTYPE html>') || dataObj.html.startsWith('<html')) {
          document.head.remove(); // Don't try to diff the head – just re-run the scripts

          // Restore Scroll
          window.addEventListener("afterRouting", () => {
            window.scrollTo(0, window.lastScroll);
            delete window.lastScroll;
          }, { once: true })

          render(newHTML, document.documentElement, false);
        } else {
          const hmrID = "${id}";
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

        $$('link[rel="stylesheet"][href]').forEach(link => {
          link.setAttribute("href", link.getAttribute("href") + "?v=" + String(Math.random().toFixed(4)).slice(2));
        })
        if (dataObj.html.includes("<script")) updateElem("script");
        
        
        if (dataObj.file === \`${src}/index.html\`) {
          dispatchEvent(new Event("popstate"));
        }
      } else if (dataObj.file.endsWith(".css")) {
        const now = performance.now();
        if (!window.lastCalled.has(dataObj.file) || now - window.lastCalled.get(dataObj.file) > 100) {
          $$('link[rel="stylesheet"][href]').forEach(link => {
            link.setAttribute("href", link.getAttribute("href") + "?v=" + String(Math.random().toFixed(4)).slice(2));
          })
          window.lastCalled.set(dataObj.file, now)
        }
      } else if (dataObj.file.endsWith(".js")) {
        const now = performance.now();
        if (!window.lastCalled.has(dataObj.file) || now - window.lastCalled.get(dataObj.file) > 100) {
          $$('link[rel="stylesheet"][href]').forEach(link => {
            link.setAttribute("href", link.getAttribute("href") + "?v=" + String(Math.random().toFixed(4)).slice(2));
          })
          updateElem("script");
          window.lastCalled.set(dataObj.file, now)
        }
      }
      

      function updateElem(type) {
        const hmrId = "${id}";
        const noSrcFile = dataObj.file.replace(\`${src}/\`, '');
        const attr = type === "script" ? "src" : "href";
        const elem = $(\`[data-hmr="\${hmrId}"] \${type}[\${attr}^="\${noSrcFile}"]\`); // could be $(\`\${type}[data-hmr="\${hmrId}"][\${attr}^="\${noSrcFile}"]\`) ?
        
        if (elem) {
          updateOne(type, attr, elem)
        } else {
          for(const e of $$(\`[data-hmr="\${hmrId}"] \${type}\`)) {
            updateOne(type, attr, e);
          }
        }
      }

      function updateOne(type, attr, elem) {
        const clone = document.createElement(type);
        for (const key of elem.getAttributeNames()) {
          clone.setAttribute(key, elem.getAttribute(key));
        }
        const attrVal = elem.getAttribute(attr);
        if (attrVal) clone.setAttribute(attr, attrVal + "?v=" + String(Math.random().toFixed(4)).slice(2));
        render(clone, elem, false);
      }
    });
  }
`;
}
