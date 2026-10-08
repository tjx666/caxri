---
name: competitors
description: >-
  Survey competing agent-workbench terminals, the agent CLIs Caxri hosts, and the editor-grade
  reference implementations (VS Code, GitLens). Use before designing a feature another product
  already solved (session persistence, agent-state detection, theming, worktree isolation), when
  implementing an editor-adjacent surface that should follow VS Code precedent (Git/source control
  UX, extensions/plugins, keybindings, themes, settings, command palette) or GitLens precedent
  (blame, history, richer Git UX), when working on the Status panel (reference: vscode-fe-helper's
  sidebar), when comparing Caxri against a named competitor (Orca, cmux, Muxy, Kero, Termany, Herdr,
  Mux, Kooky, Warp, Otty, Conductor, Superset, Paseo, T3 Code, Synara, Jean, Omnara, Trevize), or when
  updating competitive research notes.
---

# Competitors

Load only what the current question needs:

- Read [references/landscape.md](references/landscape.md) for the full product table: repositories,
  tech stacks, licenses, and one-line positioning.
- Read `references/<product>.md` for per-product research notes: positioning, architecture
  highlights, standout features, and community sentiment. Each note is dated; treat notes older
  than a quarter as stale.
- All open-source repositories are shallow-cloned into the git-ignored top-level `competitors/`
  directory; read the source there instead of fetching from GitHub.
- Run [scripts/sync.sh](scripts/sync.sh) to clone missing repositories, update existing ones, and
  print each clone's latest commit time. Run it (or at least check
  `git -C competitors/<name> log -1 --format='%h %ad' --date=short`) before relying on a clone for
  anything time-sensitive.

## Reference implementations

Beyond direct competitors, mature editors are the primary UX and implementation references for
editor-adjacent surfaces. Both are shallow-cloned into `competitors/` by `scripts/sync.sh`:

- **VS Code** (`competitors/vscode`, MIT): the default reference for Git/source control views,
  diff and blame UX, the extension/plugin system, keybindings, theming, settings, and the command
  palette. Study its interaction patterns, data shapes, and edge-case handling before inventing a
  new pattern for one of these surfaces.
- **GitLens** (`competitors/gitlens`): the reference for Git UX beyond core VS Code: commit hover
  cards, author avatars, file/line blame annotations, and rich history views. MIT-licensed except
  every directory named `plus` (proprietary `LICENSE.plus`); treat `plus` code as reference-only.
- **vscode-fe-helper** (`competitors/vscode-fe-helper`, MIT, the repository owner's own VS Code
  extension): its `src/sidebar/` tree is the reference for Caxri's Status panel: the aggregated
  project-status sidebar covering Git context, GitHub PR checks, issue-tracker state, deployment
  links, and its polling scheduler.

## Working rules

- When the user names a reference product, inspect its implementation before asking them to choose
  behavior that the reference already defines. Apply the observed interaction within Caxri's
  contracts; ask only when a concrete incompatibility requires a product decision.
- Check the license before copying any code. AGPL-3.0 (Warp, Termany, Mux, Paseo), GPL-3.0 (cmux,
  Kero), and Elastic License 2.0 (Superset) products are reference-only.
- For native Agent contracts, trace the event producer, persistence writer, and consuming reader.
  A declared field or live event does not prove its success semantics or that it reaches disk.
  Ground fixtures in emitted records, and state when the installed binary differs from public source.
- Before recommending a CLI command or modifier, verify it against the installed version or current
  upstream source. Treat commands in older issue discussions as version-specific advice.
- Closed-source products (Otty, Conductor, Trevize) can only be analyzed via their packaged app
  (extract `app.asar` for Electron apps) or public materials.
- When research reveals a durable architectural insight, record it in the matching per-product
  reference in the same change, with the research date. Add a new `references/<product>.md` when a
  new competitor is added to the landscape table, and add its repository to `scripts/sync.sh`.
