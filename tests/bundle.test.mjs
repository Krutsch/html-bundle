import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFilePromise = promisify(execFile);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const bundlePath = path.join(repoRoot, "dist", "bundle.mjs");
const utilsPath = path.join(repoRoot, "dist", "utils.mjs");

test("CLI builds HTML, CSS, JS, and static files", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "html-bundle-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));

  await mkdir(path.join(cwd, "src", "assets"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "index.html"),
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Fixture</title>
    <link rel="stylesheet" href="./styles.css">
    <style>
      main { color: red; }
    </style>
    <script type="module" src="./app.js"></script>
    <script type="module">
      const value: string = "inline";
      window.inlineResult = value;
    </script>
  </head>
  <body>
    <main>Fixture</main>
  </body>
</html>`,
  );
  await writeFile(
    path.join(cwd, "src", "styles.css"),
    "body { margin: 0; color: #ff0000; }",
  );
  await writeFile(
    path.join(cwd, "src", "app.ts"),
    `const message: string = "external";
document.body.dataset.external = message;`,
  );
  await writeFile(path.join(cwd, "src", "assets", "note.txt"), "static");

  await execFilePromise(process.execPath, [bundlePath], { cwd });

  const html = await readFile(path.join(cwd, "build", "index.html"), "utf8");
  const css = await readFile(path.join(cwd, "build", "styles.css"), "utf8");
  const js = await readFile(path.join(cwd, "build", "app.js"), "utf8");
  const copied = await readFile(
    path.join(cwd, "build", "assets", "note.txt"),
    "utf8",
  );

  assert.match(html, /main\{color:red\}/);
  assert.match(html, /inlineResult/);
  assert.match(html, /inline/);
  assert.doesNotMatch(html, /value: string/);
  assert.equal(css, "body{margin:0;color:red}");
  assert.match(js, /external/);
  assert.equal(copied, "static");

  await assert.rejects(
    readFile(path.join(cwd, "src", "index-bundle-1.tsx"), "utf8"),
    { code: "ENOENT" },
  );
});

test("addHMRCode injects stable HMR wiring", async () => {
  const { addHMRCode } = await import(pathToFileURL(utilsPath).href);

  const fullDocument = addHMRCode(
    "<!DOCTYPE html><html><head><title>Fixture</title></head><body><main>Hi</main></body></html>",
    "src/index.html",
  );
  const fragment = addHMRCode("<main>Hi</main>", "src/fragment.html");

  assert.match(fullDocument, /<script type="module">/);
  assert.match(fullDocument, /new EventSource\("\/hmr"\)/);
  assert.match(
    fullDocument,
    /window\.htmlBundleHMRConnections \|\|= new Map\(\)/,
  );
  assert.match(fullDocument, /window\.addEventListener\("pagehide"/);
  assert.match(fullDocument, /eventSource\.close\(\)/);
  assert.match(fullDocument, /data-hmr="[^"]+"/);
  assert.ok(
    fullDocument.indexOf("<head>") <
      fullDocument.indexOf('<script type="module">'),
  );

  assert.match(fragment, /^<main data-hmr="[^"]+">Hi<\/main>/);
  assert.match(fragment, /new EventSource\("\/hmr"\)/);
  assert.match(fragment, /window\.htmlBundleHMRActiveId ===/);
});

test("getBuildPath maps src paths into the build directory", async () => {
  const { getBuildPath } = await import(pathToFileURL(utilsPath).href);

  assert.equal(getBuildPath("src/index.html"), "build/index.html");
  assert.equal(
    getBuildPath("src/nested/deep/app.ts"),
    "build/nested/deep/app.ts",
  );
});

test("addHMRCode ids are stable per file and unique across files", async () => {
  const { addHMRCode } = await import(pathToFileURL(utilsPath).href);

  const idOf = (html) => html.match(/data-hmr="([^"]+)"/)?.[1];

  const first = addHMRCode("<main>Hi</main>", "src/stable.html");
  const second = addHMRCode("<main>Hi</main>", "src/stable.html");
  const other = addHMRCode("<main>Hi</main>", "src/other.html");

  assert.equal(idOf(first), idOf(second));
  assert.notEqual(idOf(first), idOf(other));
});

test("addHMRCode tags every fragment root node with the same id", async () => {
  const { addHMRCode } = await import(pathToFileURL(utilsPath).href);

  const fragment = addHMRCode(
    "<main>Hi</main><section>Yo</section>",
    "src/multi.html",
  );
  const mainId = fragment.match(/<main data-hmr="([^"]+)">Hi<\/main>/)?.[1];
  const sectionId = fragment.match(
    /<section data-hmr="([^"]+)">Yo<\/section>/,
  )?.[1];

  assert.ok(mainId);
  assert.equal(mainId, sectionId);
});

test("CLI keeps importmap and JSON-LD scripts and cleans stale bundles", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "html-bundle-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));

  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "src", "app.ts"),
    `export const x: number = 1;`,
  );
  await writeFile(
    path.join(cwd, "src", "index.html"),
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>Fixture</title>
    <script type="importmap">{ "imports": { "app": "./app.js" } }</script>
    <script type="application/ld+json">{ "@context": "https://schema.org", "@type": "WebSite" }</script>
    <script type="module">globalThis.__real__ = true;</script>
  </head>
  <body>
    <main>Hi</main>
  </body>
</html>`,
  );

  await execFilePromise(process.execPath, [bundlePath], { cwd });

  const html = await readFile(path.join(cwd, "build", "index.html"), "utf8");

  assert.match(html, /type="importmap"/);
  assert.match(html, /"imports"/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /schema\.org/);
  assert.match(html, /__real__/);

  const srcEntries = await readdir(path.join(cwd, "src"), { recursive: true });
  const buildEntries = await readdir(path.join(cwd, "build"), {
    recursive: true,
  });
  assert.ok(!srcEntries.some((e) => /-bundle-\d+\.tsx$/.test(String(e))));
  assert.ok(!buildEntries.some((e) => /-bundle-\d+\.js$/.test(String(e))));
});

test("CLI honors a custom bundle.config.js src and build directories", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "html-bundle-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));

  await mkdir(path.join(cwd, "source"), { recursive: true });
  await writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  await writeFile(
    path.join(cwd, "bundle.config.js"),
    `export default { src: "source", build: "out" };`,
  );
  await writeFile(
    path.join(cwd, "source", "index.html"),
    `<!DOCTYPE html><html lang="en"><head><title>T</title><style>main { color: red; }</style></head><body><main>Hi</main></body></html>`,
  );
  await writeFile(
    path.join(cwd, "source", "styles.css"),
    "body { margin: 0; color: #ff0000; }",
  );

  await execFilePromise(process.execPath, [bundlePath], { cwd });

  const html = await readFile(path.join(cwd, "out", "index.html"), "utf8");
  const css = await readFile(path.join(cwd, "out", "styles.css"), "utf8");

  assert.match(html, /main\{color:red\}/);
  assert.equal(css, "body{margin:0;color:red}");
  await assert.rejects(
    readFile(path.join(cwd, "build", "index.html"), "utf8"),
    { code: "ENOENT" },
  );
});
