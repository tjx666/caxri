---
kind: living
status: current
---

# Editor import navigation

Cmd-click an underlined import or run **Open Import Link** with the caret on its specifier.
JavaScript and TypeScript imports, re-exports, dynamic imports and `require` calls share the same
Session-scoped Server resolver. Unresolved names stay plain text; navigation never executes code.

Relative imports try the written file, emitted JavaScript-to-TypeScript alternatives, source
extensions and directory barrels. A real file with the written extension retains priority.

For aliases, the nearest `tsconfig.json` between the importing file and its Project root owns
resolution. JSONC comments and trailing commas are supported. Relative and package-based `extends` chains merge
parent settings before child settings, retaining the declaring directory for relative paths.
`paths` selects an exact key before the wildcard with the longest literal prefix, and tries that
mapping's targets in order. `baseUrl` supplies the mapping base and resolves otherwise unmapped
names. Changing a config or creating a nearer config takes effect on the next resolution. Clicking
an existing link resolves it again, so a previously rendered link cannot navigate to an old alias
target after a config edit.

Every configuration and candidate uses the ordinary Project path authorization. Workspace links
remain valid, including external targets reached through them; the editor retains the workspace
entry path. Direct paths outside the Project are refused. Config lookup never walks above the
Project root. Invalid, inaccessible or circular configurations produce no alias links.

The resolver is deliberately smaller than a TypeScript language service: it does not infer
compiler project references or evaluate executable configuration. Each JSONC read is capped at
256 KiB, inheritance at 16 levels and 128 configuration probes, and file candidates at 4096 per
request. A 64-entry metadata-validated cache avoids reparsing unchanged configs without adding
watchers. The protocol limits each document batch to 128 specifiers.

Bare package imports search `node_modules` from the importing directory up to the Project root.
Package exports respect exact subpaths, wildcard subpaths and explicit exclusions. Type targets
take priority over runtime targets; JavaScript targets also try their declaration-file counterpart.
Packages without exports use `types`, `typings`, `main`, `module`, then an index entry. This is
source navigation, not a complete Node runtime resolver; separate `@types` packages are not inferred.

Dependency documents reached through a `node_modules` entry open read-only, including linked
package stores and their hard-linked files. Only dependency document reads allow these hard links;
ordinary source reads and all mutation restrictions remain unchanged. The editor shows **Read-only**, restores that restriction after reopening, and the
Server rejects saves independently of the UI. Ordinary Project source remains editable.
