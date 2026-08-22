# Extension Host and view contributions

Caxri loads native ESM extensions in one Host-owned Extension Host process. Extensions contribute
descriptors before activation and provide data through the public `caxri` workspace package; they
never contribute React components or import Desktop internals.

## Process and ownership boundary

The Headless Host discovers manifests, builds the only ViewContainer/View/Command catalog, records
actual grants, starts and supervises `out/main/extension-host.js`, and validates every child
message. The Extension Host loads extension code and owns extension objects, providers, commands,
events, opaque tree handles, and cancellation tokens. Runtime remains the sole owner of SQLite,
Projects, Sessions, PTYs, files, Git, settings, and project status.

An Extension Host crash advances every extension generation and temporarily marks contributed
containers as crashed. Host, Runtime, and PTYs remain alive. The supervisor restarts the child and
reconfigures it from Host-owned descriptors. Old API bindings, providers, commands, refresh timers,
handles, pending API calls, and late tree results cannot cross the generation boundary.

This is a process-ownership and capability boundary, not an untrusted-code sandbox. Trusted Node
extensions can use ordinary filesystem, network, and child-process APIs. Caxri still rejects
extension-owned `electron` imports and never grants the `desktop` principal bypass.

## Public API package

`packages/api` publishes the physical ESM-only package named `caxri`. Its `exports` map provides
`types` and `import` only; CommonJS `require('caxri')` is unsupported. The default export is the
per-extension API object, while named runtime exports include `Disposable`, `EventEmitter`,
`CancellationTokenSource`, `ThemeIcon`, `TreeItem`, and `TreeItemCollapsibleState`.

The ordinary package build contains an explicit outside-host stub. Bundled extension builds
externalize only `caxri`, and the Extension Host's native ESM resolve hook injects a synthetic
generation-scoped module instead. Contract tests reject a bundled copy of the stub and any deep
Desktop, protocol, Runtime, Renderer, or Electron import.

The loader determines ownership from the canonical extension root and the importing module's
`parentURL`. An unowned `caxri` import fails closed. Each `(extensionId, generation)` receives a
distinct opaque API token, entry URL, synthetic module URL, API object, event namespace, and handle
namespace. The synthetic module provides both the default API and stable named runtime exports.

## Manifest

An extension package must declare `type: "module"`, a `.js` or `.mjs` entry, a compatible
`engines.caxri` range, and namespace-qualified contribution IDs:

```json
{
  "name": "publisher.extension",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/extension.js",
  "engines": { "caxri": "^0.0.17" },
  "caxri": { "capabilities": ["projects.read"] },
  "contributes": {
    "viewsContainers": {
      "secondarySidebar": [
        {
          "id": "publisher.extension",
          "title": "Extension",
          "icon": { "kind": "resource", "path": "media/extension.svg" }
        }
      ]
    },
    "views": {
      "publisher.extension": [
        {
          "id": "publisher.extension.overview",
          "name": "Overview",
          "type": "tree"
        }
      ]
    },
    "commands": [{ "command": "publisher.extension.refresh", "title": "Refresh Extension" }]
  }
}
```

Only `secondarySidebar` and `panel` are contribution locations. Container icons explicitly choose
either an allowlisted semantic icon (`{ "kind": "builtin", "id": "status" }`) or an extension
resource (`{ "kind": "resource", "path": "media/extension.svg" }`). Resource icons keep their
authored colors. `onView:<id>` and `onCommand:<id>` activation are derived from contributions, so
manifests must not declare `activationEvents`; conditional `when` clauses are likewise unsupported
until Caxri implements and validates their semantics. Caxri validates manifest and engine
compatibility with standard SemVer rules, canonical entry and icon containment, sizes, namespaces,
and duplicate IDs before running extension code. One malformed package is surfaced as its own
catalog error without hiding healthy siblings. The first discovery root is authoritative, so an
installed extension cannot replace a bundled identity.

Rejected packages receive a stable catalog-safe synthetic identity and an isolated error container.
Retry re-runs discovery, so repairing the manifest or entry on disk replaces that error container
with the extension's declared identity without restarting the Desktop.

Manifest capabilities are declarations, not grants. The Host records actual capability and Project
scope per extension. Bundled extensions receive their reviewed grants; installed extensions
currently receive none. Every API call validates the opaque identity, current generation,
capability, and Runtime-authoritative active Session/Project scope before returning projected data.

## Unified catalog and selection

Builtin Files, Source Control, Logs, and Info and extension contributions share one Host catalog.
Descriptors use `builtin-react` for reviewed native components and `tree` for extension data. The
Renderer dispatches only these declared kinds; extension code cannot inject a component.

The Command Palette and app-level keybindings resolve extension commands through this same Host
catalog. A shortcut reloads a missing, stale, or invalidated catalog before dispatch, executes the
extension command once, and reports unknown or failed commands through the shared toast path. The
native application menu does not synthesize dynamic extension accelerators.

Session SQLite persists the free, bounded
`desiredSecondarySidebarViewContainerId`. Device-local layout persists
`desiredPanelViewContainerId`. The Renderer derives a currently available resolved ID from the
catalog. Missing, disabled, crashed, or downgraded extensions cause a temporary builtin fallback
without rewriting desired state. Restoring the extension rebinds the same desired ID. Only an
explicit user selection updates desired state.

## Tree RPC

Extension element type `T` never leaves the Extension Host. The process boundary carries
generation-scoped opaque handles and validated `TreeItemDTO` values. The shared Renderer owns
virtualization, ThemeIcon rendering, roving focus, arrow/Home/End navigation, expansion, loading and
local retry rows, and ARIA tree semantics.

Tree requests have bounded item count, payload size, handle count, depth, concurrency, and timeout.
Cancellation reaches the provider token. A cancelled or stale request cannot commit handles or
late results. Provider refreshes are coalesced and generation-checked at the Extension Host,
supervisor, service, and Renderer event boundary.

`getParent`, `resolveTreeItem`, `TreeView.reveal`, webviews, custom editors, Marketplace installation,
extension dependencies, signing, automatic updates, and an untrusted extension sandbox are not v1
contracts.

## Bundled extensions and packaging

`extensions/status` is the first product extension and imports only public `caxri` API plus ordinary
dependencies. `extensions/fixture` is test-only and supplies deterministic lazy, cancellation,
failure, timeout, capacity, deep-tree, virtualization, refresh, and crash paths. Each extension is
an independent pnpm workspace package with a package-local TypeScript program and a development-only
`caxri: workspace:*` dependency.

`bun run build:extensions` orchestrates package-local ESM builds with `caxri` externalized. The
production `electron-builder` profile copies only reviewed product manifests, bundles, icons, and
media assets to `Contents/Resources/extensions`; it does not carry Fixture or extension source maps.
`package:e2e` writes a separate test artifact that adds Fixture explicitly. Runtime `testOnly`
filtering remains defense in depth, not the release-artifact boundary. Packaged Host discovery uses
the resource root and starts the Extension Host entry from `app.asar`; installed extensions, when
present, are discovered from `<userData>/extensions` after bundled identities.

Focused validation lives in the API, protocol, discovery, catalog, supervisor, API factory,
persistence, bundle-contract, and Renderer resolution tests. `e2e/extensions.e2e.ts` exercises lazy
tree activation, keyboard/virtualized interaction, provider errors, crash recovery, Terminal
survival, and desired-ID removal/restoration on the real Electron surface.
