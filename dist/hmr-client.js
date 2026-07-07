// html-bundle HMR client runtime.
//
// This is a browser TypeScript module. The DOM lib is enabled in tsconfig.json,
// so the main `tsc` build type-checks it alongside the Node code and compiles it
// to dist/hmr-client.js next to this module's output. At inject time
// `buildHMRClient()` in utils.mts substitutes the `__HMR_*` tokens, then the
// result is injected as an inline `<script type="module">` into every built HTML
// page and bundled by esbuild so the `hydro-js` import resolves. Keeping it as a
// real file (instead of a generated template string) means backslashes/backticks
// are literal, avoiding the template-literal escape corruption a generated string
// is prone to.
import { render as hydroRender, html, setShouldSetReactivity } from "hydro-js";
// hydro-js's `render` is typed against its own `html()` output; this client
// feeds it arbitrary DOM nodes and uses `false` for `where` (a detached render),
// so widen the signature. The assertion is type-only — esbuild strips it and the
// runtime binding stays hydro-js's `render`.
const render = hydroRender;
const FILE = "__HMR_FILE__";
const ID = "__HMR_ID__";
const SRC = "__HMR_SRC__";
const REGION = '[data-hmr="__HMR_ID__"]';
const CLIENT = 'script[data-hmr-client="__HMR_ID__"]';
window.isHMR = true;
// One hub per browsing context, created by whichever page loads first. Every
// composed sub-page (index.html + fetched fragments) registers into it and stays
// live, so a single shared EventSource dispatches every file's changes to the
// right region — instead of each page fighting over one connection.
const hub = window.__htmlBundleHMR || (window.__htmlBundleHMR = createHub(SRC));
hub.currentUnit = FILE;
if (!window.htmlBundleHMR) {
    // Public opt-in API for user code running inside HMR-managed pages.
    //   window.htmlBundleHMR.dispose(cb) — cleanup before this unit re-runs
    //   window.htmlBundleHMR.accept(cb)  — hook after this unit is patched
    //   window.htmlBundleHMR.data        — object persisted across hot updates
    window.htmlBundleHMR = {
        accept(callback) {
            hub.addAccept(hub.currentUnit, callback);
        },
        dispose(callback) {
            hub.addDispose(hub.currentUnit, callback);
        },
        get data() {
            return hub.dataFor(hub.currentUnit);
        },
    };
}
hub.register(FILE, ID, { patch });
// --- per-page patching (closes over this page's own hydro-js instance) --------
function patch(message) {
    const previousScroll = window.scrollY;
    if (isFullDocument(message.html)) {
        patchDocument(message.previousHtml, message.html);
        if (FILE === SRC + "/index.html") {
            dispatchEvent(new Event("popstate"));
        }
    }
    else {
        patchFragment(message.html);
    }
    window.scrollTo(0, previousScroll);
}
function patchFragment(htmlText) {
    const incoming = parseHTML(htmlText);
    // hydro-js returns a DocumentFragment for multi-root markup but the element
    // itself for a single root — normalise to a flat list of top-level nodes.
    const nextNodes = incoming.nodeType === Node.DOCUMENT_FRAGMENT_NODE ||
        incoming.nodeType === Node.DOCUMENT_NODE
        ? Array.from(incoming.childNodes)
        : [incoming];
    const regions = Array.from(document.querySelectorAll(REGION));
    // Replace each existing region in place, drop the surplus, append the rest.
    regions.forEach((where, index) => {
        if (index < nextNodes.length) {
            render(nextNodes[index], where, false);
        }
        else {
            where.remove();
        }
    });
    for (let rest = regions.length; rest < nextNodes.length; rest++) {
        if (regions.length) {
            const template = document.createElement("template");
            nextNodes[regions.length - 1].after(template);
            render(nextNodes[rest], template, false);
            template.remove();
        }
        else {
            render(nextNodes[rest], false, false);
        }
    }
}
function isFullDocument(htmlText) {
    const trimmed = htmlText.trimStart().toLowerCase();
    return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}
