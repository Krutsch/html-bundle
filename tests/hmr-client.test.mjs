// Client-runtime tests for the compiled HMR client (dist/hmr-client.js, built
// from src/hmr-client.ts).
//
// The runtime is a real browser module, so we exercise it under happy-dom with
// the real hydro-js: replace its `hydro-js` import with injected deps, load it
// per page via `new Function`, then drive it through the shared hub the same way
// the browser's EventSource would.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Window } from "happy-dom";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const clientPath = path.join(repoRoot, "dist", "hmr-client.js");
const clientSrc = await readFile(clientPath, "utf8");

// Fresh DOM, globals and hub per test so state never leaks between cases.
async function setup() {
  const w = new Window({ url: "http://localhost:5000/" });
  globalThis.window = w;
  globalThis.document = w.document;
  globalThis.Node = w.Node;
  globalThis.HTMLHtmlElement = w.HTMLHtmlElement;
  globalThis.HTMLElement = w.HTMLElement;
  globalThis.Event = w.Event;
  globalThis.performance = w.performance ?? { now: () => Date.now() };
  globalThis.dispatchEvent = w.dispatchEvent
    ? w.dispatchEvent.bind(w)
    : () => {};
  w.scrollTo = () => {};

  let eventSourceCount = 0;
  globalThis.EventSource = class {
    constructor() {
      eventSourceCount++;
    }
    addEventListener() {}
    close() {}
  };

  let reloadCount = 0;
  w.location.reload = () => {
    reloadCount++;
  };
  globalThis.__hydro = await import("hydro-js");

  function loadPage(file, id, src = "src") {
    const code = clientSrc
      .replace(
        'import { render as hydroRender, html, setShouldSetReactivity } from "hydro-js";',
        "const { render: hydroRender, html, setShouldSetReactivity } = globalThis.__hydro;",
      )
      .replaceAll("__HMR_FILE__", file)
      .replaceAll("__HMR_ID__", id)
      .replaceAll("__HMR_SRC__", src);
    // eslint-disable-next-line no-new-func
    new Function(code)();
  }

  return {
    window: w,
    document: w.document,
    loadPage,
    eventSourceCount: () => eventSourceCount,
    reloadCount: () => reloadCount,
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FULL_BEFORE =
  "<!DOCTYPE html><html><head><title>Before</title></head><body><main class='center'></main></body></html>";
const FULL_AFTER =
  "<!DOCTYPE html><html><head><title>After</title></head><body><main class='center'></main></body></html>";

test("shared hub patches a full-document title change in place", async () => {
  const { document, loadPage } = await setup();
  document.documentElement.innerHTML =
    "<head><title>Before</title></head><body><main class='center'></main></body>";

  loadPage("src/index.html", "idx1");
  assert.ok(window.__htmlBundleHMR, "hub is created");
  assert.equal(typeof window.htmlBundleHMR.dispose, "function");

  window.__htmlBundleHMR.dispatch({
    type: "html",
    file: "src/index.html",
    previousHtml: FULL_BEFORE,
    html: FULL_AFTER,
  });

  assert.equal(document.querySelector("title").textContent, "After");
});

test("full-document insertion before a composed mount preserves fetched content", async () => {
  const { document, loadPage, reloadCount } = await setup();
  const before =
    "<!DOCTYPE html><html><head><title>Fixture</title></head><body><noscript>Enable JS</noscript><main class='center'></main></body></html>";
  const after =
    "<!DOCTYPE html><html><head><title>Fixture</title></head><body><p id='new-copy'>New copy</p><noscript>Enable JS</noscript><main class='center'></main></body></html>";
  document.documentElement.innerHTML =
    "<head><title>Fixture</title></head><body><noscript>Enable JS</noscript><main class='center'><picture><img src='@public/splash.webp'></picture></main></body>";

  loadPage("src/index.html", "idx1");
  window.__htmlBundleHMR.dispatch({
    type: "html",
    file: "src/index.html",
    previousHtml: before,
    html: after,
  });

  assert.equal(document.querySelector("#new-copy")?.textContent, "New copy");
  assert.ok(document.querySelector("main.center img"));
  assert.equal(reloadCount(), 0);
});

test("same-tag insertion before a composed mount preserves fetched content", async () => {
  const { document, loadPage } = await setup();
  const before =
    "<!DOCTYPE html><html><head><title>Fixture</title></head><body><main class='center'></main></body></html>";
  const after =
    "<!DOCTYPE html><html><head><title>Fixture</title></head><body><main id='banner'>New copy</main><main class='center'></main></body></html>";
  document.documentElement.innerHTML =
    "<head><title>Fixture</title></head><body><main class='center'><picture><img src='@public/splash.webp'></picture></main></body>";

  loadPage("src/index.html", "idx1");
  window.__htmlBundleHMR.dispatch({
    type: "html",
    file: "src/index.html",
    previousHtml: before,
    html: after,
  });

  assert.equal(document.querySelector("#banner")?.textContent, "New copy");
  assert.ok(document.querySelector("main.center img"));
});

test("full-reload events trigger a debounced page reload", async () => {
  const { loadPage, reloadCount } = await setup();
  loadPage("src/index.html", "idx1");

  window.__htmlBundleHMR.dispatch({
    type: "full-reload",
    file: "src/@shared/workerCode.ts",
  });
  window.__htmlBundleHMR.dispatch({
    type: "full-reload",
    file: "src/@shared/workerCode.ts",
  });
  await wait(30);

  assert.equal(reloadCount(), 1);
});

test("single-root fragment update patches only its own region", async () => {
  const { document, loadPage } = await setup();
  document.body.innerHTML =
    "<main class='center'><div data-hmr='app1'>Old</div></main>";

  loadPage("src/app/index.html", "app1");
  window.__htmlBundleHMR.dispatch({
    type: "html",
    file: "src/app/index.html",
    html: "<main data-hmr='app1'>New</main>",
  });

  const region = document.querySelector('[data-hmr="app1"]');
  assert.equal(region.textContent, "New");
});

test("dispose runs before re-patch and data persists across updates", async () => {
  const { document, loadPage } = await setup();
  document.body.innerHTML = "<div data-hmr='app1'>Old</div>";
  loadPage("src/app/index.html", "app1");

  let disposed = false;
  window.htmlBundleHMR.dispose(() => {
    disposed = true;
  });
  window.htmlBundleHMR.data.persisted = 42;

  window.__htmlBundleHMR.dispatch({
    type: "html",
    file: "src/app/index.html",
    html: "<div data-hmr='app1'>New</div>",
  });

  assert.equal(disposed, true);
  assert.equal(window.htmlBundleHMR.data.persisted, 42);
});

test("css event cache-busts stylesheet links", async () => {
  const { document, loadPage } = await setup();
  document.documentElement.innerHTML =
    '<head><link rel="stylesheet" href="@public/base.css"></head><body></body>';
  loadPage("src/index.html", "idx1");

  window.__htmlBundleHMR.dispatch({
    type: "css",
    file: "src/@public/base.css",
  });

  const href = document.querySelector("link").getAttribute("href");
  assert.match(href, /^@public\/base\.css\?v=\d+$/);
});

test("asset event cache-busts the matching element", async () => {
  const { document, loadPage } = await setup();
  document.body.innerHTML = '<img src="@public/splash.webp">';
  loadPage("src/index.html", "idx1");

  window.__htmlBundleHMR.dispatch({
    type: "asset",
    file: "src/@public/splash.webp",
  });

  const src = document.querySelector("img").getAttribute("src");
  assert.match(src, /^@public\/splash\.webp\?v=\d+$/);
});

test("a change to an unregistered page is a safe no-op", async () => {
  const { document, loadPage } = await setup();
  document.documentElement.innerHTML =
    "<head><title>Before</title></head><body></body>";
  loadPage("src/index.html", "idx1");

  assert.doesNotThrow(() =>
    window.__htmlBundleHMR.dispatch({
      type: "html",
      file: "src/never.html",
      html: "<div></div>",
    }),
  );
  assert.equal(document.querySelector("title").textContent, "Before");
});

test("all composed pages share exactly one EventSource", async () => {
  const { loadPage, eventSourceCount } = await setup();
  loadPage("src/index.html", "idx1");
  loadPage("src/app/index.html", "app1");
  loadPage("src/link/index.html", "lnk1");

  assert.equal(eventSourceCount(), 1);
});
