import { readFile, rm, writeFile } from "fs/promises";
import type { Node, TextNode } from "@web/parse5-utils";
import { glob } from "glob";
import { sep } from "path";
import { parse, parseFragment, serialize } from "parse5";
import {
  createScript,
  findElement,
  findElements,
  getTagName,
} from "@web/parse5-utils";

const INLINE_BUNDLE_FILE = /-bundle-\d+.tsx$/;
const TEMPLATE_LITERAL_MINIFIER = /\n\s+/g;
const hmrIds = new Map<string, string>();

let hmrClientTemplate = "";
try {
  hmrClientTemplate = await readFile(
    new URL("./hmr-client.js", import.meta.url),
    "utf-8",
  );
} catch {
  // The template is optional outside a compiled package, such as type checks.
}

export type ParsedHTML = ReturnType<typeof parse | typeof parseFragment>;

type InlineScript = {
  index: number;
  node: TextNode;
  sourceFile: string;
};

export type HTMLTransformerOptions = {
  src: string;
  build: string;
  hmr: boolean;
};

export class HTMLFileTransformation {
  readonly file: string;
  readonly DOM: ParsedHTML;
  readonly scripts: readonly InlineScript[];

  constructor(file: string, DOM: ParsedHTML, scripts: InlineScript[]) {
    this.file = file;
    this.DOM = DOM;
    this.scripts = scripts;
  }

  getInlineStyles(): TextNode[] {
    return findElements(this.DOM as Node, (e) => getTagName(e) === "style").map(
      (style) => style.childNodes[0] as TextNode,
    );
  }

  async applyBundledScripts(buildFile: string): Promise<void> {
    for (const { index, node } of this.scripts) {
      const buildInlineScript = buildFile.replace(
        ".html",
        `-bundle-${index}.js`,
      );

      try {
        const scriptContent = await readFile(buildInlineScript, {
          encoding: "utf-8",
        });
        await rm(buildInlineScript);
        node.value = scriptContent.replace(TEMPLATE_LITERAL_MINIFIER, " ");
      } catch {
        // esbuild may not emit a file after a recoverable transformation error.
      }
    }
  }

  serialize(): string {
    return serialize(this.DOM as any);
  }
}

export class HTMLTransformer {
  private readonly files = new Map<string, HTMLFileTransformation>();
  private readonly generatedFilesSet = new Set<string>();
  private readonly removedFilesSet = new Set<string>();

  constructor(private readonly options: HTMLTransformerOptions) {}

  async prepare(file: string): Promise<HTMLFileTransformation> {
    const previous = this.files.get(file);
    let fileText = await readFile(file, { encoding: "utf-8" });
    let DOM = parseHTML(fileText);

    if (this.options.hmr) {
      fileText = addHMRCode(fileText, file, DOM, this.options.src);
      DOM = parseHTML(fileText);
    }

    const scripts = findElements(DOM as Node, (e) => getTagName(e) === "script")
      .map((script, index) => {
        const scriptTextNode = script.childNodes[0] as TextNode;
        const isReferencedScript = script.attrs.find(
          (a: { name: string }) => a.name === "src",
        );
        const type = script.attrs.find(
          (a: { name: string }) => a.name === "type",
        );
        const scriptContent = scriptTextNode?.value;

        if (
          !scriptContent ||
          isReferencedScript ||
          type?.value === "importmap" ||
          type?.value === "application/ld+json"
        ) {
          return undefined;
        }

        const sourceFile = file.replace(".html", `-bundle-${index}.tsx`);
        return { index, node: scriptTextNode, sourceFile };
      })
      .filter((script): script is InlineScript => script !== undefined);

    const currentFiles = new Set(scripts.map(({ sourceFile }) => sourceFile));
    const staleFiles =
      previous?.scripts
        .map(({ sourceFile }) => sourceFile)
        .filter((sourceFile) => !currentFiles.has(sourceFile)) || [];
    await Promise.all(
      staleFiles.map((sourceFile) => this.removeGeneratedFile(sourceFile)),
    );

    await Promise.all(
      scripts.map(({ sourceFile, node }) => {
        this.generatedFilesSet.add(sourceFile);
        return writeFile(sourceFile, node.value);
      }),
    );

    const transformation = new HTMLFileTransformation(file, DOM, scripts);
    this.files.set(file, transformation);
    return transformation;
  }

