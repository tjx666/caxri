---
name: open-source-readiness
description: Audit and control Caxri's public exposure across Git history, GitHub data, Actions retention, Source Maps, packages, Releases, and repository visibility. Use for publication and release boundaries or whole-repository exposure audits; use oss-confidentiality for the content boundary of an individual public write.
---

# Open Source Readiness

Caxri is an open-source project. This skill owns publication mechanics: what Git history, GitHub
data, Actions output, packages, Releases, and repository visibility expose and how to audit them.

That last clause is the whole reason this skill exists. It is not caution; it is a measured
property of GitHub, recorded under [Why prevention is the only lever](#why-prevention-is-the-only-lever).

Before writing or publishing any individual item, Call the Skill tool with "oss-confidentiality".
Its red lines, leak vectors, safe substitutions, and metadata review are authoritative for whether
content may enter a public Caxri surface.

## Logs, diagnostics, and CI artifacts

`AGENTS.md` already forbids source, Terminal output, transcripts, credentials, and environment
values in diagnostic output. Two additions belong to publishability specifically:

- **Actions run logs and artifacts become world-readable the moment visibility flips**, for every
  run still retained. A workflow step that uploads a whole directory publishes whatever landed in
  it: Playwright traces, screenshots, videos, and the runner's own absolute paths, which carry the
  account name of a self-hosted runner's host.
- Upload the **narrowest path that proves the failure**, not the enclosing directory, and set a
  retention window rather than relying on the default.

After destructive Actions cleanup, restore workflow availability explicitly:

1. Read every expected workflow by file name. Deleting retained runs can leave a workflow recorded
   as `deleted` even when its file exists on the default branch; a file-presence check is not enough.
2. Enable required checks, CI, and dispatch-only workflows first, then read each one back as
   `active` and validate the intended non-release path.
3. Keep any `workflow_run` release workflow disabled until that validation completes. Enabling it
   earlier creates a release workflow run when CI completes even when its publish job is skipped.
4. Enable the release workflow last and read it back as `active`. Do not dispatch it as a recovery
   probe.

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

To audit history rather than the working tree, pickaxe the term and read the surrounding diff: the
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
repository name generally qualifies as neither; Support will decline, and the content stays.
Issue and pull request bodies are not touched by a history rewrite at all.

The only complete remedy is publishing a fresh repository with a squashed history, which abandons
every issue, pull request, release, and Actions record attached to the old one. Plan on never
needing it.

## Related standing rules

- Repository visibility is not a compatibility release. See the standing order in `AGENTS.md`;
  publishing the source does not by itself start a compatibility or support contract.
- The live migration checklist and the audit of what current history would expose live under
  `.records/open-source/`, which is gitignored on purpose. **Never copy their contents into a
  tracked file, an issue, or a pull request**: those enumerate exactly the strings that must not
  become public, so reproducing them anywhere tracked performs the leak it documents.
