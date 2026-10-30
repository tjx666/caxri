---
name: react
description: Author and refactor React code in the Caxri Renderer against the repository's component-composition, hook-extraction, shared-layer, data-flow, and testability contracts. Use whenever writing or reviewing a `.tsx` component, extracting logic into a hook or utility, adding client or server state, debouncing or formatting values in the UI, or when the user asks about React 规范, 组件拆分, hooks 抽取, or component file organization. Do not use for file placement or naming (source-layout), visual and interaction behavior (DESIGN.md), or IPC/process boundaries (project-architecture).
---

# React authoring

How React code inside the Renderer is composed, not where it lives. `source-layout` owns paths and
names; `DESIGN.md` owns visual and interaction behavior; `project-architecture` owns IPC meaning.
This skill owns the shape of components, hooks, state, and their tests.

## 1. Compose files, don't grow them

A `.tsx` file holds at most three components. When a file wants a fourth, split by role before the
`max-lines` gate ever matters; 800 physical lines is a hard stop, not a target:

| Role                                                  | Split target                                        |
| ----------------------------------------------------- | --------------------------------------------------- |
| Stateless presentation primitives shared by a feature | One file named after its primary exported component |
| A component that owns data fetching or a mutation     | Its own `.tsx` file                                 |
| Two components that mirror each other's structure     | One parameterized component or shared hook          |

The three-component budget exists because a large `.tsx` hides duplication: two near-identical
picker or dialog components in one file read as "local detail" and never get unified. Once each
owns a file, the mirrored structure becomes visible and extractable.

## 2. Keep components render-only

A component body is wiring: read hooks, derive a few values, return JSX. When the non-render logic
grows past roughly three cohesive statements (a mutation with invalidation, a derived data merge,
an event workflow), extract it:

- Reused rendering-coupled logic → a `use*` hook in a sibling `.ts` module.
- Pure computation (formatting, sorting, merging, parsing) → plain functions in a sibling `.ts`
  module, imported by the component.
- An async command triggered by the UI → a function in the sibling module that wraps
  `tryCommand(...)` from `stores/toasts` and reports its own errors; the component only calls it.

The reason is testability, not aesthetics: `.tsx` files are not unit-tested in this repository
(section 5), so any branchy logic living inside a component closure is logic with no test path.
JSX-free extraction is what makes a behavior testable.

Inline handlers stay inline only while they are one call deep (`onClick={() => open()}`). A
handler with branching, awaiting, or state sequencing moves out.

## 3. Promote shared helpers instead of copying them

Before writing a small helper or hook (`useDebouncedValue`, relative-time formatting, clamp,
keyboard predicates…), check `es-toolkit`, `@caxri/utils`, and the Renderer for an existing
implementation. This codebase has already paid for per-feature copies of the same debounce hook
and time formatter drifting apart; do not add another.

Before working around a third-party component, inspect its installed public exports and type
declarations. Reuse supported filtering or ranking APIs before assuming they are unavailable or
copying an internal algorithm; verify dynamic query changes in the running UI too.

- A generic pure function comes from `es-toolkit` first. When it lacks one, a browser-safe,
  dependency-free pure function goes to `@caxri/utils` (`packages/utils`) with a test under
  `packages/utils/src/__tests__/` (e.g. `relativeTime`, `formatBytes` live there today).
- A pure helper coupled to Renderer concerns (React, DOM, Tailwind class merging, Monaco) that two
  or more features need → `apps/desktop/src/renderer/src/lib/`, with a colocated `*.test.ts`.
- A hook needed by two or more features → `apps/desktop/src/renderer/src/hooks/` (`@/hooks` is the
  only shared hooks directory).
- On the second use of a feature-local helper, promote it in the same change; moving it later is
  never cheaper, and the second copy is where drift starts.

A helper may stay feature-local while it encodes feature vocabulary (e.g. an editor-status key
builder); genuinely generic code should not.

## 4. State and data flow

- Server state goes through `useCaxriQuery` from `queries/client`; components never call
  `caxri.request` for reads. Query errors that the user must see go through
  `useToastOnQueryError`, not ad-hoc toasts.
- A read resolved into component state dies with the component, so a view that is keyed by Session
  loses everything it loaded when the user switches away and back. Across all of
  `features/**`, `caxri/server-reads-through-query` enforces this for both `caxri.request` and
  `caxri.requestWithSignal`: the RPC belongs in a `queryFn`, a `mutationFn`, a `*-client.ts`
  module, or a `*-commands.ts` module. Those two filenames are the whole exemption; a feature's
  `*-actions.ts` is its UI-action layer and gets no pass, so moving a request there is not a fix.
  A runtime that owns fetching
  itself (opaque handles, provider-driven resets, per-request cancellation) still writes its result
  into the shared cache with `setQueryData`, so the data keeps Session-scoped keys, one
  garbage-collection policy, and one invalidation sweep; see
  `features/view-containers/client.ts`.
- Mutations call `caxri.request` inside a `tryCommand(...)` wrapper so failures surface uniformly.
  Discarded promises use `void` with the repository's explanatory `eslint-disable` comment.
- Query invalidation after a mutation belongs in `queries/invalidation.ts` (or a predicate defined
  beside the query layer), not as a hand-maintained method list inside a component file: a list
  the component owns is a list every future query silently misses.
- Client state lives in zustand stores under `stores/` or a feature-local `*-store`/state module;
  components subscribe with narrow selectors (`useStore((s) => s.slice)`) rather than whole-store
  reads.
- Cross-feature actions go through `executeCommand` from `commands/execute`, never by importing
  another feature's component internals.

## 5. Render purity

Rendering must be a pure function of props, state, and query data. Do not read `Date.now()`,
`Math.random()`, or other ambient values during render: a "5 minutes ago" computed in render
freezes until an unrelated re-render, which reads as a bug. Either drive the value from a hook
that owns its own refresh (an interval-ticked timestamp hook), or document the accepted staleness
where the value is produced.

Hooks that derive objects return stable identities when consumers depend on them (`useMemo`, or
select primitives). A hook that fabricates a fresh object every render forces callers to either
over-render or memoize defensively.

## 6. Tests

- Never unit-test a `.tsx`; rendering and interaction belong to `e2e-testing`.
- Every extracted `.ts` sibling (pure helpers, store logic, mutation workflows with mockable
  boundaries) gets a colocated `*.test.ts`; that coverage is the payoff justifying the
  extraction, so an extraction PR without tests for the moved logic is incomplete.
- Shared `lib/` and `hooks/` modules are test-mandatory: they are about to be depended on by
  features that will not re-test them.

## 7. UI primitives and accessibility

- Build on `components/ui/` primitives (`Tooltip`, `Select`, …) instead of native fallbacks. In
  particular, hover explanations use the shared `Tooltip`, not a bare `title` attribute: the
  native tooltip is inconsistent and easy to miss, and mixing both in one surface breaks the
  DESIGN.md contract that sighted mouse users get the same information assistive tech gets.
- Every interactive element carries an accessible name (`aria-label` or visible text) that matches
  what the tooltip promises.
- Styling stays on DESIGN.md semantic tokens; a component that needs a new color case gets a token
  question, not a literal utility.
- On the second use whose semantic meaning and interaction contract match an existing primitive or
  business component, promote to that shared implementation in the same change. Visual similarity
  alone is not enough: different behavior, ownership, or data lifetime stay separate.

## 8. Finish

After a composition refactor, Call the Skill tool with "source-layout" for the new file names, then
`bun run --silent check <files> --lint --type --test` on the touched set. If the refactor revealed
a convention this skill does not cover, extend this skill in the same change.
