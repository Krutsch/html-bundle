import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyChange,
  createHTMLRebuildEvents,
  getBuildImpact,
} from "../dist/build-impact.mjs";

test("classifies source changes by build impact", () => {
  assert.equal(classifyChange("src/index.html"), "html");
  assert.equal(classifyChange("src/app.ts"), "module");
  assert.equal(classifyChange("src/data.json"), "json");
  assert.equal(classifyChange("src/styles.css"), "css");
  assert.equal(classifyChange("src/assets/logo.svg"), "asset");
});

test("module and JSON changes conservatively rebuild every HTML page", () => {
  for (const file of ["src/app.ts", "src/data.json"]) {
    assert.deepEqual(getBuildImpact(file), {
      kind: file.endsWith(".json") ? "json" : "module",
      rebuildCSS: true,
      rebuildInlineScripts: true,
      htmlScope: "all",
      copySource: file.endsWith(".json"),
      event: "html",
    });
  }
});

test("HTML, CSS, and asset changes retain current event scope", () => {
  assert.equal(getBuildImpact("src/index.html").htmlScope, "changed");
  assert.equal(getBuildImpact("src/styles.css").event, "css");
  assert.equal(getBuildImpact("src/assets/logo.svg").event, "asset");
  assert.equal(getBuildImpact("src/styles.css").rebuildInlineScripts, false);
});

test("module rebuild emits changed pages and falls back to full reload", () => {
  assert.deepEqual(
    createHTMLRebuildEvents("src/worker.ts", [
      { file: "src/index.html", html: "new", previousHtml: "old" },
      { file: "src/about.html", html: "same", previousHtml: "same" },
    ]),
    [
      {
        type: "html",
        file: "src/index.html",
        html: "new",
        previousHtml: "old",
      },
    ],
  );

  assert.deepEqual(
    createHTMLRebuildEvents("src/worker.ts", [
      { file: "src/index.html", html: "same", previousHtml: "same" },
    ]),
    [{ type: "full-reload", file: "src/worker.ts" }],
  );
});
