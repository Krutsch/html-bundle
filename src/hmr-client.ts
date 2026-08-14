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
import { decodeHMRMessage, type HMRMessage } from "./hmr-protocol.mjs";
import { createDOMPatcher, type DOMRenderer } from "./dom-patch.mjs";

// hydro-js's `render` is typed against its own `html()` output; this client
// feeds it arbitrary DOM nodes and uses `false` for `where` (a detached render),
// so widen the signature. The assertion is type-only — esbuild strips it and the
// runtime binding stays hydro-js's `render`.
const renderer: DOMRenderer = {
  parse: parseMarkup,
  render: hydroRender as unknown as DOMRenderer["render"],
  withoutReactivity<T>(parse: () => T): T {
    setShouldSetReactivity(false);
    try {
      return parse();
    } finally {
      setShouldSetReactivity(true);
    }
  },
};

// HMR messages delivered over the shared EventSource; mirrors the server's
// HMREvent union (utils.mts). Kept local so the browser runtime never pulls the
// Node build's module graph into type-checking.
type HTMLMessage = Extract<HMRMessage, { type: "html" }>;

type PatchHandler = { id?: string; patch: (message: HTMLMessage) => void };

type Hub = {
  currentUnit: string | null;
  lastHTML: Map<string, string>;
  register(
    file: string,
    id: string,
    handler: { patch: (message: HTMLMessage) => void },
  ): void;
  addAccept(file: string, callback: () => void): void;
  addDispose(file: string, callback: () => void): void;
  dataFor(file: string): Record<string, unknown>;
  dispatch(message: HMRMessage): void;
};

type HMRPublicAPI = {
  accept(callback: () => void): void;
  dispose(callback: () => void): void;
  readonly data: Record<string, unknown>;
};

declare global {
  interface Window {
    isHMR?: boolean;
    __htmlBundleHMR?: Hub;
    htmlBundleHMR?: HMRPublicAPI;
  }
}

const FILE = "__HMR_FILE__";
const ID = "__HMR_ID__";
const SRC = "__HMR_SRC__";
const REGION = '[data-hmr="__HMR_ID__"]';
const CLIENT = 'script[data-hmr-client="__HMR_ID__"]';
const SERVER_ID_KEY = "html-bundle-hmr-server-id";

// The client is injected as the first <head> module so its hub and public API
// exist before the page's own scripts run. But `window.isHMR` must NOT be
// observable while those scripts execute for the first time: user code commonly
// branches on it to run one-time setup exactly once (e.g.
// `if (!window.isHMR) createRouter()`), relying on the flag being false on the
// pristine load and true on every hot re-run afterwards. Assigning it eagerly
// here runs before the page scripts and breaks that contract, leaving one-time
// init skipped (e.g. an SPA router never mounts, so its outlet stays empty).
// Flag it only after the initial module scripts have executed:
//   - initial load: readyState is "interactive"; set it on DOMContentLoaded,
//     which fires after the page's own deferred/module scripts.
//   - hot re-render / composed page registered post-load: readyState is
//     "complete"; set it immediately, since we are already past the first load.
if (document.readyState === "complete") {
  window.isHMR = true;
} else {
  document.addEventListener("DOMContentLoaded", () => (window.isHMR = true), {
    once: true,
  });
}

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
      hub.addAccept(hub.currentUnit!, callback);
    },
    dispose(callback) {
      hub.addDispose(hub.currentUnit!, callback);
    },
    get data() {
      return hub.dataFor(hub.currentUnit!);
    },
  };
}

hub.register(FILE, ID, { patch });

// --- per-page patching (closes over this page's own hydro-js instance) --------

const domPatcher = createDOMPatcher(renderer, {
  regionSelector: REGION,
  clientSelector: CLIENT,
  getLastHTML: () => hub.lastHTML.get(FILE),
  setLastHTML: (htmlText) => hub.lastHTML.set(FILE, htmlText),
  bust,
});

function patch(message: HTMLMessage): void {
  const previousScroll = window.scrollY;
  const fullDocument = isFullDocument(message.html);
  domPatcher.patch(message, document);
  if (fullDocument && FILE === SRC + "/index.html") {
    dispatchEvent(new Event("popstate"));
  }
  window.scrollTo(0, previousScroll);
}

