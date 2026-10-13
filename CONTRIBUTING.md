# Contributing to Caxri

Issues and pull requests are open for community use. The repository has one maintainer, so a
submission may not receive a response and there is no review, merge, or release timeline. The
maintainer decides whether a proposal fits the project and whether to merge it.

## Before contributing

1. Search existing Issues and pull requests for the same request.
2. Open an Issue for a material behavior or product change before investing in a large patch.
3. Keep each contribution focused on one outcome.
4. Read [AGENTS.md](AGENTS.md) for repository commands, architecture boundaries, and validation
   requirements.

Security vulnerabilities do not belong in public Issues or pull requests. Follow
[SECURITY.md](SECURITY.md) instead.

## Public information boundary

Treat every contribution, test fixture, log, screenshot, and CI artifact as public. Do not include:

- Credentials, tokens, environment values, or secret-like placeholders.
- Private organizations, repositories, ticket identifiers, hosts, or deployment URLs.
- Real personal names, email addresses, or absolute home paths that are not already public
  authorship metadata.
- Source contents, Terminal output, Agent transcripts, or private project data in diagnostics and
  test artifacts.

Use invented examples such as `owner/project`, `TASK-123`, `example.internal`, and `/Users/me`.
Public upstream dependencies may be named when their public source has been verified.

## Development workflow

Install dependencies with `ni`, then use the repository-owned changed-file check:

```bash
ni
bun run --silent check [files...]
```

Use the narrower validation commands and worktree flow documented in [AGENTS.md](AGENTS.md). New
behavior should include a regression at the narrowest owning surface. Update durable documentation
when a product contract, operator procedure, or architectural decision changes.

## Pull requests

A pull request should:

- Explain the user-visible problem and resulting behavior.
- Link the relevant Issue when one exists.
- List the validation that was actually run and distinguish local checks from CI evidence.
- Include screenshots or recordings when a visible interaction changes.
- Identify copied or adapted third-party code, assets, text, or product references and update the
  applicable notices.
- Avoid unrelated formatting, refactors, dependency changes, or generated files.

The project license and contribution authorization process are still being finalized. Do not add
license grants or contributor agreements to an individual pull request. A contribution will not be
merged until the applicable project contribution terms have been published and accepted.
