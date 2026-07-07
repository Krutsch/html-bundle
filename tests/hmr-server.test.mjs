// Server-side HMR tests: spawn the CLI in --hmr mode against a throwaway
// project, subscribe to the /hmr event stream, edit files, and assert the
// normalised events the client depends on.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const bundlePath = path.join(repoRoot, "dist", "bundle.mjs");
const PORT = 5323;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitForListening(child, ms = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("server did not start in time")),
      ms,
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("Server listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})`));
    });
  });
}

function subscribe(events) {
  // `listen()` logs "Server listening" before the socket is actually bound, so
  // the first connect can be refused — retry until the stream is open.
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryConnect = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/hmr`, (res) => {
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf("\n\n")) !== -1) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 2);
            if (line.startsWith("data:")) {
              try {
                events.push(JSON.parse(line.slice(5).trim()));
              } catch {
                /* ignore keep-alive noise */
              }
            }
          }
        });
        resolve(req);
      });
      req.on("error", (err) => {
        if (++attempts < 40) {
          setTimeout(tryConnect, 100);
        } else {
          reject(err);
        }
      });
    };
    tryConnect();
  });
}

async function until(predicate, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = predicate();
    if (hit) return hit;
    await wait(50);
  }
  return undefined;
}

test("HMR server emits typed events and funnels module edits to owning pages", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "html-bundle-hmr-"));
  t.after(() => rm(cwd, { force: true, recursive: true }));
  await mkdir(path.join(cwd, "src"), { recursive: true });

  await writeFile(
    path.join(cwd, "bundle.config.js"),
    `export default { port: ${PORT}, host: "127.0.0.1", deletePrev: true };\n`,
  );
  await writeFile(
    path.join(cwd, "src", "index.html"),
    `<!DOCTYPE html>
<html>
  <head>
    <title>Fixture</title>
    <link rel="stylesheet" href="./styles.css" />
    <script type="module">
      import { value } from "./mod.js";
      window.value = value;
    </script>
  </head>
  <body><main>Fixture</main></body>
</html>`,
  );
  const modPath = path.join(cwd, "src", "mod.ts");
  const workerCodePath = path.join(cwd, "src", "workerCode.ts");
  const cssPath = path.join(cwd, "src", "styles.css");
  await writeFile(modPath, `export const value: number = 1;\n`);
  await writeFile(
    workerCodePath,
    `globalThis.postMessage?.({ value: 1 });\nexport const value = 1;\n`,
  );
  await writeFile(cssPath, `body { color: red; }\n`);

  const server = spawn(process.execPath, [bundlePath, "--hmr"], { cwd });
  t.after(() => server.kill("SIGKILL"));
  server.stderr.on("data", () => {});

  await waitForListening(server);
  const events = [];
  const req = await subscribe(events);
  t.after(() => req.destroy());
  await wait(300);

  // 1. Module edit funnels into an "html" update for the owning page.
  const beforeModule = events.length;
  await writeFile(modPath, `export const value: number = 2;\n`);
  const moduleEvent = await until(() =>
    events
      .slice(beforeModule)
      .find((e) => e.type === "html" && e.file === "src/index.html"),
  );
  assert.ok(
    moduleEvent,
    "module change should emit an html event for index.html",
  );
  assert.equal(typeof moduleEvent.html, "string");

  // 2. CSS edit emits a css event (client busts stylesheets).
  const beforeCss = events.length;
  await writeFile(cssPath, `body { color: blue; }\n`);
  const cssEvent = await until(() =>
    events.slice(beforeCss).find((e) => e.type === "css"),
  );
  assert.ok(cssEvent, "css change should emit a css event");
  assert.match(cssEvent.file, /styles\.css$/);

  // 3. A module entry with no changed owning page is an HMR dead end, so the
  // client should reload automatically instead of leaving the user stuck.
  const beforeWorker = events.length;
  await writeFile(
    workerCodePath,
    `globalThis.postMessage?.({ value: 2 });\nexport const value = 2;\n`,
  );
  const workerEvent = await until(() =>
    events
      .slice(beforeWorker)
      .find(
        (e) => e.type === "full-reload" && /workerCode\.ts$/.test(e.file || ""),
      ),
  );
  assert.ok(workerEvent, "dead-end module change should emit full-reload");

  // 4. Legacy untyped fields are gone (client dispatches on `type`).
  assert.ok(
    events.every((e) => typeof e.type === "string"),
    "every event carries a type",
  );
});
