#!/usr/bin/env node

import fs from "fs";
import { performance } from "perf_hooks";
import Event from "events";
import glob from "glob";
import { watch } from "chokidar";
import csso from "csso";
import esbuild from "esbuild";
import critical from "critical";
import { minify } from "html-minifier";
import { parse } from "@babel/parser";
import babelTraverse, { Node } from "@babel/traverse";
import babelGenerate from "@babel/generator";

// @ts-ignore
const traverse = babelTraverse.default as typeof babelTraverse;
// @ts-ignore
const generate = babelGenerate.default as typeof babelGenerate;
const isLive = process.argv.includes("--live");
const isCritical = process.argv.includes("--critical");

// Performance Observer and watcher
const taskEmitter = new Event.EventEmitter();
const start = performance.now();
let expectedTasks = 0; // This will be set in globHandler
let finishedTasks = 0;
taskEmitter.on("done", () => {
  finishedTasks++;

  if (finishedTasks === expectedTasks) {
    fs.rmSync(`${BUILD_FOLDER}/tmp`, { recursive: true, force: true });

    console.log(
      `🚀 Build finished in ${(performance.now() - start).toFixed(2)}ms ✨`
    );

    // Watch for changes
    if (isLive) {
      console.log(`⌛ Waiting for file changes ...`);

      const watcher = watch(SOURCE_FOLDER);
      // The add watcher will add all the files initially - do not watch them
      let initialAdd = 0;

      watcher.on("add", (filename) => {
        if (
          filename.endsWith(".html") ||
          filename.endsWith(".css") ||
          filename.endsWith(".js") ||
          filename.endsWith(".ts")
        ) {
          initialAdd++;
        }
        if (initialAdd <= expectedTasks) return;

        const [buildFilename, buildPathDir] = getBuildNames(filename);
        fs.mkdir(buildPathDir, { recursive: true }, (err) => {
          if (err) {
            console.error(err);
            process.exit(1);
          }

          rebuild(filename);
          console.log(`⚡ added ${buildFilename}`);
        });
      });
      watcher.on("change", (filename) => {
        rebuild(filename);
        const [buildFilename] = getBuildNames(filename);
        console.log(`⚡ modified ${buildFilename}`);
      });
      watcher.on("unlink", (filename) => {
        const [buildFilename, buildPathDir] = getBuildNames(filename);
        fs.rm(buildFilename, (err) => {
          if (err) throw err;

          console.log(`⚡ deleted ${buildFilename}`);
          const length = fs.readdirSync(buildPathDir).length;
          if (!length)
            fs.rmdir(buildPathDir, () => {
              if (err) throw err;
            });
        });
      });
    }
  }
});

const SOURCE_FOLDER = "src";
const BUILD_FOLDER = "build";
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const SCRIPT_CONTENT = /(?<=<script)(\s|.)*?(?=<\/script>)/g;
const STYLE_CONTENT = /(?<=<style)(\s|.)*?(?=<\/style>)/g;

// Remove old build dir
fs.rmSync(BUILD_FOLDER, { recursive: true, force: true });

// Glob all files and transform the code
glob(`${SOURCE_FOLDER}/**/*.html`, {}, (err, files) => {
  // Create importable and treeshaked esm files that will be imported in HTML
  createGlobalJS(err, files);

  globHandler(minifyHTML)(err, files);
  glob(`${SOURCE_FOLDER}/**/*.{ts,js}`, {}, globHandler(minifyTSJS));
  glob(`${SOURCE_FOLDER}/**/*.css`, {}, globHandler(minifyCSS));
});

type globCB = Parameters<Parameters<typeof glob>[2]>;
function globHandler(minifyFn: Function) {
  return (err: globCB[0], files: globCB[1]) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }

    expectedTasks += files.length;

    files.forEach((filename) => {
      const buildFilename = filename.replace(
        `${SOURCE_FOLDER}/`,
        `${BUILD_FOLDER}/`
      );
      const buildFilenameArr = buildFilename.split("/");
      buildFilenameArr.pop(); // In order to create the dir
      const buildPathDir = buildFilenameArr.join("/");

      fs.mkdir(buildPathDir, { recursive: true }, (err) => {
        if (err) {
          console.error(err);
          process.exit(1);
        }

        minifyFn(filename, buildFilename);
      });
    });
  };
}

