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
import jscodeshift, {
  ImportDefaultSpecifier,
  ImportNamespaceSpecifier,
  ImportSpecifier,
} from "jscodeshift";

const tscodeshift = jscodeshift.withParser("ts");
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
const DYNAMIC_IMPORT = /(?<=import\([`'"]).*?(?=[`'"])/g;

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
      const ast = tscodeshift(src);

      ast.find(jscodeshift.ImportDeclaration).forEach((path) => {
        const { source, specifiers } = path.value;
        const pkg = source.value as string;
        if (pkg.startsWith(".")) return; // File will be transformed already

        if (HTMLCodeDependencies.has(pkg)) {
          HTMLCodeDependencies.get(pkg).push(...specifiers);
        } else {
          HTMLCodeDependencies.set(pkg, specifiers);
        }
      });

      ast.find(jscodeshift.CallExpression).forEach((path) => {
        const { callee } = path.value;
        if (callee.type !== "Import") return;
        //@ts-ignore
        const dynImportIndex = callee.loc!.tokens.findIndex(
          //@ts-ignore
          (token: any, index: number, arr: typeof callee.loc.tokens) => {
            return (
              token.value === "import" &&
              arr[index + 1].value === "(" &&
              arr[index + 2].type.label === "string"
            );
          }
        );
        if (dynImportIndex > -1) {
          //@ts-ignore
          const pkgToken = callee.loc!.tokens[dynImportIndex + 2];

          if (pkgToken.value.startsWith(".")) return; // File will be transformed already

          if (HTMLCodeDependencies.has(pkgToken.value)) {
            HTMLCodeDependencies.get(pkgToken.value).push(pkgToken);
          } else {
            HTMLCodeDependencies.set(pkgToken.value, [pkgToken]);
          }
        }
      });
    });
  });

  // Create importable TS files
  type SpecifierType =
    | ImportSpecifier
    | ImportNamespaceSpecifier
    | ImportDefaultSpecifier
    | ImportNamespaceSpecifier;
  const importSpecifierSet = new Set();
  HTMLCodeDependencies.forEach((specifiers, pkg) => {
    importSpecifierSet.clear();
    let content = "export ";

    specifiers.forEach((specifier: SpecifierType, index: number) => {
      switch (specifier.type) {
        case "ImportNamespaceSpecifier":
          //@ts-ignore
          content += `* as ${specifier.local.name}`;
          break;
        case "ImportDefaultSpecifier":
          importSpecifierSet.add("default");

        case "ImportSpecifier":
          // @ts-ignore
          const name = specifier.imported?.name || "default";
          const lastSize = importSpecifierSet.size;

          importSpecifierSet.add(name);
          // @ts-ignore
          specifier.local && importSpecifierSet.add(specifier.local.name);

          if (lastSize === 0 || (lastSize === 1 && name === "default")) {
            content += "{";
          }

          if (lastSize !== importSpecifierSet.size) {
            content += name;
            // @ts-ignore
            if (
              specifier.local &&
              specifier.local.name !== name &&
              name !== "default"
            ) {
              //@ts-ignore
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

      src = tscodeshift(src)
        .find(jscodeshift.ImportDeclaration)
        .forEach(moduleToLocal)
        .toSource();

      // Changing it on the AST does not work?
      src = src.replace(
        DYNAMIC_IMPORT,
        (pkgName: string) => `./globals/${pkgName}.js`
      );

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

function moduleToLocal(path: unknown) {
  //@ts-ignore
  const { source } = path.value;
  const pkg = source.value as string;
  if (!pkg.startsWith(".")) {
    source.value = `./globals/${source.value}.js`;
  }
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
