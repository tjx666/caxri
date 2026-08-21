---
name: build
description: Build Caxri's Electron Main, CommonJS sandboxed Preload, Renderer, and utility-process Runtime, including native module compatibility checks. Use for production build failures, ABI changes, dependency upgrades, or pre-package validation.
---

# Build Caxri

1. Install dependencies with `ni` when the lockfile or environment requires it.
2. Call the Skill tool with "quality-check" or run `bun run check --lint --test --type` for the current changes.
3. Run `bun run spike:native`, `bun run spike:pty`, and the applicable `bun run spike:agents` probe
   after Electron, native-module, Agent adapter, or packaging changes.
4. Validate the browser-safe protocol and Node-only CLI workspaces with
   `bun run build:workspaces`, `bun run typecheck:workspaces`, and `bun run test:workspaces`; the root
   `build`, `typecheck`, and `test` commands retain those checks.
5. Run `bun run build` and verify `out/main`, `out/preload/index.cjs`, and `out/renderer` exist. Keep Monaco in a separate lazy `CodeEditor` chunk rather than the terminal-first Renderer entry.
6. Run `bun run package` when validating native modules inside the unsigned macOS app.
7. Build and install the standalone CLI globally with `bun run link:cli`; remove that link with
   `bun run unlink:cli`.

Keep Renderer Node-free and do not replace the CommonJS preload output without revalidating the sandboxed packaged app.
Keep successful build output compact: retain full output in a task-scoped log when needed, report the
phase and artifact checks, and surface the complete log only on failure.
