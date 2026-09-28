---
name: open-source-readiness
description: Keep Caxri publishable. Use when writing fixtures, test data, sample paths, docs, or log/artifact plumbing; when a change would embed a real person, employer, private repository, ticket, host, or machine path; when auditing what the repository would expose if it became public; or when preparing the visibility flip itself.
---

# Open Source Readiness

Caxri is private today and will most likely be published. Treat every tracked file, commit message,
issue, and CI artifact as already public, because by the time it is public it is too late to take
any of them back.

That last clause is the whole reason this skill exists. It is not caution — it is a measured
property of GitHub, recorded under [Why prevention is the only lever](#why-prevention-is-the-only-lever).

## The rule

Write nothing into a tracked file that you would have to remove before publishing.

A reference is safe when an anonymous visitor can already reach the same thing. A reference is not
safe merely because it looks harmless, is inside a test, is in a comment, or is written in Chinese.

### Never write

- **A private organization, repository, or project name.** Including in a URL, a Git remote fixture,
  a worktree name, or a branch name.
- **A real ticket identifier**, and especially a ticket URL — the slug in a tracker URL usually
  carries the ticket's title, which is the part outsiders cannot otherwise read.
- **An internal hostname**: preview deployments, staging, dashboards, admin panels, internal
  gateways. Platform preview URLs encode the owning team's slug.
- **An internal file path that implies internal structure**, and never one described as holding
  credentials. Naming a secrets file is a disclosure even when its contents are absent.
- **An absolute path containing a real account name**, whether the developer's or anyone else's.
- **A real person's name, handle, or email**, outside the repository's own authorship metadata.
- **A credential of any kind**, including one that is expired, revoked, or "just a test key".

### Write instead

| Instead of              | Use                                                       |
| ----------------------- | --------------------------------------------------------- |
| A private repository    | `owner/project`, `owner/example`                          |
| A real ticket           | `TASK-123`, and a tracker URL only if the host is generic |
| An internal host        | `example.internal`, `preview.example.com`                 |
| A developer's home path | `/Users/me/...`, or an existing neighbour's placeholder   |
| A real name             | `octocat`, or the role (`the maintainer`, `the reviewer`) |

Keep substitutions **the same byte length** when a test asserts on offsets, column numbers, or
wrapped-line positions. Terminal link and hard-wrap fixtures do assert on those; changing a string's
length there silently moves the assertion instead of failing it.

Naming an upstream that is genuinely public is fine and often necessary — a public npm package, a
public repository, a public product URL, a published CLI's documented commands. **Verify rather than
assume**: check the package on the registry, or fetch the repository and confirm it resolves without
authentication. Over-correcting a public dependency into a fake one makes the code wrong.

## Logs, diagnostics, and CI artifacts

`AGENTS.md` already forbids source, Terminal output, transcripts, credentials, and environment
values in diagnostic output. Two additions belong to publishability specifically:

- **Actions run logs and artifacts become world-readable the moment visibility flips**, for every
  run still retained. A workflow step that uploads a whole directory publishes whatever landed in
  it — Playwright traces, screenshots, videos, and the runner's own absolute paths, which carry the
  account name of a self-hosted runner's host.
- Upload the **narrowest path that proves the failure**, not the enclosing directory, and set a
  retention window rather than relying on the default.

## Before writing a new fixture

1. Prefer inventing data over copying something real. A fixture that was never real cannot leak.
2. If you must model something real, model its _shape_ and rename every identifying part.
3. Re-read the diff before committing and ask what an outsider learns from it that they could not
   learn from the public internet.

## Verification

Credential scanning is automatic, not a manual step: `bun run gitleaks` (`scripts/gitleaks-scan.ts`,
config `.gitleaks.toml`) runs in the pre-commit hook against the staged diff, in CI against the
commits a push or pull request actually introduced, and in the full CI platform-check manifest
against the entire history. It fails closed with `--redact`, so a real finding never leaks the
secret itself in the failure output. Expect false positives from keyboard-shortcut strings
(`cmd+shift+enter`) and placeholder UUIDs to already be allowlisted in `.gitleaks.toml`, narrowly
scoped by both path and regex; extend that file the same way for a newly verified false positive,
never with a blanket allowlist. See the quality-check skill's Guardrails section for the CI wiring.

The remaining checks below actually found things beyond what gitleaks' own rule set covers; each one
is worth running before a large or fixture-heavy change lands.

```bash
# Home paths. Several neutral placeholders are already in use (`/Users/me`, `/Users/test`,
# `/Users/private`); what this looks for is a real account name among them.
rg -nP '/Users/(?!me\b)[a-z0-9._-]+' --glob '!node_modules'

# Ticket-shaped identifiers. The exclusions are the acronyms that collide with the shape
# (`SHA-256`, `UTF-8`); extend the list rather than loosening the pattern.
rg -nP '\b(?!SHA|UTF|ISO|RFC|AES|RGB|UTC|ARM|X86|CJK)[A-Z]{3,}-[0-9]{3,}\b' --glob '!node_modules'

# Preview and internal deployment hosts. Anchored on the scheme, because a bare `.local`
# matches ordinary property access such as `specifier.local.name`.
rg -n '://[a-z0-9.-]+\.(vercel\.app|internal)\b' --glob '!node_modules'
```

Each of these reports matches on a clean tree; read them, do not expect silence. Judge each hit by
whether an outsider learns something, not by whether the pattern fired.

To audit history rather than the working tree, pickaxe the term and read the surrounding diff — the
identifier alone rarely decides anything, and the lines around it usually do:

```bash
git log --all -p -S'<term>' -- . | rg -n -C3 '<term>'
```

## Why prevention is the only lever

Rewriting history does not undo publication, and this is documented rather than folklore. GitHub's
_Removing sensitive data from a repository_ states that after a force-push the old content may still
be reachable through pull requests, cached views, forks, and clones; that `refs/pull/*` is read-only
and cannot be overwritten by `git push --force --mirror`; and that only GitHub Support can
dereference those pull requests and garbage-collect the objects. The same page limits that help:

> GitHub Support won't remove non-sensitive data, and will only assist in the removal of sensitive
> data in cases where we determine that the risk can't be mitigated by rotating affected
> credentials.

So a leaked credential can be rotated and cleaned, while an employer's ticket title or private
repository name generally qualifies as neither — Support will decline, and the content stays.
Issue and pull request bodies are not touched by a history rewrite at all.

The only complete remedy is publishing a fresh repository with a squashed history, which abandons
every issue, pull request, release, and Actions record attached to the old one. Plan on never
needing it.

## Related standing rules

- Repository visibility is not a release. See the standing order in `AGENTS.md`; publishing the
  source does not start a compatibility contract, create users, or invite contributors.
- The live migration checklist and the audit of what current history would expose live under
  `.records/open-source/`, which is gitignored on purpose. **Never copy their contents into a
  tracked file, an issue, or a pull request** — those enumerate exactly the strings that must not
  become public, so reproducing them anywhere tracked performs the leak it documents.