  get(file: string): HTMLFileTransformation | undefined {
    return this.files.get(file);
  }

  generatedFiles(): string[] {
    return Array.from(this.generatedFilesSet);
  }

  takeRemovedFiles(): string[] {
    const files = Array.from(this.removedFilesSet);
    this.removedFilesSet.clear();
    return files;
  }

  async remove(file: string): Promise<void> {
    const transformation = this.files.get(file);
    if (!transformation) return;

    this.files.delete(file);
    await Promise.all(
      transformation.scripts.map(({ sourceFile }) =>
        this.removeGeneratedFile(sourceFile),
      ),
    );
  }

  async cleanupGeneratedFiles(): Promise<void> {
    const files = this.generatedFiles();
    await Promise.all(files.map((file) => rm(file, { force: true })));
    this.generatedFilesSet.clear();
  }

  async cleanupStaleInlineBundleFiles(): Promise<void> {
    const staleFiles = await glob(`${this.options.src}/**/*-bundle-*.tsx`);
    await Promise.all(
      staleFiles.map((file) => rm(file.replaceAll(sep, "/"), { force: true })),
    );
  }

  private async removeGeneratedFile(sourceFile: string): Promise<void> {
    this.generatedFilesSet.delete(sourceFile);
    this.removedFilesSet.add(sourceFile);

    const buildFile = this.getBuildPath(sourceFile).replace(/\.tsx$/, ".js");
    await Promise.all([
      rm(sourceFile, { force: true }),
      rm(buildFile, { force: true }),
      rm(`${buildFile}.map`, { force: true }),
    ]);
  }

  private getBuildPath(file: string): string {
    return file.replace(`${this.options.src}/`, `${this.options.build}/`);
  }
}

export function addHMRCode(
  html: string,
  file: string,
  ast?: ParsedHTML,
  src = "__HMR_SRC__",
): string {
  if (!hmrIds.has(file)) hmrIds.set(file, randomText());
  const id = hmrIds.get(file)!;
  const script = createScript(
    { type: "module", "data-hmr-client": id },
    buildHMRClient(file, id, src),
  );

  let DOM: ParsedHTML;
  if (html.includes("<!DOCTYPE html>") || html.includes("<html")) {
    DOM = ast || parse(html);
    const headNode = findElement(DOM as Node, (e) => getTagName(e) === "head");
    insertHeadClient(headNode as Node, script);
  } else {
    DOM = ast || parseFragment(html);
    prependChild(DOM as Node, script);
  }

  //@ts-ignore parse5 utility node shape is intentionally structural here.
  DOM.childNodes.forEach((node) =>
    node.attrs?.push({ name: "data-hmr", value: id }),
  );

  return serialize(DOM as any);
}

function parseHTML(html: string): ParsedHTML {
  return html.includes("<!DOCTYPE html>") || html.includes("<html")
    ? parse(html)
    : parseFragment(html);
}

function buildHMRClient(file: string, id: string, src: string): string {
  return hmrClientTemplate
    .replaceAll("__HMR_FILE__", file)
    .replaceAll("__HMR_ID__", id)
    .replaceAll("__HMR_SRC__", src);
}

function prependChild(parent: Node, node: unknown): void {
  (node as { parentNode?: unknown }).parentNode = parent;
  (parent as unknown as { childNodes: unknown[] }).childNodes.unshift(node);
}

function insertHeadClient(parent: Node, node: unknown): void {
  const children = (parent as unknown as { childNodes: Node[] }).childNodes;
  const lastBaseIndex = children.findLastIndex(
    (child) => getTagName(child) === "base",
  );

  (node as { parentNode?: unknown }).parentNode = parent;
  children.splice(lastBaseIndex + 1, 0, node as Node);
}

function randomText(): string {
  return Math.random().toString(32).slice(2);
}
