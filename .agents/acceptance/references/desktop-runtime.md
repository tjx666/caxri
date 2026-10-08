# Desktop Runtime: Caxri Acceptance

Caxri-specific facts about desktop ownership, lifecycle, build freshness, and
focus. The exact commands remain in [`../PROJECT.md`](../PROJECT.md).

## DR1. Acceptance owns an isolated desktop, not the resident app

`start-electron.ts` creates a temporary user-data profile and temporary macOS app
bundle identity for the case. A resident Caxri or Caxri Dev instance may remain
running and usable. Resolve ownership through `.records/acceptance/runtime.json`;
never attach by app name, guess the frontmost window, or stop processes globally.

`stop-electron.ts` is the matching cleanup boundary. It revalidates the recorded
process identities and stops only the owned launcher, window, Server Core, and artifact children.
An identity mismatch is evidence to preserve, not permission to broaden the kill
target.

## DR2. A stale build invalidates desktop evidence

The Acceptance launcher requires built output whose embedded commit matches the
frozen report commit. Rebuild after relevant Main, Preload, Renderer, or Server
changes. A Renderer reload does not update the other Electron processes, and a
plausible screenshot from an older bundle is not evidence for the current head.

## DR3. Readiness is not permission to take focus repeatedly

The readiness receipt means the owned renderer can be addressed through CDP. It
does not grant ongoing control of the developer's desktop. Resolve the entire
interaction and cleanup sequence before launch, avoid `Page.bringToFront` and
`Target.activateTarget` for read-only work, and stop on the first unexpected
native or visible state instead of investigating while the app remains frontmost.
