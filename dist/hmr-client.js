// src/hmr-client.ts
import { render as hydroRender, html, setShouldSetReactivity } from "hydro-js";

// src/hmr-protocol.mts
function isRecord(value) {
  return typeof value === "object" && value !== null;
}
function hasString(record, key) {
  return typeof record[key] === "string";
}
function isHMRMessage(value) {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "connected") {
    return hasString(value, "id");
  }
  if (value.type === "html") {
    return hasString(value, "file") && hasString(value, "html") && (value.previousHtml === void 0 || typeof value.previousHtml === "string");
  }
  return (value.type === "css" || value.type === "asset" || value.type === "full-reload") && hasString(value, "file");
}
function decodeHMRMessage(value) {
  try {
    const message = JSON.parse(value);
    return isHMRMessage(message) ? message : void 0;
  } catch {
    return void 0;
  }
}

// src/dom-patch.mts
function createDOMPatcher(renderer2, options) {
  return {
    patch(message, liveDocument) {
      if (isDocumentHTML(message.html)) {
        patchDocument(message, liveDocument);
        return true;
      }
      patchFragment(message, liveDocument);
      return false;
    }
  };
  function topLevelNodes(parsed) {
    return parsed.nodeType === Node.DOCUMENT_FRAGMENT_NODE || parsed.nodeType === Node.DOCUMENT_NODE ? Array.from(parsed.childNodes) : [parsed];
  }
  function patchFragment(message, liveDocument) {
    const incoming = parseMarkup2(message.html);
    const nextNodes = topLevelNodes(incoming);
    const regions = Array.from(
      liveDocument.querySelectorAll(options.regionSelector)
    );
    if (!regions.length) {
      options.setLastHTML(message.html);
      return;
    }
    const previousText = message.previousHtml || options.getLastHTML();
    const previousNodes = previousText ? topLevelNodes(parseMarkup2(previousText)) : [];
    regions.forEach((where, index) => {
      if (index < nextNodes.length) {
        const previousNode = previousNodes[index];
        const nextNode = nextNodes[index];
        if (previousNode && sameNodeIdentity(previousNode, nextNode)) {
          patchNode(previousNode, nextNode, where, liveDocument);
        } else {
          renderer2.render(cloneForRender(nextNode, liveDocument), where, false);
        }
      } else {
        where.remove();
      }
    });
    for (let rest = regions.length; rest < nextNodes.length; rest++) {
      const template = liveDocument.createElement("template");
      const regionList = Array.from(
        liveDocument.querySelectorAll(options.regionSelector)
      );
      const lastRegion = regionList[regionList.length - 1];
      if (!lastRegion) break;
      lastRegion.after(template);
      renderer2.render(
        cloneForRender(nextNodes[rest], liveDocument),
        template,
        false
      );
      template.remove();
    }
    options.setLastHTML(message.html);
  }
  function patchDocument(message, liveDocument) {
    const previousText = message.previousHtml || options.getLastHTML() || liveDocument.documentElement.outerHTML;
    const previousDocument = getDocumentParts(parseMarkup2(previousText));
    const nextDocument = getDocumentParts(parseMarkup2(message.html));
    if (!previousDocument.html || !nextDocument.html) {
      renderer2.render(
        parseMarkup2(message.html),
        liveDocument.documentElement,
        false
      );
      options.setLastHTML(message.html);
      return;
    }
    patchAttributes(liveDocument.documentElement, nextDocument.html);
    if (previousDocument.head && nextDocument.head && liveDocument.head) {
      patchChildren(
        previousDocument.head,
        nextDocument.head,
        liveDocument.head,
        liveDocument
      );
      patchAttributes(liveDocument.head, nextDocument.head);
    }
    if (previousDocument.body && nextDocument.body && liveDocument.body) {
      patchChildren(
        previousDocument.body,
        nextDocument.body,
        liveDocument.body,
        liveDocument
      );
      patchAttributes(liveDocument.body, nextDocument.body);
    }
    options.setLastHTML(message.html);
  }
  function getDocumentParts(parsed) {
    const htmlNode = parsed instanceof HTMLHtmlElement ? parsed : parsed.querySelector?.("html") || parsed;
    return {
      html: htmlNode,
      head: htmlNode.querySelector?.("head") || null,
      body: htmlNode.querySelector?.("body") || null
    };
  }
  function parseMarkup2(htmlText) {
    try {
      return renderer2.parse(htmlText);
    } catch {
      return renderer2.withoutReactivity(() => renderer2.parse(htmlText));
    }
  }
  function patchChildren(previousParent, nextParent, liveParent, liveDocument) {
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
        liveParent.append(cloneForRender(nextNode, liveDocument));
        nextIndex++;
        liveIndex++;
        continue;
      }
      if (!previousNode) {
        renderer2.render(
          cloneForRender(nextNode, liveDocument),
          liveNode,
          false
        );
        nextIndex++;
        liveIndex++;
        continue;
      }
      const previousMatch = findStaticMatch(
        previousNodes,
        nextNode,
        previousIndex + 1
      );
      const nextMatch = findStaticMatch(nextNodes, previousNode, nextIndex + 1);
      if (previousMatch !== -1 && nextMatch === -1) {
        liveNode.remove();
        previousIndex++;
        continue;
      }
      if (nextMatch !== -1) {
        liveNode.before(cloneForRender(nextNode, liveDocument));
        nextIndex++;
        liveIndex++;
        continue;
      }
      if (sameNodeIdentity(previousNode, nextNode)) {
        patchNode(previousNode, nextNode, liveNode, liveDocument);
        previousIndex++;
        nextIndex++;
        liveIndex++;
        continue;
      }
      renderer2.render(cloneForRender(nextNode, liveDocument), liveNode, false);
      previousIndex++;
      nextIndex++;
      liveIndex++;
    }
    while (previousIndex < previousNodes.length && nextLiveNode(liveParent, liveIndex)) {
      nextLiveNode(liveParent, liveIndex).remove();
      previousIndex++;
    }
  }
  function patchNode(previousNode, nextNode, liveNode, liveDocument) {
    if (sameStaticNode(previousNode, nextNode)) return;
    if (previousNode.nodeType !== nextNode.nodeType || liveNode.nodeType !== nextNode.nodeType) {
      renderer2.render(cloneForRender(nextNode, liveDocument), liveNode, false);
      return;
    }
    if (nextNode.nodeType === Node.TEXT_NODE) {
      liveNode.nodeValue = nextNode.nodeValue;
      return;
    }
    if (nextNode.nodeType !== Node.ELEMENT_NODE) {
      renderer2.render(cloneForRender(nextNode, liveDocument), liveNode, false);
      return;
    }
    if (nextNode.localName === "script") {
      patchScript(previousNode, nextNode, liveNode, liveDocument);
      return;
    }
    patchAttributes(liveNode, nextNode);
    patchChildren(previousNode, nextNode, liveNode, liveDocument);
  }
  function patchScript(previousScript, nextScript, liveScript, liveDocument) {
    if (previousScript.isEqualNode(nextScript)) return;
    const clone = cloneScript(nextScript, liveDocument);
    const source = clone.getAttribute("src");
    if (source) clone.setAttribute("src", options.bust(source));
    renderer2.render(clone, liveScript, false);
  }
  function cloneForRender(node, liveDocument) {
    if (node.nodeType === Node.ELEMENT_NODE && node.localName === "script") {
      return cloneScript(node, liveDocument);
    }
    return node.cloneNode(true);
  }
  function cloneScript(script, liveDocument) {
    const clone = liveDocument.createElement("script");
    for (const attr of Array.from(script.attributes)) {
      clone.setAttribute(attr.name, attr.value);
    }
    clone.textContent = script.textContent;
    return clone;
  }
  function patchAttributes(liveElement, nextElement) {
    for (const attr of Array.from(liveElement.attributes)) {
      if (!nextElement.hasAttribute(attr.name)) {
        liveElement.removeAttribute(attr.name);
      }
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
    return previousNode.nodeType === nextNode.nodeType && previousNode.nodeName === nextNode.nodeName;
  }
  function findStaticMatch(nodes, needle, start) {
    for (let index = start; index < nodes.length; index++) {
      if (sameStaticNode(nodes[index], needle)) return index;
    }
    return -1;
  }
  function cloneComparable(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll?.(options.clientSelector).forEach((script) => script.remove());
    if (clone.matches?.(options.clientSelector)) clone.remove();
    return clone;
  }
  function comparableNodes(parent) {
    return Array.from(parent.childNodes).filter(
      (node) => !(node.nodeType === Node.ELEMENT_NODE && node.matches?.(options.clientSelector))
    );
  }
  function nextLiveNode(parent, index) {
    return comparableNodes(parent)[index];
  }
}
function isDocumentHTML(htmlText) {
  const trimmed = htmlText.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

// src/hmr-client.ts
var renderer = {
  parse: parseMarkup,
  render: hydroRender,
  withoutReactivity(parse) {
    setShouldSetReactivity(false);
    try {
      return parse();
    } finally {
      setShouldSetReactivity(true);
    }
  }
};
var FILE = "__HMR_FILE__";
var ID = "__HMR_ID__";
var SRC = "__HMR_SRC__";
var REGION = '[data-hmr="__HMR_ID__"]';
var CLIENT = 'script[data-hmr-client="__HMR_ID__"]';
var SERVER_ID_KEY = "html-bundle-hmr-server-id";
if (document.readyState === "complete") {
  window.isHMR = true;
} else {
  document.addEventListener("DOMContentLoaded", () => window.isHMR = true, {
    once: true
  });
}
var hub = window.__htmlBundleHMR || (window.__htmlBundleHMR = createHub(SRC));
hub.currentUnit = FILE;
if (!window.htmlBundleHMR) {
  window.htmlBundleHMR = {
    accept(callback) {
      hub.addAccept(hub.currentUnit, callback);
    },
    dispose(callback) {
      hub.addDispose(hub.currentUnit, callback);
    },
    get data() {
      return hub.dataFor(hub.currentUnit);
    }
  };
}
hub.register(FILE, ID, { patch });
var domPatcher = createDOMPatcher(renderer, {
  regionSelector: REGION,
  clientSelector: CLIENT,
  getLastHTML: () => hub.lastHTML.get(FILE),
  setLastHTML: (htmlText) => hub.lastHTML.set(FILE, htmlText),
  bust
});
function patch(message) {
  const previousScroll = window.scrollY;
  const fullDocument = isFullDocument(message.html);
  domPatcher.patch(message, document);
  if (fullDocument && FILE === SRC + "/index.html") {
    dispatchEvent(new Event("popstate"));
  }
  window.scrollTo(0, previousScroll);
}
function isFullDocument(htmlText) {
  const trimmed = htmlText.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}
function parseMarkup(htmlText) {
  return html`${htmlText}`;
}
function bust(url) {
  return url.split("?")[0] + "?v=" + Date.now();
}
function createHub(src) {
  const registry = /* @__PURE__ */ new Map();
  const accepts = /* @__PURE__ */ new Map();
  const disposers = /* @__PURE__ */ new Map();
  const store = /* @__PURE__ */ new Map();
  const throttle = /* @__PURE__ */ new Map();
  let source;
  let reconnectTimer;
  let reloadTimer;
  let shouldReconnect = true;
  let serverId = getStoredServerId();
  const hub2 = {
    currentUnit: null,
    lastHTML: /* @__PURE__ */ new Map(),
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
      if (!store.has(file)) store.set(file, {});
      return store.get(file);
    },
    dispatch(message) {
      if (message.type === "connected") {
        if (serverId !== void 0 && serverId !== message.id) reloadPage();
        serverId = message.id;
        storeServerId(message.id);
      } else if (message.type === "html") {
        const entry = registry.get(message.file);
        if (!entry) return;
        hub2.currentUnit = message.file;
        run(disposers, message.file);
        try {
          entry.patch(message);
        } catch (error) {
          console.error("[html-bundle HMR] patch failed", error);
        }
        run(accepts, message.file);
      } else if (message.type === "css") {
        once("css", bustStylesheets);
      } else if (message.type === "asset") {
        once("asset:" + message.file, () => bustAsset(message.file));
      } else if (message.type === "full-reload") {
        reloadPage();
      }
    }
  };
  function push(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  function getStoredServerId() {
    try {
      return sessionStorage.getItem(SERVER_ID_KEY) || void 0;
    } catch {
      return void 0;
    }
  }
  function storeServerId(id) {
    try {
      sessionStorage.setItem(SERVER_ID_KEY, id);
    } catch {
    }
  }
  function run(map, key) {
    const callbacks = map.get(key);
    if (!callbacks || !callbacks.length) return;
    map.set(key, []);
    for (const callback of callbacks) {
      try {
        callback();
      } catch (error) {
        console.error("[html-bundle HMR] callback failed", error);
      }
    }
  }
  function once(key, action) {
    const now = performance.now();
    if (!throttle.has(key) || now - throttle.get(key) > 100) {
      throttle.set(key, now);
      action();
    }
  }
  function reloadPage() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => window.location.reload(), 20);
  }
  function bustStylesheets() {
    document.querySelectorAll('link[rel="stylesheet"][href]').forEach((link) => {
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
    if (source) return;
    shouldReconnect = true;
    source = new EventSource("/hmr");
    source.addEventListener("message", (event) => {
      const message = decodeHMRMessage(event.data);
      if (!message) return;
      hub2.dispatch(message);
    });
    source.addEventListener("error", () => {
      source.close();
      source = void 0;
      if (shouldReconnect) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1e3);
      }
    });
    window.addEventListener(
      "pagehide",
      () => {
        shouldReconnect = false;
        clearTimeout(reconnectTimer);
        if (source) source.close();
        source = void 0;
      },
      { once: true }
    );
  }
  return hub2;
}
