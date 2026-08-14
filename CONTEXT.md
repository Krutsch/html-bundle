# html-bundle Context

Vocabulary for the HTML bundling and browser HMR context.

## Bundling

**HTML page**:
A complete HTML document or source HTML file emitted as a build output.
_Avoid_: screen, view

**HTML fragment**:
An HTML source file containing markup without a complete document structure, rendered into a composed page region.
_Avoid_: partial page, snippet

**Inline script**:
Executable JavaScript or TypeScript written inside an HTML `script` element and bundled with its owning HTML page.
_Avoid_: embedded code, inline module

**Build**:
The process that reads source HTML and related files and emits HTML, CSS, JavaScript, and copied assets into the configured output directory.
_Avoid_: compile, deployment

## Browser Updates

**HMR update**:
A development-time change delivered to a running browser so affected HTML, CSS, JavaScript, or assets update without an unnecessary full page reload.
_Avoid_: hotfix, live update

**Composed page**:
A browser document that contains one or more mounted HTML fragments and preserves those mounted regions across parent HMR updates.
_Avoid_: nested page, shell

**Owning page**:
The HTML page whose emitted output changes when a source module or data file changes.
_Avoid_: parent page, dependent view

**HTML transformation**:
The build operation that parses source HTML, bundles its inline scripts, applies HMR wiring when enabled, and emits HTML output.
_Avoid_: HTML compilation, template rendering

**DOM patch**:
An HMR update operation that changes live document or fragment markup while preserving unrelated browser state.
_Avoid_: DOM replacement, page refresh

**HMR protocol**:
The event vocabulary and payload rules used to deliver HMR updates from the build process to the browser.
_Avoid_: socket API, message bus
