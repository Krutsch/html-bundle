#!/usr/bin/env node

import type { TextNode } from "parse5";
import type { AcceptedPlugin } from "postcss";
import { performance } from "perf_hooks";
import { readFile, rm, writeFile, readdir, lstat } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import glob from "glob";
import postcss from "postcss";
import esbuild from "esbuild";
import critical from "critical";
import { minify } from "html-minifier-terser";
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
const isSecure = process.argv.includes("--secure") || bundleConfig.secure; // uses CSP for critical too
const handlerFile = process.argv.includes("--handler")
  ? process.argv[process.argv.indexOf("--handler") + 1]
  : bundleConfig.handler;

process.env.NODE_ENV = isHMR ? "development" : "production"; // just in case other tools are using it
let timer = performance.now();
let { plugins, options, file: postcssFile } = await getPostCSSConfig();
let CSSprocessor = postcss(plugins as AcceptedPlugin[]);
let fastify;
const inlineFiles = new Set<string>();
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const INLINE_BUNDLE_FILE = /-bundle-\d+.tsx$/;
const SUPPORTED_FILES = /\.(html|css|jsx?|tsx?)$/;
const execFilePromise = promisify(execFile);

if (bundleConfig.deletePrev) {
  await rm(bundleConfig.build, { force: true, recursive: true });
}

glob(`${bundleConfig.src}/**/*`, build);

