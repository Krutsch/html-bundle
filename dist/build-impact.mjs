export function classifyChange(file) {
    if (file.endsWith(".html"))
        return "html";
    if (file.endsWith(".json"))
        return "json";
    if (/\.(jsx?|tsx?)$/.test(file))
        return "module";
    if (file.endsWith(".css"))
        return "css";
    return "asset";
}
export function getBuildImpact(file) {
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
export function createHTMLUpdate(file, html, previousHtml) {
    return { type: "html", file, html, previousHtml };
}
export function createHTMLRebuildEvents(sourceFile, outputs) {
    const updates = outputs
        .filter(({ html, previousHtml }) => html !== previousHtml)
        .map(({ file, html, previousHtml }) => createHTMLUpdate(file, html, previousHtml));
    return updates.length ? updates : [{ type: "full-reload", file: sourceFile }];
}
