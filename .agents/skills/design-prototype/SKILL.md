---
name: design-prototype
description: Produce an interactive single-file HTML design prototype using the REAL Caxri design system (the Renderer's shadcn primitives + theme.css tokens + Tailwind v4 semantic utilities) with production-style React; no build step, opens directly in a browser. Use when asked for a design prototype / interactive mockup / 交互原型 / 出个原型 / 讨论原型设计, or to explore a redesign of a surface before committing to implementation. Also use when the user wants to see or compare a visual or motion effect before adopting it ("得实际看看效果").
---

# Design Prototype

One HTML file, double-click to open, fully interactive, rendered by the **actual design system**:
the Renderer's own `@/components/ui/*` shadcn primitives, the real `theme.css` semantic tokens, and
Tailwind v4 utilities compiled in the browser, while the source stays **production-style React**
(`import { Button } from '@/components/ui/button'`, `className="bg-surface text-muted"`, hooks).
Promotion to production is mostly "split into files", not "rewrite".

Prototype code may be quick-and-dirty (one file, inline data, no IPC), but the **interaction must
be complete**: states, transitions, and affordances are the point of a prototype, not its code
style.

## Showing an effect to the user

When the user wants to judge how something looks or moves before adopting it, hand them a
prototype, not a screen recording: it lets them replay, switch states, and compare variants side by
side. For example, choosing when the composer strip's figures roll took two dev-app recordings with
a temporarily patched fake Agent, while a prototype with "Always roll" and "Roll after quiet" strips
and a phase switch answered it directly. Import the production component when it exists (add it to
`assets/entry.mjs`) so the prototype shows the real behavior. This changes only what the user
reviews: the agent's own acceptance of a Renderer change still uses the CDP checks and recordings
`AGENTS.md` and the `debug` skill require.

## How it works

```text
one-time (~2s, cached):   scripts/build-runtime.ts  →  caxri-prototype-runtime.js (IIFE)
                                                       + caxri-prototype-theme.js (inlined CSS)
                                                       + vendored tailwind-browser.js + babel.min.js
per prototype (no build): single HTML  =  <script runtime + theme> + @tailwindcss/browser
                          + babel-standalone + <script type="text/babel"> production React
```

- The runtime bundles `react`, `react-dom/client`, every `@/components/ui/*` primitive,
  `@/lib/utilities` (`cn`), shared hooks, `lucide-react`, `motion/react`, `cmdk`, and `zustand`
  from this repo's own source and `node_modules`: versions, tokens, and component behavior match
  production by construction.
- `caxri-prototype-theme.js` inlines the real `theme.css` + `styles.css` + `tw-animate-css` into a
  `text/tailwindcss` stylesheet; `@tailwindcss/browser` (pinned to the repo's Tailwind version)
  compiles the prototype's utility classes at runtime, including the `@theme inline` token
  bridge, so `bg-surface` resolves to the live Dracula tokens and `bg-blue-500` fails to compile,
  exactly like production.
- A small `window.require` shim + babel's `transform-modules-commonjs` lets the prototype keep
  real `import` statements, and a registered TSX preset keeps TypeScript syntax working in the
  inline script.

## Quickstart

1. **Build the runtime into the prototype's directory** (any dir works; `/tmp` is fine):

   ```bash
   bun run .agents/skills/design-prototype/scripts/build-runtime.ts /tmp/my-proto
   ```

   Always rerun after design-system or `entry.mjs` changes: rebuilding is ~2s and always safe.
   The two vendored files cache under `assets/` keyed by exact version, so only the first build on
   a machine needs network access.

2. **Copy [`references/template.html`](references/template.html)** into the same dir, rename, and
   replace the sample `App` with the real surface. Keep the runtime shim block untouched.

3. **Open it** (`open /tmp/my-proto/xxx.html`), no server, no build.

## Verify before delivering

Headless-check it renders with zero console errors and that the semantic Tailwind tokens actually
compiled, then capture a screenshot:

```bash
bun run .agents/skills/design-prototype/scripts/verify-prototype.ts /tmp/my-proto/xxx.html
```

The script exits 1 on any page/console error and waits for a `bg-surface` probe to resolve
(Tailwind finished compiling) instead of sleeping.

Then **Read the screenshot**: a prototype is a visual deliverable; don't ship it sight-unseen.
Click through every interactive state (the toggle strip, dialogs, menus) and screenshot the key
ones.

## What's in the runtime (extend freely)

See [`assets/entry.mjs`](assets/entry.mjs): the single source of truth for the importable module
map: every `@/components/ui/*` primitive, `@/components/shortcut-badge`, `@/lib/utilities` (`cn`),
`@/lib/motion`, every `@/hooks/*`, plus `react`, `react-dom(/client)`, `lucide-react`,
`motion/react`, `cmdk`, `zustand`, `class-variance-authority`, `clsx`, and `tailwind-merge`.
`scripts/build-runtime.test.ts` pins the map to the Renderer's actual `ui/` and `hooks/`
directories, so a new primitive fails the suite until it's added here.

Missing a module → the require shim throws with its name; add it to `entry.mjs` and rerun the
build script (~2s). That error is the "extend and rebuild" signal, not a template bug.

## Pitfalls

- **Keep `import React from 'react'` in the prototype** even when unused: babel-standalone's
  react preset uses the classic JSX runtime. (The bundled runtime itself compiles with
  `--jsx=automatic`; that flag is already in the build script.)
- TypeScript syntax works via the template's registered `tsx` preset (`data-presets="react,tsx"`),
  but it is strip-only; nothing type-checks the prototype; annotations are documentation.
- **Keep the `TooltipProvider` wrapper** from the template (production wraps the whole tree in it,
  `app.tsx`). `CommandTooltip`'s shortcut hint resolves to nothing in a prototype: there is no
  keybinding bootstrap; use plain `Tooltip` content instead.
- **Only semantic color utilities compile** (`bg-surface`, `text-muted`, `bg-accent`,
  `border-border`, `text-danger`, `bg-[var(--selection)]`), the default palette is unregistered,
  so `bg-zinc-800` silently produces no CSS. An unstyled-looking element usually means a non-token
  color class.
- The primitives are compositional shadcn style: `Empty` + `EmptyTitle` (+ `EmptyMedia`),
  `Dialog` + `DialogContent`…, not prop bags: check the component source in
  `apps/desktop/src/renderer/src/components/ui/` for the exact API.
- `theme.css` sets `html, body, #root { height: 100%; overflow: hidden }` like the real workbench:
  give your surface its own scroll container, as production does.
- Prototypes have no Electron preload: never touch `window.caxri`; fake data inline.

## Design bar (same as production surfaces)

A prototype is a surface: DESIGN.md applies to what it _demonstrates_:

- Show **at least one non-happy-path state** (empty / loading / error / in-progress), ideally
  behind a state-toggle strip like the template's. A happy-path-only prototype under-specifies the
  design and silently blesses missing states.
- Honor the redlines: type-scale tiers (13/12/11px), the 4px spacing grid, radius 4/6/8, one
  durable `--accent` focus per screen, quiet chrome. Loading is `Spinner`/skeleton; boolean
  preferences are `Switch`, pre-submit opt-ins are `Checkbox`.
- Research precedent first for substantial new surfaces: Call the Skill tool with "competitors"
  (VS Code / GitLens references) before inventing a new interaction pattern.
- Don't paint affordances you don't wire (a hover tint with no click, a kbd hint with no key
  handler): in an _interactive_ prototype a dead affordance is a spec bug.
- Annotate anything deliberately out of scope in an HTML comment so the implementer knows it's a
  cut, not a decision.