async function build(err: any, files: string[], firstRun = true) {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  if (isHMR && firstRun) {
    fastify = await createDefaultServer(isSecure);
    fastify.listen(bundleConfig.port);
    console.log(`💻 Sever listening on port ${bundleConfig.port}.`);
  }

  for (const file of files) {
    await createDir(file);

    if (!SUPPORTED_FILES.test(file)) {
      if (handlerFile) {
        const { stdout } = await execFilePromise("node", [handlerFile, file]);
        if (String(stdout)) console.log("📋 Logging Handler: ", String(stdout));
      } else {
        if ((await lstat(file)).isDirectory()) continue;
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
  await minifyCode();
  for (const file of inlineFiles) {
    if (INLINE_BUNDLE_FILE.test(file)) {
      inlineFiles.delete(file);
      await rm(file);
    }
  }
  for (const file of files) {
    if (file.endsWith(".html")) {
      await minifyHTML(file, getBuildPath(file));
    }
  }

  console.log(
    `🚀 Build finished in ${(performance.now() - timer).toFixed(2)}ms ✨`
  );

  if (isHMR && firstRun) {
    console.log(`⌛ Waiting for file changes ...`);

    if (postcssFile) {
      const postCSSWatcher = watch(postcssFile);
      const tailwindCSSWatcher = watch(
        postcssFile.replace("postcss", "tailwind")
      ); // Assuming that the file ext is the same
      const tsConfigWatcher = watch(
        postcssFile.split("\\").slice(0, -1).join("\\") + "\\tsconfig.json"
      );

      const cssFiles = files.filter((file) => file.endsWith(".css"));
      postCSSWatcher.on(
        "change",
        async () => await rebuildCSS(cssFiles, "postcss")
      );
      tailwindCSSWatcher.on(
        "change",
        async () => await rebuildCSS(cssFiles, "tailwind")
      );
      tsConfigWatcher.on("change", async () => {
        timer = performance.now();
        await build(null, files, false);
      });
    }

    const watcher = watch(bundleConfig.src);
    watcher.on("add", async (file) => {
      file = String.raw`${file}`.replace(/\\/g, "/"); // glob and chokidar diff
      if (files.includes(file) || INLINE_BUNDLE_FILE.test(file)) {
        return;
      }

      await rebuild(file);

      console.log(`⚡ added ${file} to the build`);
    });
    watcher.on("change", async (file) => {
      if (INLINE_BUNDLE_FILE.test(file)) {
        return;
      }
      file = String.raw`${file}`.replace(/\\/g, "/");

      await rebuild(file);

      console.log(`⚡ modified ${file} on the build`);
    });
    watcher.on("unlink", async (file) => {
      if (INLINE_BUNDLE_FILE.test(file)) {
        return;
      }
      file = String.raw`${file}`.replace(/\\/g, "/");

      inlineFiles.delete(file);
      const buildFile = getBuildPath(file)
        .replace(".ts", ".js")
        .replace(".jsx", ".js");
      await rm(buildFile);

      const bfDir = buildFile.split("/").slice(0, -1).join("/");
      const stats = await readdir(bfDir);
      if (!stats.length) await rm(bfDir);

      console.log(`⚡ deleted ${file} from the build`);
    });

    async function rebuild(file: string) {
      // Rebuild all CSS because a change in any file might need to trigger PostCSS zu rebuild(e.g. Tailwind CSS)
      await rebuildCSS(files.filter((file) => file.endsWith(".css")));

      let html;
      if (file.endsWith(".html")) {
        // To refill the inlineFiles needed to build JS
        for (const htmlFile of files.filter((file) => file.endsWith(".html"))) {
          await writeInlineScripts(htmlFile);
        }
        await minifyCode();
        for (const file of inlineFiles) {
          if (INLINE_BUNDLE_FILE.test(file)) {
            inlineFiles.delete(file);
            await rm(file);
          }
        }
        html = await minifyHTML(file, getBuildPath(file));
      } else if (/\.(jsx?|tsx?)$/.test(file)) {
        inlineFiles.add(file);
        await minifyCode();
      } else {
        const { stdout } = await execFilePromise("node", [handlerFile, file]);
        if (String(stdout)) console.log("📋 Logging Handler: ", String(stdout));
      }

      serverSentEvents?.({ file, html });
    }
  }
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
    console.error(err);
  }
}

async function minifyCode(): Promise<unknown> {
  try {
    return await esbuild.build({
      entryPoints: Array.from(inlineFiles),
      charset: "utf8",
      format: "esm",
      incremental: isHMR,
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
    // Stop app from crashing.
  } catch (err: any) {
    if (!isHMR) {
      console.error(err);
    }

    let missingPkg = false;
    if (err?.errors) {
      for (const error of err.errors) {
        if (error.text?.startsWith("Could not resolve")) {
          missingPkg = true;
          const packageNameRegex = /(?<=").*(?=")/;
          const [pkgName] = error.text.match(packageNameRegex);

          await awaitSpawn(process.platform === "win32" ? "npm.cmd" : "npm", [
            "install",
            pkgName,
          ]);

          console.log(`📦 Package ${pkgName} was installed for you`);
        }
      }

      if (missingPkg) {
        missingPkg = false;
        return minifyCode();
      }
    }
  }
}

const htmlFilesCache = new Map();
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

  const scripts = findElements(DOM, (e) => getTagName(e) === "script");
  for (let index = 0; index < scripts.length; index++) {
    const script = scripts[index];
    const scriptTextNode = script.childNodes[0] as TextNode;
    const isReferencedScript = script.attrs.find((a) => a.name === "src");
    const scriptContent = scriptTextNode?.value;
    if (!scriptContent || isReferencedScript) continue;

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
    const isReferencedScript = script.attrs.find((a) => a.name === "src");
    if (!scriptTextNode?.value || isReferencedScript) continue;

    // Use bundled file
    const buildInlineScript = buildFile.replace(".html", `-bundle-${index}.js`);

    const scriptContent = await readFile(buildInlineScript, {
      encoding: "utf-8",
    });
    await rm(buildInlineScript);
    scriptTextNode.value = scriptContent.replace(
      TEMPLATE_LITERAL_MINIFIER,
      " "
    );
  }

  // Minify Inline Style
  const styles = findElements(DOM, (e) => getTagName(e) === "style");
  for (const style of styles) {
    const node = style.childNodes[0] as TextNode;
    const styleContent = node?.value;
    if (!styleContent) continue;

    const { css } = await CSSprocessor.process(styleContent, {
      ...options,
      from: undefined,
    });
    node.value = css;
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

  if (!isCritical) {
    await writeFile(buildFile, fileText);
    return fileText;
  } else {
    const buildFileArr = buildFile.split("/");
    const fileWithBase = buildFileArr.pop();
    const buildDir = buildFileArr.join("/");

    // critical is generating the files on the fs
    try {
      const { html } = await critical.generate({
        base: buildDir,
        html: fileText,
        target: fileWithBase,
        inline: !isSecure,
        extract: true,
        rebase: () => {},
        ...bundleConfig.critical,
      });
      return html;
    } catch (err) {
      console.error(err);
    }
  }
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
