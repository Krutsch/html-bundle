#!/usr/bin/env node

import type { Node, TextNode } from "@web/parse5-utils";
import type { AcceptedPlugin } from "postcss";
import type { Router } from "express-serve-static-core";
import { performance } from "perf_hooks";
import { readFile, rm, writeFile, readdir, lstat } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { dirname, join, sep } from "path";
import { availableParallelism } from "os";
import { glob } from "glob";
import postcss from "postcss";
import express from "express";
import esbuild, { type BuildOptions } from "esbuild";
import pLimit from "p-limit";
import Beasties, { type Options } from "beasties";
import { minify, type Options as MinifyOptions } from "html-minifier-terser";
import { watch } from "chokidar";
import { serialize, parse, parseFragment } from "parse5";
import { getTagName, findElements } from "@web/parse5-utils";
import awaitSpawn from "await-spawn";
import {
  fileCopy,
  createDefaultServer,
  getPostCSSConfig,
  getBuildPath,
  createDir,
  bundleConfig,
  serverSentEvents,
  addHMRCode,
} from "./utils.mjs";

const isHMR = process.argv.includes("--hmr") || bundleConfig.hmr;
const isCritical =
  process.argv.includes("--isCritical") || bundleConfig.isCritical;
const beasties = new Beasties({
  path: bundleConfig.build,
  logLevel: "silent",
  ...bundleConfig.critical,
});
const isSecure = process.argv.includes("--secure") || bundleConfig.secure; // uses CSP for critical too
const handlerFile = process.argv.includes("--handler")
  ? process.argv[process.argv.indexOf("--handler") + 1]
  : bundleConfig.handler;
const defaultHandlerConcurrency = availableParallelism();
const handlerConcurrency = getHandlerConcurrency();
const limitHandler = pLimit(handlerConcurrency);

process.env.NODE_ENV = isHMR ? "development" : "production"; // just in case other tools are using it
let timer = performance.now();
let { plugins, options, file: postcssFile } = await getPostCSSConfig();
let CSSprocessor = postcss(plugins as AcceptedPlugin[]);
let router: Router | undefined;
const inlineFiles = new Set<string>();
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const INLINE_BUNDLE_FILE = /-bundle-\d+.tsx$/;
const SUPPORTED_FILES = /\.(html|css|jsx?|tsx?)$/;
const CONFIG_EXTENSIONS = ["js", "mjs", "cjs", "ts", "mts", "cts"];
const execFilePromise = promisify(execFile);

if (bundleConfig.deletePrev) {
  await rm(bundleConfig.build, { force: true, recursive: true });
}

async function cleanupStaleInlineBundleFiles() {
  const staleFiles = await glob(`${bundleConfig.src}/**/*-bundle-*.tsx`);

  await Promise.all(
    staleFiles.map((file) => rm(file.replaceAll(sep, "/"), { force: true })),
  );
}

async function bundleInlineCode() {
  try {
    await minifyCode();
  } finally {
    const generatedFiles = Array.from(inlineFiles).filter((file) =>
      INLINE_BUNDLE_FILE.test(file),
    );
    await Promise.all(generatedFiles.map((file) => rm(file, { force: true })));
    generatedFiles.forEach((file) => inlineFiles.delete(file));
  }
}

