---
name: build
description: Build Caxri's Electron Main, CommonJS sandboxed Preload, Renderer, and utility-process Runtime, including native module compatibility checks. Use for production build failures, ABI changes, dependency upgrades, or pre-package validation.
---

# Build Caxri

1. Install dependencies with `ni` when the lockfile or environment requires it.
2. Run `bun run lint`, `bun run typecheck`, and `bun run test`.
3. Run `bun run spike:native` and `bun run spike:pty` after Electron, `node-pty`, SQLite, or packaging changes.
4. Run `bun run build` and verify `out/main`, `out/preload/index.cjs`, and `out/renderer` exist. Keep Monaco in a separate lazy `CodeEditor` chunk rather than the terminal-first Renderer entry.
5. Run `bun run package` when validating native modules inside the unsigned macOS app.

Keep Renderer Node-free and do not replace the CommonJS preload output without revalidating the sandboxed packaged app.
