import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HTMLTransformer } from "../dist/html-transformation.mjs";

test("HTML transformation classifies documents, fragments, and preserved scripts", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "html-bundle-transform-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "src"), { recursive: true });

  const documentFile = path.join(cwd, "src", "index.html");
  const fragmentFile = path.join(cwd, "src", "fragment.html");
  await writeFile(
    documentFile,
    `<!DOCTYPE html><html><head>
      <script type="importmap">{"imports":{"app":"./app.js"}}</script>
      <script type="application/ld+json">{"@type":"WebSite"}</script>
      <script type="module">window.documentScript = true;</script>
    </head><body><main>Document</main></body></html>`,
  );
  await writeFile(
    fragmentFile,
    `<main>One</main><section>Two</section>
      <script type="module">window.fragmentScript = true;</script>`,
  );

  const transformer = new HTMLTransformer({
    src: path.join(cwd, "src"),
    build: path.join(cwd, "build"),
    hmr: false,
  });
  const documentTransformation = await transformer.prepare(documentFile);
  const fragmentTransformation = await transformer.prepare(fragmentFile);

  assert.equal(documentTransformation.scripts.length, 1);
  assert.equal(fragmentTransformation.scripts.length, 1);
  assert.match(documentTransformation.serialize(), /type="importmap"/);
  assert.match(documentTransformation.serialize(), /application\/ld\+json/);
  assert.match(fragmentTransformation.serialize(), /<main>One<\/main>/);
  assert.match(fragmentTransformation.serialize(), /<section>Two<\/section>/);
  assert.deepEqual(
    transformer.generatedFiles().sort(),
    [
      documentFile.replace(".html", "-bundle-2.tsx"),
      fragmentFile.replace(".html", "-bundle-0.tsx"),
    ].sort(),
  );
});

test("HTML transformation applies bundled inline scripts and cleans generated files", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "html-bundle-transform-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(path.join(cwd, "build"), { recursive: true });

  const file = path.join(cwd, "src", "index.html");
  const buildFile = path.join(cwd, "build", "index.html");
  await writeFile(
    file,
    `<!DOCTYPE html><html><head><script type="module">const value = 1;</script></head><body></body></html>`,
  );

  const transformer = new HTMLTransformer({
    src: path.join(cwd, "src"),
    build: path.join(cwd, "build"),
    hmr: false,
  });
  const transformation = await transformer.prepare(file);
  const generatedJavaScript = buildFile.replace(".html", "-bundle-0.js");
  await writeFile(generatedJavaScript, `window.value = 2;\n  `);
  await transformation.applyBundledScripts(buildFile);
  await writeFile(buildFile, transformation.serialize());

  assert.match(await readFile(buildFile, "utf8"), /window.value = 2;/);
  assert.deepEqual(transformer.generatedFiles(), [
    file.replace(".html", "-bundle-0.tsx"),
  ]);

  await transformer.cleanupGeneratedFiles();
  await assert.rejects(readFile(file.replace(".html", "-bundle-0.tsx")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(generatedJavaScript), { code: "ENOENT" });
});

test("HTML transformation removes generated files when inline scripts disappear", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "html-bundle-transform-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(path.join(cwd, "build"), { recursive: true });

  const file = path.join(cwd, "src", "index.html");
  const oldSource = file.replace(".html", "-bundle-0.tsx");
  const oldOutput = path.join(cwd, "build", "index-bundle-0.js");
  await writeFile(
    file,
    '<main>Old</main><script type="module">window.old = true;</script>',
  );

  const transformer = new HTMLTransformer({
    src: path.join(cwd, "src"),
    build: path.join(cwd, "build"),
    hmr: false,
  });
  await transformer.prepare(file);
  await writeFile(oldOutput, "window.old = true;");
  await writeFile(file, "<main>New</main>");
  await transformer.prepare(file);

  assert.deepEqual(transformer.takeRemovedFiles(), [oldSource]);
  await assert.rejects(readFile(oldSource), { code: "ENOENT" });
  await assert.rejects(readFile(oldOutput), { code: "ENOENT" });
});

test("HTML transformation removes generated files when a page is deleted", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "html-bundle-transform-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await mkdir(path.join(cwd, "build"), { recursive: true });

  const file = path.join(cwd, "src", "index.html");
  const sourceFile = file.replace(".html", "-bundle-0.tsx");
  const outputFile = path.join(cwd, "build", "index-bundle-0.js");
  await writeFile(
    file,
    '<main>Page</main><script type="module">window.page = true;</script>',
  );

  const transformer = new HTMLTransformer({
    src: path.join(cwd, "src"),
    build: path.join(cwd, "build"),
    hmr: false,
  });
  await transformer.prepare(file);
  await writeFile(outputFile, "window.page = true;");
  await transformer.remove(file);

  assert.deepEqual(transformer.takeRemovedFiles(), [sourceFile]);
  await assert.rejects(readFile(sourceFile), { code: "ENOENT" });
  await assert.rejects(readFile(outputFile), { code: "ENOENT" });
  assert.equal(transformer.get(file), undefined);
});

test("HTML transformation injects stable HMR clients for full documents and fragments", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "html-bundle-transform-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "src"), { recursive: true });
  const fullFile = path.join(cwd, "src", "index.html");
  const fragmentFile = path.join(cwd, "src", "fragment.html");
  await writeFile(
    fullFile,
    '<!DOCTYPE html><html><head><base href="/"></head><body><main>Hi</main></body></html>',
  );
  await writeFile(fragmentFile, "<main>Hi</main><section>There</section>");

  const transformer = new HTMLTransformer({
    src: path.join(cwd, "src"),
    build: path.join(cwd, "build"),
    hmr: true,
  });
  const full = await transformer.prepare(fullFile);
  const fragment = await transformer.prepare(fragmentFile);
  const fullHTML = full.serialize();
  const fragmentHTML = fragment.serialize();

  assert.ok(
    fullHTML.indexOf('<base href="/">') < fullHTML.indexOf("data-hmr-client"),
  );
  assert.match(fullHTML, /new EventSource\("\/hmr"\)/);
  assert.match(fragmentHTML, /<main data-hmr="[^"]+">Hi<\/main>/);
  assert.match(fragmentHTML, /<section data-hmr="[^"]+">There<\/section>/);
  assert.doesNotMatch(fragmentHTML, /<\/?(?:html|head|body)(?:\s|>)/i);
  assert.equal(
    fragmentHTML.match(/data-hmr="([^"]+)"/)[1],
    fragmentHTML.match(/data-hmr="([^"]+)"/g)[1].match(/"([^"]+)"/)[1],
  );
});
