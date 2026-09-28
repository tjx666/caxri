---
name: write-docs
description: Place, classify, and retire Caxri documentation — CONTEXT.md, docs/adr, docs/*.md living docs, and .agents/skills/*/references contracts. Use when adding or editing a Markdown doc, deciding whether a change needs a docs update, writing or retiring an ADR, closing a plan/spike/research note, or running `scripts/documentation-check.ts`. Do not use for skill-invocation routing (see `.agents/invocation.md`) or for CONTEXT.md's own glossary discipline (see `domain-modeling`).
---

# Write Docs

Most code changes do not need a docs change; agents can read code. Write or touch a doc only when
behavior a future agent cannot recover from source alone changed: a product contract, a process
boundary, an operator procedure, or a decision that would otherwise look arbitrary.

## Doc kinds

Every doc has exactly one kind, and each kind has exactly one responsibility. Do not restate one
kind's content inside another.

| Kind         | Lives at                 | Owns                                                                                                                         |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Glossary     | `CONTEXT.md` (root only) | Product vocabulary only — no implementation, no rationale. Governed by `domain-modeling`; this skill only links to it.       |
| `adr`        | `docs/adr/NNNN-slug.md`  | One decision that is hard to reverse, surprising without context, and a real trade-off. Can be a single paragraph.           |
| `living`     | `docs/**/*.md` (default) | The what/why of **current shipped** behavior, a core module, a protocol, or operator knowledge. Changes as behavior changes. |
| `historical` | `docs/**/*.md`           | A retired plan, spike, or research note kept only because a current doc cites it as evidence.                                |

Agent-facing how-to and contracts (`.agents/skills/*/references/**`) are a separate genre this skill
does not classify: they tell an agent how to work safely inside a boundary, and they **link** to the
owning `docs/*.md` living doc instead of repeating its content. If a reference file and a living doc
say the same thing, delete the restatement from the reference and link the doc instead.

Plans, spikes, and agent scratch notes never live as `kind: living`. When the work they describe
ships, either distill the durable parts into an ADR or a living doc and delete the note, or — if a
current doc still cites it as evidence — reclassify it `kind: historical` in place.

## Frontmatter

Every file under `docs/**/*.md` (including `docs/adr/**`) starts with minimal YAML frontmatter:

```yaml
---
kind: living
status: current
---
```

Only `kind` and `status` are allowed. No `owner`, `date`, or `author` field — those get mechanically
bumped by whoever touches the file next and rot into noise instead of evidence; use `git log` for
provenance. `CONTEXT.md`, `AGENTS.md`, `README.md`, and `.agents/skills/**` do not carry this
frontmatter; it is a `docs/` convention only.

### `kind` (closed enum)

`living` | `adr` | `historical`

### `status` (closed enum)

`current` | `proposed` | `accepted` | `superseded` | `historical`

| Kind         | Valid `status`                                                                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `living`     | `current`. A living doc that stops being accurate gets fixed or reclassified — it does not sit stale.                                                                                   |
| `adr`        | `proposed` (not yet decided) → `accepted` (in force) → `superseded` (a later ADR replaced it). An ADR is never rewritten, only superseded; the old text stays as the historical record. |
| `historical` | `historical` (still cited as evidence by a current doc) or `superseded` (fully replaced; the file is now a short link to its canonical home).                                           |

`scripts/documentation-check.ts` skips backticked-repo-path and relative-link existence checks for
`status: historical` and `status: superseded` files, because their whole point is to describe paths
and decisions from a point in time that may no longer exist. It still checks every other status,
including `accepted` ADRs — an ADR that references a real path should keep that path resolvable or
get superseded.

## ADRs

Use the shared format and three-condition gate in
[domain-modeling's ADR-FORMAT.md](../domain-modeling/ADR-FORMAT.md): hard to reverse, surprising
without context, and the result of a real trade-off. That skill also owns _when_ to write one; this
skill owns the file mechanics once you do:

- Frontmatter carries `kind: adr` and the current `status`. Move any hand-written `- Status:` line
  out of the body and into frontmatter; keep `Date`, `Refs`, `Amended by`, `Supersedes`, and
  `Implementation plan` as body list items — they are provenance, not the closed status field.
- Number sequentially (`0001-`, `0002-`, ...); scan `docs/adr/` for the highest existing number.
- Never rewrite an accepted ADR's decision to match a later change of mind. Write a new ADR and mark
  the old one `status: superseded`, optionally noting `Amended by: ADR NNNN` in its body.

## Naming and placement

- `docs/**/*.md` filenames are kebab-case, no exceptions — `docs/mobile/` matches every other
  `docs/` subtree.
- A new living doc goes beside the module or product surface it explains, not in a catch-all file.
  Prefer extending an existing doc's section over creating a near-duplicate file.
- `docs/README.md` is the index: every file under `docs/**/*.md` appears exactly once, grouped by
  `kind`, one line each with a short description. Add the row in the same change that adds the doc;
  remove it in the same change that deletes or folds the doc away.

## When to update, how to retire

- Ship a product-visible behavior, protocol, or operator-facing change alongside its living doc in
  the same change — do not defer it to a follow-up.
- When two docs (or a doc and a skill reference) say the same thing, pick the doc whose kind owns
  that content as the canonical home and replace the other with a short link. Competitor and
  upstream-dependency research always belongs to the `competitors` skill, never to `docs/`.
- When a plan or spike finishes, either fold its durable conclusion into the living doc it targeted
  and delete it, or mark it `kind: historical` in place if a current doc still cites it as evidence.
  Do not leave an implemented plan sitting as if it were still current.
- Deleting or renaming a doc means fixing every relative link and index row that pointed at it in the
  same change; `scripts/documentation-check.ts` catches what grep misses.

## Validate

Run `bun run scripts/documentation-check.ts` (or `--files <paths...>` for a narrower pass) before committing
a docs change. It validates frontmatter enums, `docs/README.md` index completeness, relative
Markdown link targets and their `#heading` anchors (same-document ones included), backticked
repository paths (`apps/`, `packages/`, `extensions/`, `e2e/`, `scripts/`, `.agents/`, `docs/`,
`build/`, `skills/`, optionally with `:line`), and backticked TypeScript filenames written without
a root (`branch.ts`, `.../branch.ts`), which must still match the end of some repository file. Follow it with `markdownlint-cli2` and `prettier --check` on the changed files; call the
Skill tool with "quality-check" for the full changed-file gate.