function isFullDocument(htmlText: string): boolean {
  const trimmed = htmlText.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

function parseMarkup(htmlText: string): ReturnType<DOMRenderer["parse"]> {
  return html`${htmlText}`;
}

function bust(url: string): string {
  return url.split("?")[0] + "?v=" + Date.now();
}

// --- shared hub (created once by the first page to load) ----------------------

function createHub(src: string): Hub {
  const registry = new Map<string, PatchHandler>();
  const accepts = new Map<string, Array<() => void>>();
  const disposers = new Map<string, Array<() => void>>();
  const store = new Map<string, Record<string, unknown>>();
  const throttle = new Map<string, number>();
  let source: EventSource | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let shouldReconnect = true;
  let serverId = getStoredServerId();

  const hub: Hub = {
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
      if (!store.has(file)) store.set(file, {});
      return store.get(file)!;
    },
    dispatch(message) {
      if (message.type === "connected") {
        if (serverId !== undefined && serverId !== message.id) reloadPage();
        serverId = message.id;
        storeServerId(message.id);
      } else if (message.type === "html") {
        const entry = registry.get(message.file);
        if (!entry) return;
        hub.currentUnit = message.file;
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
    },
  };

  function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(value);
  }

  function getStoredServerId(): string | undefined {
    try {
      return sessionStorage.getItem(SERVER_ID_KEY) || undefined;
    } catch {
      return undefined;
    }
  }

  function storeServerId(id: string): void {
    try {
      sessionStorage.setItem(SERVER_ID_KEY, id);
    } catch {}
  }

  function run(map: Map<string, Array<() => void>>, key: string): void {
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

  // Coalesce bursts of identical events (e.g. a save that touches many files).
  function once(key: string, action: () => void): void {
    const now = performance.now();
    if (!throttle.has(key) || now - throttle.get(key)! > 100) {
      throttle.set(key, now);
      action();
    }
  }

  function reloadPage(): void {
    // Own timer (not reconnectTimer) so an SSE reconnect can't cancel a pending
    // reload and vice versa.
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => window.location.reload(), 20);
  }

  function bustStylesheets(): void {
    document
      .querySelectorAll('link[rel="stylesheet"][href]')
      .forEach((link) => {
        const href = link.getAttribute("href")!.split("?")[0];
        link.setAttribute("href", href + "?v=" + Date.now());
      });
  }

  function bustAsset(file: string): void {
    if (file.endsWith(".css")) {
      bustStylesheets();
      return;
    }

    const prefix = src + "/";
    const relative =
      file.indexOf(prefix) === 0 ? file.slice(prefix.length) : file;
    const version = "?v=" + Date.now();

    bustAttribute("img[src]", "src", relative, version);
    bustAttribute("script[src]", "src", relative, version);
    bustAttribute("link[href]", "href", relative, version);
    bustContains("source[srcset]", "srcset", relative, version);
    bustAttribute("img[data-src]", "data-src", relative, version);
  }

  function bustAttribute(
    selector: string,
    attribute: string,
    relative: string,
    version: string,
  ): void {
    document.querySelectorAll(selector).forEach((node) => {
      const value = node.getAttribute(attribute);
      if (value && value.split("?")[0] === relative) {
        node.setAttribute(attribute, value.split("?")[0] + version);
      }
    });
  }

  function bustContains(
    selector: string,
    attribute: string,
    relative: string,
    version: string,
  ): void {
    document.querySelectorAll(selector).forEach((node) => {
      const value = node.getAttribute(attribute);
      if (value && value.split("?")[0].indexOf(relative) !== -1) {
        node.setAttribute(attribute, value.split("?")[0] + version);
      }
    });
  }

  function connect(): void {
    if (source) return;
    shouldReconnect = true;
    source = new EventSource("/hmr");
    source.addEventListener("message", (event) => {
      const message = decodeHMRMessage(event.data);
      if (!message) return;
      hub.dispatch(message);
    });
    source.addEventListener("error", () => {
      source!.close();
      source = undefined;
      if (shouldReconnect) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1000);
      }
    });
    window.addEventListener(
      "pagehide",
      () => {
        shouldReconnect = false;
        clearTimeout(reconnectTimer);
        if (source) source.close();
        source = undefined;
      },
      { once: true },
    );
  }

  return hub;
}
