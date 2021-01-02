#!/usr/bin/env node

import fs from "fs";
import { performance } from "perf_hooks";
import Event from "events";
import glob from "glob";
import { watch } from "chokidar";
import csso from "csso";
import esbuild from "esbuild";
import { minify } from "html-minifier";

const isLive = process.argv.includes("--live");

// Performance Observer
const taskEmitter = new Event.EventEmitter();
const start = performance.now();
let expectedTasks = 0; // This will be set in globHandler
let finishedTasks = 0;
taskEmitter.on("done", () => {
  finishedTasks++;

  if (finishedTasks === expectedTasks) {
    console.log(
      `🚀 Build finished in ${(performance.now() - start).toFixed(2)}ms ✨`
    );

    // Watch for changes
    if (isLive) {
      console.log(`⌛ Waiting for file changes ...`);

      const watcher = watch(SOURCE_FOLDER);
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
        if (initialAdd <= expectedTasks) return; // Adds all files initially

        const [_, buildPathDir] = getBuildNames(filename);
        fs.mkdir(buildPathDir, { recursive: true }, (err) => {
          if (err) {
            console.error(err);
            process.exit(1);
          }

          rebuild(filename);
          const [buildFilename] = getBuildNames(filename);
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
        fs.rmSync(buildFilename);
        console.log(`⚡ deleted ${buildFilename}`);
        const length = fs.readdirSync(buildPathDir).length;
        if (!length) fs.rmdirSync(buildPathDir);
      });
    }
  }
});

// Remove old dir
fs.rmSync("build", { recursive: true, force: true });