function parseHTML(htmlText) {
    try {
        return html `${htmlText}`;
    }
    catch {
        setShouldSetReactivity(false);
        const parsed = html `${htmlText}`;
        setShouldSetReactivity(true);
        return parsed;
    }
}
function patchDocument(previousHtml, nextHtml) {
    const previousText = previousHtml ||
        hub.lastHTML.get(FILE) ||
        document.documentElement.outerHTML;
    const previousDocument = getDocumentParts(parseHTML(previousText));
    const nextDocument = getDocumentParts(parseHTML(nextHtml));
    if (!previousDocument.html || !nextDocument.html) {
        render(parseHTML(nextHtml), document.documentElement, false);
        hub.lastHTML.set(FILE, nextHtml);
        return;
    }
    patchAttributes(document.documentElement, nextDocument.html);
    if (previousDocument.head && nextDocument.head && document.head) {
        patchChildren(previousDocument.head, nextDocument.head, document.head);
        patchAttributes(document.head, nextDocument.head);
    }
    if (previousDocument.body && nextDocument.body && document.body) {
        patchChildren(previousDocument.body, nextDocument.body, document.body);
        patchAttributes(document.body, nextDocument.body);
    }
    hub.lastHTML.set(FILE, nextHtml);
}
function getDocumentParts(parsed) {
    const htmlNode = (parsed instanceof HTMLHtmlElement
        ? parsed
        : parsed.querySelector?.("html") || parsed);
    return {
        html: htmlNode,
        head: htmlNode.querySelector?.("head"),
        body: htmlNode.querySelector?.("body"),
    };
}
function patchChildren(previousParent, nextParent, liveParent) {
    const previousNodes = comparableNodes(previousParent);
    const nextNodes = comparableNodes(nextParent);
    let previousIndex = 0;
    let nextIndex = 0;
    let liveIndex = 0;
    while (nextIndex < nextNodes.length) {
        const previousNode = previousNodes[previousIndex];
        const nextNode = nextNodes[nextIndex];
        const liveNode = nextLiveNode(liveParent, liveIndex);
        if (!liveNode) {
            liveParent.append(cloneForRender(nextNode));
            nextIndex++;
            liveIndex++;
            continue;
        }
        if (!previousNode) {
            render(cloneForRender(nextNode), liveNode, false);
            nextIndex++;
            liveIndex++;
            continue;
        }
        const previousMatch = findStaticMatch(previousNodes, nextNode, previousIndex + 1);
        const nextMatch = findStaticMatch(nextNodes, previousNode, nextIndex + 1);
        if (previousMatch !== -1 && nextMatch === -1) {
            liveNode.remove();
            previousIndex++;
            continue;
        }
        if (nextMatch !== -1) {
            liveNode.before(cloneForRender(nextNode));
            nextIndex++;
            liveIndex++;
            continue;
        }
        if (sameNodeIdentity(previousNode, nextNode)) {
            patchNode(previousNode, nextNode, liveNode);
            previousIndex++;
            nextIndex++;
            liveIndex++;
            continue;
        }
        render(cloneForRender(nextNode), liveNode, false);
        previousIndex++;
        nextIndex++;
        liveIndex++;
    }
    while (previousIndex < previousNodes.length &&
        nextLiveNode(liveParent, liveIndex)) {
        nextLiveNode(liveParent, liveIndex).remove();
        previousIndex++;
    }
}
function patchNode(previousNode, nextNode, liveNode) {
    if (sameStaticNode(previousNode, nextNode))
        return;
    if (previousNode.nodeType !== nextNode.nodeType ||
        liveNode.nodeType !== nextNode.nodeType) {
        render(cloneForRender(nextNode), liveNode, false);
        return;
    }
    if (nextNode.nodeType === Node.TEXT_NODE) {
        liveNode.nodeValue = nextNode.nodeValue;
        return;
    }
    if (nextNode.nodeType !== Node.ELEMENT_NODE) {
        render(cloneForRender(nextNode), liveNode, false);
        return;
    }
    if (nextNode.localName === "script") {
        patchScript(previousNode, nextNode, liveNode);
        return;
    }
    patchAttributes(liveNode, nextNode);
    patchChildren(previousNode, nextNode, liveNode);
}
// Re-running only the scripts whose content actually changed is the "hot swap":
// unchanged scripts keep their state, changed ones re-execute with fresh code.
function patchScript(previousScript, nextScript, liveScript) {
    if (previousScript.isEqualNode(nextScript))
        return;
    const clone = cloneScript(nextScript);
    const source = clone.getAttribute("src");
    if (source)
        clone.setAttribute("src", bust(source));
    render(clone, liveScript, false);
}
function cloneForRender(node) {
    if (node.nodeType === Node.ELEMENT_NODE &&
        node.localName === "script") {
        return cloneScript(node);
    }
    return node.cloneNode(true);
}
// Cloning via document.createElement forces the browser to (re-)execute the
// script; a plain cloneNode of a parsed <script> would not run.
function cloneScript(script) {
    const clone = document.createElement("script");
    for (const attr of Array.from(script.attributes)) {
        clone.setAttribute(attr.name, attr.value);
    }
    clone.textContent = script.textContent;
    return clone;
}
function patchAttributes(liveElement, nextElement) {
    for (const attr of Array.from(liveElement.attributes)) {
        if (!nextElement.hasAttribute(attr.name))
            liveElement.removeAttribute(attr.name);
    }
    for (const attr of Array.from(nextElement.attributes)) {
        if (liveElement.getAttribute(attr.name) !== attr.value) {
            liveElement.setAttribute(attr.name, attr.value);
        }
    }
}
function sameStaticNode(previousNode, nextNode) {
    return cloneComparable(previousNode).isEqualNode(cloneComparable(nextNode));
}
function sameNodeIdentity(previousNode, nextNode) {
    return (previousNode.nodeType === nextNode.nodeType &&
        previousNode.nodeName === nextNode.nodeName);
}
function findStaticMatch(nodes, needle, start) {
    for (let index = start; index < nodes.length; index++) {
        if (sameStaticNode(nodes[index], needle))
            return index;
    }
    return -1;
}
// Ignore the injected HMR client script when diffing so it never counts as a
// real change.
function cloneComparable(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.(CLIENT).forEach((script) => script.remove());
    if (clone.matches?.(CLIENT))
        clone.remove();
    return clone;
}
function comparableNodes(parent) {
    return Array.from(parent.childNodes).filter((node) => {
        return !(node.nodeType === Node.ELEMENT_NODE && node.matches?.(CLIENT));
    });
}
function nextLiveNode(parent, index) {
    return comparableNodes(parent)[index];
}
function bust(url) {
    return url.split("?")[0] + "?v=" + Date.now();
}
// --- shared hub (created once by the first page to load) ----------------------
function createHub(src) {
    const registry = new Map();
    const accepts = new Map();
    const disposers = new Map();
    const store = new Map();
    const throttle = new Map();
    let source;
    let reconnectTimer;
    let reloadTimer;
    let shouldReconnect = true;
    const hub = {
        currentUnit: null,
        lastHTML: new Map(),
        register(file, id, handler) {
            registry.set(file, Object.assign({ id }, handler));
            connect();
        },
        addAccept(file, callback) {
            push(accepts, file, callback);
        },
        addDispose(file, callback) {
            push(disposers, file, callback);
        },
        dataFor(file) {
            if (!store.has(file))
                store.set(file, {});
            return store.get(file);
        },
        dispatch(message) {
            if (message.type === "html") {
                const entry = registry.get(message.file);
                if (!entry)
                    return;
                hub.currentUnit = message.file;
                run(disposers, message.file);
                try {
                    entry.patch(message);
                }
                catch (error) {
                    console.error("[html-bundle HMR] patch failed", error);
                }
                run(accepts, message.file);
            }
            else if (message.type === "css") {
                once("css", bustStylesheets);
            }
            else if (message.type === "asset") {
                once("asset:" + message.file, () => bustAsset(message.file));
            }
            else if (message.type === "full-reload") {
                reloadPage();
            }
        },
    };
    function push(map, key, value) {
        if (!map.has(key))
            map.set(key, []);
        map.get(key).push(value);
    }
    function run(map, key) {
        const callbacks = map.get(key);
        if (!callbacks || !callbacks.length)
            return;
        map.set(key, []);
        for (const callback of callbacks) {
            try {
                callback();
            }
            catch (error) {
                console.error("[html-bundle HMR] callback failed", error);
            }
        }
    }
    // Coalesce bursts of identical events (e.g. a save that touches many files).
    function once(key, action) {
        const now = performance.now();
        if (!throttle.has(key) || now - throttle.get(key) > 100) {
            throttle.set(key, now);
            action();
        }
    }
    function reloadPage() {
        // Own timer (not reconnectTimer) so an SSE reconnect can't cancel a pending
        // reload and vice versa.
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => window.location.reload(), 20);
    }
    function bustStylesheets() {
        document
            .querySelectorAll('link[rel="stylesheet"][href]')
            .forEach((link) => {
            const href = link.getAttribute("href").split("?")[0];
            link.setAttribute("href", href + "?v=" + Date.now());
        });
    }
    function bustAsset(file) {
        if (file.endsWith(".css")) {
            bustStylesheets();
            return;
        }
        const prefix = src + "/";
        const relative = file.indexOf(prefix) === 0 ? file.slice(prefix.length) : file;
        const version = "?v=" + Date.now();
        bustAttribute("img[src]", "src", relative, version);
        bustAttribute("script[src]", "src", relative, version);
        bustAttribute("link[href]", "href", relative, version);
        bustContains("source[srcset]", "srcset", relative, version);
        bustAttribute("img[data-src]", "data-src", relative, version);
    }
    function bustAttribute(selector, attribute, relative, version) {
        document.querySelectorAll(selector).forEach((node) => {
            const value = node.getAttribute(attribute);
            if (value && value.split("?")[0] === relative) {
                node.setAttribute(attribute, value.split("?")[0] + version);
            }
        });
    }
    function bustContains(selector, attribute, relative, version) {
        document.querySelectorAll(selector).forEach((node) => {
            const value = node.getAttribute(attribute);
            if (value && value.split("?")[0].indexOf(relative) !== -1) {
                node.setAttribute(attribute, value.split("?")[0] + version);
            }
        });
    }
    function connect() {
        if (source)
            return;
        shouldReconnect = true;
        source = new EventSource("/hmr");
        source.addEventListener("message", (event) => {
            let message;
            try {
                message = JSON.parse(event.data);
            }
            catch {
                return;
            }
            hub.dispatch(message);
        });
        source.addEventListener("error", () => {
            source.close();
            source = undefined;
            if (shouldReconnect) {
                clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(connect, 1000);
            }
        });
        window.addEventListener("pagehide", () => {
            shouldReconnect = false;
            clearTimeout(reconnectTimer);
            if (source)
                source.close();
            source = undefined;
        }, { once: true });
    }
    return hub;
}
