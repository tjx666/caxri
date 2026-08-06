---
name: competitors
description: Survey competing agent-workbench terminals and the agent CLIs Caxri hosts. Use before designing a feature another product already solved (session persistence, agent-state detection, theming, worktree isolation), when comparing Caxri against a named competitor (Orca, cmux, Muxy, Kero, Termany, Herdr, Mux, Kooky, Warp, Otty, Conductor, Superset, Paseo, T3 Code, Synara, Jean, Omnara, Trevize), or when updating competitive research notes.
---

# Competitors

Load only what the current question needs:

- Read [references/landscape.md](references/landscape.md) for the full product table: repositories, tech stacks, licenses, and one-line positioning.
- Read `references/<product>.md` for per-product research notes: positioning, architecture highlights, standout features, and community sentiment. Each note is dated; treat notes older than a quarter as stale.
- All open-source repositories are shallow-cloned into the git-ignored top-level `competitors/` directory; read the source there instead of fetching from GitHub.
- Run [scripts/sync.sh](scripts/sync.sh) to clone missing repositories, update existing ones, and print each clone's latest commit time. Run it (or at least check `git -C competitors/<name> log -1 --format='%h %ad' --date=short`) before relying on a clone for anything time-sensitive.

## Working rules

- Check the license before copying any code; AGPL-3.0 (Warp, Termany, Mux, Paseo), GPL-3.0 (cmux, Kero), and Elastic License 2.0 (Superset) products are reference-only.
- Closed-source products (Otty, Conductor, Trevize) can only be analyzed via their packaged app (extract `app.asar` for Electron apps) or public materials.
- When research reveals a durable architectural insight, record it in the matching per-product reference in the same change, with the research date. Add a new `references/<product>.md` when a new competitor is added to the landscape table, and add its repository to `scripts/sync.sh`.