async function build(files: string[], firstRun = true) {
  const handlerTasks: Promise<void>[] = [];

  for (const file of files) {
    if (INLINE_BUNDLE_FILE.test(file)) {
      continue;
    }

    await createDir(file);

    if (!SUPPORTED_FILES.test(file)) {
      if ((await lstat(file)).isDirectory()) continue;

      if (handlerFile) {
        handlerTasks.push(limitHandler(() => runHandler(file)));
      } else {
        await fileCopy(file);
      }
    } else {
      if (file.endsWith(".html")) {
        await writeInlineScripts(file);
      } else if (file.endsWith(".css")) {
        await minifyCSS(file, getBuildPath(file));
      } else {
        inlineFiles.add(file);
      }
    }
  }
  await bundleInlineCode();
  for (const file of files) {
    if (file.endsWith(".html")) {
      await minifyHTML(file, getBuildPath(file));
    }
  }
  await Promise.all(handlerTasks);

  console.log(
    `🚀 Build finished in ${(performance.now() - timer).toFixed(2)}ms ✨`,
  );

  if (isHMR && firstRun) {
    const [dynamicRouter, server] = await createDefaultServer(isSecure);
    router = dynamicRouter;
    server.listen({ port: bundleConfig.port, host: bundleConfig.host });
    console.log(
      `💻 Server listening on http${isSecure ? "s" : ""}://${
        bundleConfig.host === "::" ? "localhost" : bundleConfig.host
      }:${bundleConfig.port} and is shared in the local network.`,
    );

    console.log(`⌛ Waiting for file changes ...`);

    const chokidarOptions = { awaitWriteFinish: false };
    let rebuildQueue = Promise.resolve();
    const enqueueRebuild = (file: string) => {
      rebuildQueue = rebuildQueue
        .then(() => rebuild(file))
        .catch(console.error);
      return rebuildQueue;
    };
    if (postcssFile) {
      const configDirectory = dirname(postcssFile);
      const postCSSWatcher = watch(postcssFile, chokidarOptions);
      const tailwindCSSWatcher = watch(
        CONFIG_EXTENSIONS.map((extension) =>
          join(configDirectory, `tailwind.config.${extension}`),
        ),
        chokidarOptions,
      );
      const tsConfigWatcher = watch(
        join(configDirectory, "tsconfig.json"),
        chokidarOptions,
      );

      const cssFiles = files.filter((file) => file.endsWith(".css"));
      postCSSWatcher.on(
        "change",
        async () => await rebuildCSS(cssFiles, "postcss"),
      );
      tailwindCSSWatcher.on(
        "change",
        async () => await rebuildCSS(cssFiles, "tailwind"),
      );
      tsConfigWatcher.on("change", async () => {
        timer = performance.now();
        await build(files, false);
      });
    }

    const watcher = watch(bundleConfig.src, chokidarOptions);
    watcher.on("add", async (file) => {
      file = String.raw`${file}`.replace(/\\/g, "/"); // glob and chokidar diff
      if (files.includes(file) || INLINE_BUNDLE_FILE.test(file)) {
        return;
      }

      try {
        files.push(file);
        await enqueueRebuild(file);
      } catch {}

      console.log(`⚡ added ${file} to the build`);
    });
    watcher.on("change", async (file) => {
      if (INLINE_BUNDLE_FILE.test(file)) {
        return;
      }
      file = String.raw`${file}`.replace(/\\/g, "/");

      await enqueueRebuild(file);

      console.log(`⚡ modified ${file} on the build`);
    });
    watcher.on("unlink", async (file) => {
      if (INLINE_BUNDLE_FILE.test(file)) {
        return;
      }
      file = String.raw`${file}`.replace(/\\/g, "/");

      const fileIndex = files.indexOf(file);
      if (fileIndex !== -1) files.splice(fileIndex, 1);
      inlineFiles.delete(file);
      const buildFile = getBuildPath(file).replace(/\.(jsx?|tsx?)$/, ".js");

      try {
        await rm(buildFile);
        const bfDir = buildFile.split("/").slice(0, -1).join("/");
        const stats = await readdir(bfDir);
        if (!stats.length) await rm(bfDir);
      } catch {}

      serverSentEvents?.({ type: "full-reload", file });

      console.log(`⚡ deleted ${file} from the build`);
    });

    async function rebuild(file: string) {
      // Rebuild all CSS because a change in any file might need to trigger PostCSS zu rebuild(e.g. Tailwind CSS)
      await rebuildCSS(files.filter((file) => file.endsWith(".css")));
      const htmlFiles = files.filter((f) => f.endsWith(".html"));

      if (file.endsWith(".html")) {
        const previousHtml = builtHTMLCache.get(file);
        // To refill the inlineFiles needed to build JS
        for (const htmlFile of htmlFiles) {
          await writeInlineScripts(htmlFile);
        }
        await bundleInlineCode();
        const html = await minifyHTML(file, getBuildPath(file));
        serverSentEvents?.({ type: "html", file, html, previousHtml });
      } else if (/\.(jsx?|tsx?)$/.test(file)) {
        // A module change alters the inlined output of whichever page(s) import
        // it. Rebuild every page, then emit only the pages whose HTML actually
        // changed; the client diff re-runs just the scripts that differ, so
        // unrelated pages keep their state.
        inlineFiles.add(file);
        for (const htmlFile of htmlFiles) {
          await writeInlineScripts(htmlFile);
        }
        await bundleInlineCode();
        let didEmit = false;
        for (const htmlFile of htmlFiles) {
          const previousHtml = builtHTMLCache.get(htmlFile);
          const html = await minifyHTML(htmlFile, getBuildPath(htmlFile));
          if (html !== previousHtml) {
            didEmit = true;
            serverSentEvents?.({
              type: "html",
              file: htmlFile,
              html,
              previousHtml,
            });
          }
        }
        if (!didEmit) {
          serverSentEvents?.({ type: "full-reload", file });
        }
      } else if (file.endsWith(".css")) {
        serverSentEvents?.({ type: "css", file });
      } else {
        if (handlerFile) {
          try {
            await limitHandler(() => runHandler(file));
          } catch (err) {
            console.error(err);
          }
        } else {
          await fileCopy(file);
        }
        serverSentEvents?.({ type: "asset", file });
      }
    }
  }
}

