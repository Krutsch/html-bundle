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

test("window.isHMR is hidden from the page's own initial scripts, then set for hot re-runs", async () => {
  // Regression: the client is injected as the first <head> module so its hub and
  // public API exist before the page's own scripts. It must NOT flip
  // window.isHMR before those scripts run, or one-time guards such as
  // `if (!window.isHMR) createRouter()` get skipped on the pristine load — the
  // symptom being an SPA whose outlet never mounts (an almost-empty page).
  const { window, document, loadPage } = await setup();
  assert.equal(document.readyState, "interactive"); // pristine load, still parsing

  loadPage("src/index.html", "idx1");
  assert.notEqual(
    window.isHMR,
    true,
    "isHMR must stay falsy while the page's own scripts run",
  );

  // DOMContentLoaded fires after those scripts; HMR mode is now observable so a
  // subsequent hot re-execution can take the isHMR branch and skip re-init.
  document.dispatchEvent(new window.Event("DOMContentLoaded"));
  assert.equal(
    window.isHMR,
    true,
    "isHMR is set once the initial load settles",
  );
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

test("inactive fragment update does not append into the current document", async () => {
  const { document, loadPage } = await setup();
  document.body.innerHTML =
    "<main><section id='active-route'>Checkbox route</section></main>";

  loadPage("src/ssr.html", "ssr1");
  window.__htmlBundleHMR.dispatch({
    type: "html",
    file: "src/ssr.html",
    html: "<h1 data-hmr='ssr1'>Server-Side Rendering</h1><p data-hmr='ssr1'>SSR copy</p>",
  });

  assert.equal(document.querySelector('[data-hmr="ssr1"]'), null);
  assert.equal(
    document.body.textContent.includes("Server-Side Rendering"),
    false,
  );
  assert.equal(
    document.querySelector("#active-route")?.textContent,
    "Checkbox route",
  );
});

test("parent fragment update preserves a mounted child outlet", async () => {
  const { document, loadPage } = await setup();
  const previousHtml =
    "<div data-hmr='doc1' class='layout'><aside>Old nav</aside><div data-outlet><h1>Getting started</h1><p>Parent default</p></div></div>";
  const nextHtml =
    "<div data-hmr='doc1' class='layout updated'><aside>New nav</aside><div data-outlet><h1>Getting started</h1><p>Parent default</p></div></div>";
  document.body.innerHTML =
    "<main><div data-hmr='doc1' class='layout'><aside>Old nav</aside><div data-outlet><h1 id='checkbox-route'>Checkbox route</h1><p>Child content</p></div></div></main>";

  loadPage("src/documentation.html", "doc1");
  window.__htmlBundleHMR.dispatch({
    type: "html",
    file: "src/documentation.html",
    previousHtml,
    html: nextHtml,
  });

  const region = document.querySelector('[data-hmr="doc1"]');
  assert.match(region.className, /updated/);
  assert.equal(region.querySelector("aside")?.textContent, "New nav");
  assert.equal(
    region.querySelector("#checkbox-route")?.textContent,
    "Checkbox route",
  );
  assert.equal(
    region
      .querySelector("[data-outlet]")
      ?.textContent.includes("Parent default"),
    false,
  );
});

test("fragment accept callback runs after a direct fragment patch", async () => {
  const { document, loadPage } = await setup();
  document.body.innerHTML = "<div data-hmr='app1'>Old</div>";
  loadPage("src/app/index.html", "app1");

  let accepted = false;
  window.htmlBundleHMR.accept(() => {
    accepted = true;
  });

  window.__htmlBundleHMR.dispatch({
    type: "html",
    file: "src/app/index.html",
    html: "<div data-hmr='app1'>New</div>",
  });

  assert.equal(document.querySelector('[data-hmr="app1"]')?.textContent, "New");
  assert.equal(accepted, true);
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
