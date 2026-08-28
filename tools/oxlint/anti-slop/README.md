# anti-slop (vendored)

The generic Oxlint plugin in this directory is vendored from
[`dmmulroy/anti-slop@6d538555`](https://github.com/dmmulroy/anti-slop/commit/6d538555cb151d4121ed51a27db81890eacf8ae9)
under the MIT License. Caxri owns this copy and may adapt it to repository policy.

Only the generic plugin is vendored. The optional Effect plugin is omitted because Caxri has no
direct Effect dependency. `.oxlintrc.json` owns rule severity; the adoption evidence and deferred
rule rationale live in `docs/type-aware-linting.md`.

When updating, run the upstream installer into a temporary directory, compare `index.ts`, `rules/`,
and `shared/` against this copy, and review semantic changes before replacing files. Keep the exact
upstream revision and license notice current. Update the `oxlint` catalog version and the exact
`@oxlint/plugins` development dependency together.