const HTMLCodeDependencies = new Map();
function createGlobalJS(err: globCB[0], files: globCB[1]) {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  // Create folders
  fs.mkdirSync(`${BUILD_FOLDER}/tmp`, { recursive: true }); // for esbuild
  fs.mkdirSync(`${BUILD_FOLDER}/globals`, { recursive: true });

  // Glob all import statements in order to create one global importable file for each package
  files.forEach((filename) => {
    const fileText = fs.readFileSync(filename, { encoding: "utf-8" });

    fileText.match(SCRIPT_CONTENT)?.forEach((script) => {
      let src = script.slice(script.indexOf(">") + 1).trim();
      const ast = parse(src, {
        sourceType: "module",
        plugins: ["typescript", "topLevelAwait"],
      });

      traverse(ast, {
        ImportDeclaration({ node }) {
          const { specifiers, source } = node;
          const pkg = source.value;
          if (pkg.startsWith(".")) return; // File will be transformed already

          if (HTMLCodeDependencies.has(pkg)) {
            HTMLCodeDependencies.get(pkg).push(...specifiers);
          } else {
            HTMLCodeDependencies.set(pkg, specifiers);
          }
        },
        CallExpression({ node }) {
          const { callee } = node;

          if (callee.type !== "Import") return;
          const calleeArgument = node.arguments.find(
            (item) => item.type === "StringLiteral"
          );
          if (!calleeArgument) {
            console.error("Package name should be a string!");
            process.exit(1);
          }

          //@ts-ignore Cannot get the type
          const pkg = calleeArgument.value;

          if (pkg.startsWith(".")) return; // File will be transformed already

          if (HTMLCodeDependencies.has(pkg)) {
            HTMLCodeDependencies.get(pkg).push(pkg);
          } else {
            HTMLCodeDependencies.set(pkg, [pkg]);
          }
        },
      });
    });
  });

  // Create importable TS files
  const importSpecifierSet = new Set();
  HTMLCodeDependencies.forEach((specifiers, pkg) => {
    importSpecifierSet.clear();
    let content = "export ";

    specifiers.forEach((specifier: Node, index: number) => {
      switch (specifier.type) {
        case "ImportNamespaceSpecifier":
          content += `* as ${specifier.local.name}`;
          break;
        case "ImportDefaultSpecifier":
          importSpecifierSet.add("default");
        case "ImportSpecifier":
          // @ts-ignore ...
          const name = specifier.imported?.name || "default";
          const lastSize = importSpecifierSet.size;

          importSpecifierSet.add(name);
          specifier.local && importSpecifierSet.add(specifier.local.name);

          if (lastSize === 0 || (lastSize === 1 && name === "default")) {
            content += "{";
          }

          if (lastSize !== importSpecifierSet.size) {
            content += name;
            if (
              specifier.local &&
              specifier.local.name !== name &&
              name !== "default"
            ) {
              content += ` as ${specifier.local.name}`;
            }

            if (index !== specifiers.length - 1) {
              content += ",";
            }
          }

          if (index === specifiers.length - 1) {
            content += "}";
          }
          break;
        default:
          // TokenType - dynamic import
          content = `export *`;
          break;
      }

      // Last iteration
      if (index === specifiers.length - 1) {
        content += ` from "${pkg}";`;
      }
    });

    if (specifiers.length === 0) {
      content = `import "${pkg}"`;
    }

    const outfileTMP = `${BUILD_FOLDER}/tmp/${pkg}.ts`;
    const outfileGLOBAL = `${BUILD_FOLDER}/globals/${pkg}.js`;
    fs.writeFile(outfileTMP, content, (err) => {
      if (err) throw err;

      // Bundle TS to JS files
      // This has to happen on the fs, because esbuild does not support stdin in combination with module resolution
      esbuild
        .build({
          entryPoints: [outfileTMP],
          format: "esm",
          bundle: true,
          minify: true,
          outfile: outfileGLOBAL,
        })
        .then(() => {
          // Minify whitespace
          fs.readFile(
            outfileGLOBAL.replace(".ts", ".js"),
            { encoding: "utf-8" },
            (err, fileText) => {
              if (err) throw err;

              fs.writeFile(
                outfileGLOBAL.replace(".ts", ".js"),
                fileText.replace(TEMPLATE_LITERAL_MINIFIER, ""),
                (err) => {
                  if (err) throw err;
                }
              );
            }
          );
        });
    });
  });
}

