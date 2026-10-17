---
name: oss-confidentiality
description: Protect Caxri's public repository, GitHub metadata, CI output, and release contents from confidential or identifying information. Use before writing, committing, reviewing, or publishing code, docs, fixtures, issues, pull requests, logs, artifacts, screenshots, or packages.
---

# OSS Confidentiality

Caxri is an open-source project. Anything written to tracked files, commits, issues, pull requests,
Actions output, or Releases can be read and copied anonymously. This skill owns the content boundary:
what must not enter those public surfaces and how to review content, history, and public artifacts.

The current license is source-available and not OSI-approved. Preserve that distinction in legal or
license claims even when using the project's established open-source terminology.

## Red lines

Never put these in a public Caxri surface:

- Credentials, tokens, cookies, real captured environment values, signed URLs, private keys, secret
  configuration, or secret-like test values, including expired or revoked credentials.
- A real person's private name, handle, email, home path, device name, account identifier, or other
  personal data outside Git authorship metadata.
- A private organization, repository, project, ticket, tracker URL, hostname, deployment, service,
  database, file path, or infrastructure topology.
- Non-public employer, customer, partner, or provider information: pricing, margins, routing,
  enforcement rules, thresholds, incidents, usage, spend, contracts, or operational data.
- Source contents, Terminal input or output, Agent transcripts, prompts, screenshots, traces, logs,
  or diagnostics captured from real private work.
- Code, text, media, fonts, models, or other assets that Caxri is not allowed to redistribute under
  its public license and notices.

## Leak vectors

Code is only one route. Review all of these:

1. Comments, docs, UI copy, errors, examples, and compatibility notes.
2. Tests and fixtures copied from a real repository, machine, account, ticket, or transcript.
3. Branch names, Git remotes, worktree paths, commit messages, issue content, and PR metadata.
4. Actions logs and artifacts, including screenshots, videos, traces, reports, and absolute paths.
5. Release packages, Source Maps, checksums, generated notices, and bundled dependencies.
6. Review comments or audit reports that repeat the sensitive string they are trying to remove.

## Safe public content

These are not confidential by themselves:

- Caxri behavior and architecture already implemented in this repository.
- Generic product, protocol, framework, package, and deployment terminology.
- Public configuration names and documented defaults, plus synthetic configuration fixtures that
  contain no real environment value or secret.
- A public package, repository, issue, specification, or documentation page that resolves without
  authentication and is relevant to the change.
- Synthetic data that cannot identify a real person, employer, customer, repository, or machine.

Public source does not by itself promise support, compatibility, or a self-hosted product surface.
Those remain separate product and release decisions.

## Safe patterns

| Instead of                       | Use                                                        |
| -------------------------------- | ---------------------------------------------------------- |
| A private repository             | `owner/project` or `owner/example`                         |
| A real ticket                    | `TASK-123` without a real private tracker URL              |
| An internal host                 | `example.internal` or `preview.example.com`                |
| A developer's home path          | `/Users/me/...` or an established neighboring placeholder  |
| A real person or account         | `octocat`, `user-1`, or the role                           |
| A real log, transcript, or trace | A minimal synthetic fixture containing only required shape |

Keep replacements the same byte length when tests assert offsets, columns, or wrapping. Verify a
claimed public upstream anonymously before naming it. If a public explanation only makes sense with
private context, describe the generic mechanism and keep the private motivation outside Caxri.

## Required review

Before a public write or mutation:

1. Read every changed or staged hunk as an anonymous visitor and ask what new private fact it
   reveals.
2. Review the proposed branch, commit, issue, and PR title/body/comment text, not only source files.
3. Inspect the exact artifact or package file list and sanitized metadata. Do not publish a parent
   directory merely because one safe report lives inside it.
4. Run `bun run gitleaks -- --staged` for staged repository changes. For committed changes, reuse a
   successful exact-head CI range scan or explicitly provide the base and head revisions to
   `scripts/gitleaks-scan.ts`; reserve a plain `bun run gitleaks` for an intentional full-history
   scan. For broad or fixture-heavy audits, also inspect identifying home paths, private ticket
   identifiers, and internal or preview hosts; credential scanning does not cover every private fact.
   Inspect surrounding diffs when tracing a finding through Git history.
5. Replace, omit, or move every red-line item before the write. Never quote a secret or private
   identifier in the remediation record.

When confidentiality is genuinely ambiguous, treat the content as confidential. Publishing later
is reversible; unpublishing from clones, caches, pull refs, artifacts, or downloads is not.

## PR and issue screenshots and logs

Prioritize screenshots and logs in PR and issue bodies, comments, and review comments, including
embedded images, attachments, and linked evidence. Reading the surrounding prose is not enough.

- Open and visually inspect every screenshot for private repository names, paths, accounts, hosts,
  source, Terminal output, and Agent conversations, including background windows and sidebars.
- Read pasted logs and linked or attached log files for the same red lines, including credentials
  and environment values. Inspect the actual content, not only the filename or link label.
- Gitleaks does not replace visual inspection. If an attachment cannot be accessed or read, record
  it as unverified and do not describe the review as complete or publish it as reviewed evidence.
- Prefer synthetic reproductions. Inspect the final sanitized image or log before publishing it,
  and describe findings without repeating the private content.

## Public artifacts and history

Upload the narrowest file set that proves the result, not an enclosing directory. Set an explicit
Actions artifact retention window. Review retained Actions logs and artifacts when auditing public
exposure; screenshots, traces, videos, and runner paths can disclose private information.

History rewrites do not retract copies in clones, forks, cached views, or pull-request refs, and do
not edit issue or PR content. Review before publication rather than relying on later deletion.