function getHandlerConcurrency() {
  const value =
    getArgValue("--handlerConcurrency") ??
    getArgValue("--maxHandlerConcurrency") ??
    bundleConfig.handlerConcurrency ??
    bundleConfig.maxHandlerConcurrency ??
    defaultHandlerConcurrency;
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    return defaultHandlerConcurrency;
  }

  return parsed;
}

function getArgValue(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function getInstallablePackageName(message: string) {
  const specifier = message.match(/"([^"]+)"/)?.[1];
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.includes(":")
  ) {
    return undefined;
  }

  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.length >= 2
      ? parts.slice(0, 2).join("/")
      : undefined
    : parts[0];
}

async function runHandler(file: string) {
  if (!handlerFile) return;

  const { stdout } = await execFilePromise("node", [handlerFile, file]);
  const output = String(stdout).trim();
  if (output) console.log("📋 Logging Handler: ", output);
}

function getErrorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const reason = (error as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  }
  return error instanceof Error ? error.message : String(error);
}

async function minifyCSS(file: string, buildFile: string) {
  try {
    const fileText = await readFile(file, { encoding: "utf-8" });
    const result = await CSSprocessor.process(fileText, {
      ...options,
      from: file,
      to: buildFile,
    });
    await writeFile(buildFile, result.css);
  } catch (err) {
    console.error(getErrorMessage(err));
  }
}

async function minifyCode(): Promise<void> {
  try {
    await esbuild.build({
      entryPoints: Array.from(inlineFiles),
      charset: "utf8",
      format: "esm",
      sourcemap: isHMR,
      splitting: true,
      define: {
        "process.env.NODE_ENV": `"${process.env.NODE_ENV}"`,
      },
      loader: { ".js": "jsx", ".ts": "tsx" },
      bundle: true,
      minify: true,
      outdir: bundleConfig.build,
      outbase: bundleConfig.src,
      ...bundleConfig.esbuild,
    });
  } catch (err: any) {
    let missingPkg = false;
    if (err?.errors) {
      for (const error of err.errors) {
        if (error.location && error.text?.startsWith("Could not resolve")) {
          const pkgName = getInstallablePackageName(error.text);
          if (!pkgName) continue;
          missingPkg = true;

          await awaitSpawn(process.platform === "win32" ? "npm.cmd" : "npm", [
            "install",
            pkgName,
          ]);

          console.log(`📦 Package ${pkgName} was installed for you`);
        }
      }

      if (missingPkg) {
        return minifyCode();
      }
    }

    throw err;
  }
}

const htmlFilesCache = new Map();
const builtHTMLCache = new Map<string, string>();
async function writeInlineScripts(file: string) {
  let fileText = await readFile(file, { encoding: "utf-8" });

  let DOM;
  if (fileText.includes("<!DOCTYPE html>") || fileText.includes("<html")) {
    DOM = parse(fileText);
  } else {
    DOM = parseFragment(fileText);
  }

  if (isHMR) {
    fileText = addHMRCode(fileText, file, DOM);
  }
  htmlFilesCache.set(file, [fileText, DOM]);

  const scripts = findElements(DOM as Node, (e) => getTagName(e) === "script");
  for (let index = 0; index < scripts.length; index++) {
    const script = scripts[index];
    const scriptTextNode = script.childNodes[0] as TextNode;
    const isReferencedScript = script.attrs.find(
      (a: { name: string }) => a.name === "src",
    );
    const type = script.attrs.find((a: { name: string }) => a.name === "type");
    const scriptContent = scriptTextNode?.value;
    if (
      !scriptContent ||
      isReferencedScript ||
      type?.value === "importmap" ||
      type?.value === "application/ld+json"
    )
      continue;

    const jsFile = file.replace(".html", `-bundle-${index}.tsx`);
    inlineFiles.add(jsFile);
    await writeFile(jsFile, scriptContent);
  }
}