const SOURCE_FOLDER = "src";
const BUILD_FOLDER = "build";
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const IMPORT_STATEMENT = /import[^(](\s|.)*?(from)?['"](\s|.)*?['"]/g;
const DYNAMIC_IMPORT_STATEMENT = /import\((\s|.)*?\)/g;
const IMPORTS = /(?<=import)[^(](\s|.)*?(?=(from|"|'))/;
const IMPORT_PACKAGE = /(?<=['"])(\s|.)*(?=['"])/;
const DESTRUCTURE = /[^,{}]+/g;
const SCRIPT_CONTENT = /<script(\s|.)*?<\/script>/g;
const UNSCRIPT_START = /<script.*?>/;
const UNSCRIPT_END = /<\/script>/;
const STYLE_CONTENT = /<style>(\s|.)*?<\/style>/g;

// Glob all files and transform the code
glob(`${SOURCE_FOLDER}/**/*.html`, {}, createGlobalJS); // Create importable and treeshaked esm files that will be imported in HTML
glob(`${SOURCE_FOLDER}/**/*.html`, {}, globHandler(minifyHTML));
glob(`${SOURCE_FOLDER}/**/*.{ts,js}`, {}, globHandler(minifyTSJS));
glob(`${SOURCE_FOLDER}/**/*.css`, {}, globHandler(minifyCSS));

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
        taskEmitter.emit("done");
      });
    });
  };
}

const HTMLGlobalDependency = new Map();
function createGlobalJS(err: globCB[0], files: globCB[1]) {
  if (err) {
    console.error(err);
    process.exit(1);
  }

  // Create folders
  fs.mkdirSync(`${BUILD_FOLDER}/tmp`, { recursive: true }); // for esbuild
  fs.mkdirSync(`${BUILD_FOLDER}/globals`, { recursive: true });

  // Glob all import statements in order to create one global importable file for each package
  let imports: Array<string> = [];
  files.forEach((filename) => {
    const fileText = fs.readFileSync(filename, { encoding: "utf-8" });
    const importStatements = fileText.match(IMPORT_STATEMENT);
    const dynamicImportStatements = fileText.match(DYNAMIC_IMPORT_STATEMENT);

    importStatements && imports.push(...importStatements);
    dynamicImportStatements &&
      imports.push(
        ...dynamicImportStatements.map((importLine) => {
          const [pkgName] = importLine.match(IMPORT_PACKAGE)!;
          return `import defaultImp from "${pkgName}"`;
        })
      );
  });

  let globalImport = "";
  imports.forEach((importLine) => {
    let [pkg] = importLine.match(IMPORT_PACKAGE)!;
    pkg = pkg.trim();
    if (pkg.startsWith(".")) return; // File will be transformed already

    let [imports] = importLine.match(IMPORTS)!;
    imports = imports.trim();
    let importsDestructured: Array<string> = [];

    if (imports === "") {
      globalImport = "*";
    } else if (imports.startsWith("{")) {
      importsDestructured = imports
        .match(DESTRUCTURE)!
        .map((distinctVarString) => distinctVarString.trim())
        .filter(Boolean);
    } else {
      globalImport = imports;
    }

    if (HTMLGlobalDependency.has(pkg)) {
      const pkgObj = HTMLGlobalDependency.get(pkg);
      importsDestructured.forEach((distinctVarString) =>
        pkgObj.distinctVars.add(distinctVarString)
      );
    } else {
      HTMLGlobalDependency.set(pkg, {
        global: globalImport,
        distinctVars: new Set(importsDestructured),
      });
    }
    globalImport = "";
  });

  // Create TS file
  HTMLGlobalDependency.forEach(({ global, distinctVars }, pkg) => {
    let content = "";

    if (global && global !== "*") {
      content = `import ${global} from "${pkg}";
      export default ${global}`;
    } else {
      const distinctVarsArr = Array.from(distinctVars);

      content = `export ${
        global ? `${global}${distinctVarsArr.length ? "," : ""}` : ""
      } ${
        distinctVarsArr.length ? `{ ${distinctVarsArr.join(",")} }` : ""
      } from "${pkg}";`;
    }

    fs.writeFileSync(`${BUILD_FOLDER}/tmp/${pkg}.ts`, content);
  });

  // Bundle TS files
  esbuild.buildSync({
    entryPoints: Array.from(HTMLGlobalDependency.keys()).map(
      (pkg) => `${BUILD_FOLDER}/tmp/${pkg}.ts`
    ),
    format: "esm",
    bundle: true,
    minify: true,
    outdir: `${BUILD_FOLDER}/globals`,
  });

  fs.rmSync(`${BUILD_FOLDER}/tmp`, { recursive: true, force: true });
}

function minifyTSJS(filename: string, buildFilename: string) {
  esbuild.buildSync({
    entryPoints: [filename],
    format: "esm",
    bundle: true,
    minify: true,
    outfile: buildFilename.replace(".ts", ".js"),
  });
}

function minifyCSS(filename: string, buildFilename: string) {
  const fileText = fs.readFileSync(filename, { encoding: "utf-8" });
  fs.writeFileSync(buildFilename, csso.minify(fileText).css);
}

function minifyHTML(filename: string, buildFilename: string) {
  let fileText = fs.readFileSync(filename, { encoding: "utf-8" });

  // Minify Code
  // Transpile Inline Script (TS)
  const scriptElements = fileText.match(SCRIPT_CONTENT);
  scriptElements?.forEach((scriptElement) => {
    let script = scriptElement
      .replace(UNSCRIPT_START, "")
      .replace(UNSCRIPT_END, "");
    const unmodifiedScript = script;

    const importStatements = script.match(IMPORT_STATEMENT);
    const dynamicImportStatements = script.match(DYNAMIC_IMPORT_STATEMENT);
    const replacer = (importLine: string) => {
      script = script.replace(
        importLine,
        importLine.replace(IMPORT_PACKAGE, (originalPKG) => {
          const pkg = originalPKG.trim();
          return pkg.startsWith(".") ? originalPKG : `./globals/${pkg}.js`;
        })
      );
    };
    importStatements?.forEach(replacer);
    dynamicImportStatements?.forEach(replacer);

    const transpiled = esbuild.transformSync(script, {
      charset: "utf8",
      color: true,
      loader: "ts",
      format: "esm",
      minify: true,
    });

    // Replace script with generated code
    fileText = fileText.replace(
      unmodifiedScript,
      transpiled.code.replace(TEMPLATE_LITERAL_MINIFIER, "")
    );
  });

  // Minify Inline Style
  const styleElements = fileText.match(STYLE_CONTENT);
  styleElements?.forEach((styleElement) => {
    const style = styleElement.replace(/<\/?style>/g, "");
    fileText = fileText.replace(style, csso.minify(style).css);
  });

  // Minify HTML
  fileText = minify(fileText, {
    collapseWhitespace: true,
  });

  fs.writeFileSync(buildFilename, fileText);
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