function minifyTSJS(filename: string, buildFilename: string) {
  esbuild
    .build({
      entryPoints: [filename],
      format: "esm",
      bundle: true,
      minify: true,
      outfile: buildFilename.replace(".ts", ".js"),
    })
    .then(() => {
      taskEmitter.emit("done");
    });
}

function minifyCSS(filename: string, buildFilename: string) {
  fs.readFile(filename, { encoding: "utf-8" }, (err, fileText) => {
    if (err) throw err;

    fs.writeFile(buildFilename, csso.minify(fileText).css, (err) => {
      if (err) throw err;

      taskEmitter.emit("done");
    });
  });
}

function minifyHTML(filename: string, buildFilename: string) {
  fs.readFile(filename, { encoding: "utf-8" }, (err, fileText) => {
    if (err) throw err;

    // Minify Code
    // Transpile Inline Script (TS)
    fileText.match(SCRIPT_CONTENT)?.forEach((script) => {
      const source = script.slice(script.indexOf(">") + 1).trim();
      let src = source;

      const ast = parse(src, {
        sourceType: "module",
        plugins: ["typescript", "topLevelAwait"],
      });
      traverse(ast, {
        ImportDeclaration({ node }) {
          const { source } = node;
          const pkg = source.value;
          if (!pkg.startsWith(".")) {
            source.value = `./globals/${pkg}.js`;
          }
        },
        CallExpression({ node }) {
          const { callee } = node;
          if (callee.type !== "Import") return;

          const calleeArgument = node.arguments.find(
            (item) => item.type === "StringLiteral"
          ) as { value: string };
          const pkg = calleeArgument.value;
          if (!pkg.startsWith(".")) {
            calleeArgument.value = `./globals/${pkg}.js`;
          }
        },
      });
      src = generate(ast).code;

      const transpiled = esbuild.transformSync(src, {
        charset: "utf8",
        color: true,
        loader: "ts",
        format: "esm",
        minify: true,
      });

      // Replace src with generated code
      fileText = fileText.replace(
        source,
        transpiled.code.replace(TEMPLATE_LITERAL_MINIFIER, "")
      );
    });

    // Minify Inline Style
    fileText.match(STYLE_CONTENT)?.forEach((styleElement) => {
      const style = styleElement.slice(styleElement.indexOf(">") + 1).trim();
      fileText = fileText.replace(style, csso.minify(style).css);
    });

    // Minify HTML
    fileText = minify(fileText, {
      collapseWhitespace: true,
    });

    if (isCritical && !isLive) {
      const buildFilenameArr = buildFilename.split("/");
      const fileWithBase = buildFilenameArr.pop();
      const buildDir = buildFilenameArr.join("/");

      critical.generate({
        base: buildDir,
        html: fileText,
        target: fileWithBase,
        minify: true,
        inline: true,
        extract: true,
        rebase: () => {},
      });
      taskEmitter.emit("done");
    } else {
      fs.writeFile(buildFilename, fileText, (err) => {
        if (err) throw err;

        taskEmitter.emit("done");
      });
    }
  });
}

function rebuild(filename: string) {
  const [buildFilename] = getBuildNames(filename);

  if (filename.endsWith(".html")) {
    glob(`${SOURCE_FOLDER}/**/*.html`, {}, (err, files) => {
      createGlobalJS(err, files);
      minifyHTML(filename, buildFilename);
    });
  } else if (filename.endsWith(".ts") || filename.endsWith(".js")) {
    minifyTSJS(filename, buildFilename);
  } else if (filename.endsWith(".css")) {
    minifyCSS(filename, buildFilename);
  }
}

function getBuildNames(filename: string) {
  const buildFilename = filename.replace(
    `${SOURCE_FOLDER}\\`,
    `${BUILD_FOLDER}\\`
  );
  const buildFilenameArr = buildFilename.split("\\");
  buildFilenameArr.pop();
  const buildPathDir = buildFilenameArr.join("\\");
  return [buildFilename, buildPathDir];
}