async function minifyHTML(file: string, buildFile: string) {
  let fileText, DOM;

  if (htmlFilesCache.has(file)) {
    const cache = htmlFilesCache.get(file);
    fileText = cache[0];
    DOM = cache[1];
  } else {
    fileText = await readFile(file, { encoding: "utf-8" });

    if (fileText.includes("<!DOCTYPE html>") || fileText.includes("<html")) {
      DOM = parse(fileText);
    } else {
      DOM = parseFragment(fileText);
    }
  }

  // Minify Code
  const scripts = findElements(DOM, (e) => getTagName(e) === "script");
  for (let index = 0; index < scripts.length; index++) {
    const script = scripts[index];
    const scriptTextNode = script.childNodes[0] as TextNode;
    const isReferencedScript = script.attrs.find(
      (a: { name: string }) => a.name === "src",
    );
    const type = script.attrs.find((a: { name: string }) => a.name === "type");
    if (
      !scriptTextNode?.value ||
      isReferencedScript ||
      type?.value === "importmap" ||
      type?.value === "application/ld+json"
    )
      continue;

    // Use bundled file
    const buildInlineScript = buildFile.replace(".html", `-bundle-${index}.js`);

    try {
      const scriptContent = await readFile(buildInlineScript, {
        encoding: "utf-8",
      });
      await rm(buildInlineScript);
      scriptTextNode.value = scriptContent.replace(
        TEMPLATE_LITERAL_MINIFIER,
        " ",
      );
    } catch {}
  }

  // Minify Inline Style
  const styles = findElements(DOM, (e) => getTagName(e) === "style");
  for (const style of styles) {
    const node = style.childNodes[0] as TextNode;
    const styleContent = node?.value;
    if (!styleContent) continue;

    try {
      const { css } = await CSSprocessor.process(styleContent, {
        ...options,
        from: undefined,
      });
      node.value = css;
    } catch (err) {
      console.error(getErrorMessage(err));
    }
  }

  fileText = serialize(DOM);

  // Minify HTML
  try {
    fileText = await minify(fileText, {
      collapseWhitespace: true,
      removeComments: true,
      ...bundleConfig["html-minifier-terser"],
    });
  } catch (e) {
    console.error(e);
  }

  if (isCritical) {
    try {
      const isPartical = !fileText.startsWith("<!DOCTYPE html>");
      fileText = await beasties.process(fileText);
      // fix beasties jsdom
      if (isPartical) {
        fileText = fileText.replace(/<\/?(html|head|body)>/g, "");
      }
    } catch (err) {
      console.error(err);
    }
  }

  await writeFile(buildFile, fileText);
  builtHTMLCache.set(file, fileText);
  return fileText;
}

async function rebuildCSS(files: string[], config?: string) {
  const newConfig = await getPostCSSConfig();
  plugins = newConfig.plugins;
  options = newConfig.options;
  CSSprocessor = postcss(plugins as AcceptedPlugin[]);
  for (const file of files) {
    await minifyCSS(file, getBuildPath(file));
  }

  if (config) console.log(`⚡ modified ${config}.config`);
}

try {
  await cleanupStaleInlineBundleFiles();
  const files = await glob(`${bundleConfig.src}/**/*`);
  await build(
    files
      .map((file) => file.replaceAll(sep, "/"))
      .filter((file) => !INLINE_BUNDLE_FILE.test(file)),
  );
} catch (err) {
  console.error(err);
  process.exit(1);
}

export default router;

export type Config = {
  build: string;
  src: string;
  port: number;
  secure: boolean;
  esbuild?: BuildOptions;
  "html-minifier-terser"?: MinifyOptions;
  critical?: Options;
  deletePrev?: boolean;
  isCritical?: boolean;
  hmr?: boolean;
  handler?: string;
  handlerConcurrency?: number;
  maxHandlerConcurrency?: number;
  host?: string;
  key?: Buffer;
  cert?: Buffer;
};
