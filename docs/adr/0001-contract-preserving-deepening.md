# Contract-Preserving Architectural Deepening

We will deepen html-bundle around four seams without changing its documented build or HMR behavior: build/rebuild impact policy owns change classification and event decisions; one stateful HTML transformation module owns parsing, inline-script extraction, HMR injection, serialization, and generated-file cleanup; HMR protocol semantics remain wire-compatible while SSE is an adapter; and one DOM patch module owns full-document and fragment outcomes while hydro-js is a renderer adapter. Conservative rebuild-all-pages behavior remains in place until explicit owning-page tracking is justified by evidence. Direct tests cross each deep module's interface, while existing CLI, SSE, and browser tests remain contract coverage.

## Consequences

- Existing CLI flags, emitted files, HMR event names and payloads, reconnect behavior, composed-page preservation, and full-reload fallback remain contracts.
- Build impact decisions can be tested in-process without spawning the CLI.
- HTML transformation, protocol, and DOM patch behavior gain direct test surfaces.
- Production SSE and test transports are concrete adapters at the HMR seam.
