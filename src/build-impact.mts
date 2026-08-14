export type ChangeKind = "html" | "module" | "json" | "css" | "asset";

export type HTMLScope = "changed" | "all" | "none";

export type BuildImpact = {
  kind: ChangeKind;
  rebuildCSS: boolean;
  rebuildInlineScripts: boolean;
  htmlScope: HTMLScope;
  copySource: boolean;
  event: "html" | "css" | "asset";
};

export type HTMLUpdate = {
  type: "html";
  file: string;
  html: string;
  previousHtml?: string;
};

export type FullReload = {
  type: "full-reload";
  file: string;
};

export function classifyChange(file: string): ChangeKind {
  if (file.endsWith(".html")) return "html";
  if (file.endsWith(".json")) return "json";
  if (/\.(jsx?|tsx?)$/.test(file)) return "module";
  if (file.endsWith(".css")) return "css";
  return "asset";
}

export function getBuildImpact(file: string): BuildImpact {
  const kind = classifyChange(file);

  if (kind === "html") {
    return {
      kind,
      rebuildCSS: true,
      rebuildInlineScripts: true,
      htmlScope: "changed",
      copySource: false,
      event: "html",
    };
  }

  if (kind === "module" || kind === "json") {
    return {
      kind,
      rebuildCSS: true,
      rebuildInlineScripts: true,
      htmlScope: "all",
      copySource: kind === "json",
      event: "html",
    };
  }

  return {
    kind,
    rebuildCSS: true,
    rebuildInlineScripts: false,
    htmlScope: "none",
    copySource: kind === "asset",
    event: kind,
  };
}

export function createHTMLUpdate(
  file: string,
  html: string,
  previousHtml?: string,
): HTMLUpdate {
  return { type: "html", file, html, previousHtml };
}

export function createHTMLRebuildEvents(
  sourceFile: string,
  outputs: readonly { file: string; html: string; previousHtml?: string }[],
): (HTMLUpdate | FullReload)[] {
  const updates = outputs
    .filter(({ html, previousHtml }) => html !== previousHtml)
    .map(({ file, html, previousHtml }) =>
      createHTMLUpdate(file, html, previousHtml),
    );

  return updates.length ? updates : [{ type: "full-reload", file: sourceFile }];
}
