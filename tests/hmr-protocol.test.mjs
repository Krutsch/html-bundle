import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeHMRMessage,
  encodeHMRMessage,
  isHMRMessage,
} from "../dist/hmr-protocol.mjs";
import { createMemoryHMRAdapter } from "../dist/hmr-memory.mjs";

test("HMR protocol preserves exact event payloads through JSON", () => {
  const message = {
    type: "html",
    file: "src/index.html",
    html: "<main>new</main>",
    previousHtml: "<main>old</main>",
  };

  assert.deepEqual(decodeHMRMessage(encodeHMRMessage(message)), message);
  assert.equal(isHMRMessage({ type: "css", file: "src/styles.css" }), true);
  assert.equal(isHMRMessage({ type: "html", file: "src/index.html" }), false);
  assert.equal(
    isHMRMessage({ type: "unknown", file: "src/index.html" }),
    false,
  );
});

test("memory HMR adapter provides a test transport", () => {
  const adapter = createMemoryHMRAdapter();
  const received = [];
  const unsubscribe = adapter.subscribe((message) => received.push(message));

  adapter.publish({ type: "full-reload", file: "src/worker.ts" });
  unsubscribe();
  adapter.publish({ type: "asset", file: "src/logo.svg" });

  assert.deepEqual(received, [{ type: "full-reload", file: "src/worker.ts" }]);
});
