import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createDOMPatcher } from "../dist/dom-patch.mjs";

function setupRenderer(window) {
  return {
    parse(htmlText) {
      const isDocument =
        htmlText.trimStart().toLowerCase().startsWith("<!doctype html") ||
        htmlText.trimStart().toLowerCase().startsWith("<html");
      if (isDocument) {
        return new window.DOMParser().parseFromString(htmlText, "text/html")
          .documentElement;
      }
      const template = window.document.createElement("template");
      template.innerHTML = htmlText;
      return template.content;
    },
    render(element, where) {
      if (!where || typeof where === "string") return;
      where.parentNode?.replaceChild(element, where);
    },
    withoutReactivity(parse) {
      return parse();
    },
  };
}

function setup(initialHTML) {
  const window = new Window({ url: "http://localhost:5000/" });
  globalThis.Node = window.Node;
  globalThis.HTMLHtmlElement = window.HTMLHtmlElement;
  globalThis.document = window.document;
  window.document.documentElement.innerHTML = initialHTML;
  let lastHTML;
  const patcher = createDOMPatcher(setupRenderer(window), {
    regionSelector: '[data-hmr="app"]',
    clientSelector: 'script[data-hmr-client="client"]',
    getLastHTML: () => lastHTML,
    setLastHTML: (html) => (lastHTML = html),
    bust: (url) => url.split("?")[0] + "?v=1",
  });
  return { window, patcher };
}

test("DOM patch module preserves mounted content during full-document updates", () => {
  const { window, patcher } = setup(
    '<head><title>Before</title></head><body><main data-hmr="app"><div id="mounted">Client content</div></main></body>',
  );
  const full = patcher.patch(
    {
      previousHtml:
        '<!DOCTYPE html><html><head><title>Before</title></head><body><main data-hmr="app"></main></body></html>',
      html: '<!DOCTYPE html><html><head><title>After</title></head><body><p>New</p><main data-hmr="app"></main></body></html>',
    },
    window.document,
  );

  assert.equal(full, true);
  assert.equal(window.document.querySelector("title").textContent, "After");
  assert.equal(
    window.document.querySelector("#mounted").textContent,
    "Client content",
  );
  assert.equal(window.document.querySelector("body > p").textContent, "New");
});

test("DOM patch module updates fragment identity and preserves matching region state", () => {
  const { window, patcher } = setup(
    '<main data-hmr="app" class="old"><input value="typed"></main>',
  );
  const full = patcher.patch(
    {
      previousHtml: '<main data-hmr="app" class="old"><input value=""></main>',
      html: '<main data-hmr="app" class="new"><input value=""></main>',
    },
    window.document,
  );

  assert.equal(full, false);
  assert.equal(window.document.querySelector("main").className, "new");
  assert.equal(window.document.querySelector("input").value, "typed");
});

test("DOM patch module handles insertions, removals, and script reruns through renderer seam", () => {
  const { window, patcher } = setup(
    '<main data-hmr="app"><p id="keep">Keep</p><script>old()</script></main>',
  );
  patcher.patch(
    {
      previousHtml:
        '<main data-hmr="app"><p id="keep">Keep</p><script>old()</script></main>',
      html: '<main data-hmr="app"><h1>New</h1><p id="keep">Keep</p><script>next()</script></main>',
    },
    window.document,
  );

  assert.equal(window.document.querySelector("h1").textContent, "New");
  assert.equal(window.document.querySelector("#keep").textContent, "Keep");
  assert.match(window.document.querySelector("script").textContent, /next\(\)/);
});
