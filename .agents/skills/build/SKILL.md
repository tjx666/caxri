---
name: build
description: Build Caxri's Electron Desktop and standalone Server artifact, including native module compatibility checks. Use for production build failures, ABI changes, dependency upgrades, or pre-package validation.
---

# Build Caxri

1. Install dependencies with `ni` when the lockfile or environment requires it.
2. Call the Skill tool with "quality-check" or run `bun run check --lint --test --type` for the
   current changes.
3. Run `bun run spike:native`, `bun run spike:pty`, and the applicable `bun run spike:agents` probe
   after Electron, native-module, Agent adapter, or packaging changes.
4. For complete validation, run the root `bun run typecheck` once; the full unit suite is a CI
   gate (see `quality-check`). Use `build:workspaces` or `typecheck:workspaces`
   only to isolate a failing workspace; the root commands already own that workspace coverage.
5. Run `bun run build` once and verify `apps/server/dist/server`, `out/main`, `out/preload/index.cjs`,
   and `out/renderer` exist. Keep Monaco in a separate lazy `CodeEditor` chunk rather than the
   terminal-first Renderer entry.
6. Run `bun run package` when validating the byte-identical Server artifact embedded in the
   unsigned macOS app.
7. Build and install the standalone CLI globally with `bun run link:cli`; remove that link with
   `bun run unlink:cli`.

Keep Renderer Node-free. Do not replace the CommonJS preload output without revalidating the
sandboxed packaged app. Use the repository `package*` scripts instead of invoking Electron Builder
directly. They write every local package beneath `release.noindex/`, so Spotlight never presents
worktree artifacts as duplicate installed Caxri applications. Keep successful build output compact:
retain full output in a task-scoped log when needed, report the phase and artifact checks, and
surface the complete log only on failure.
