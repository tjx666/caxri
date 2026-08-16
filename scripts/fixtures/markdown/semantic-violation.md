<!--
Negative fixture proving markdownlint owns Markdown semantics. The heading below skips a level
(H1 straight to H3), which trips `MD001/heading-increment`. `scripts/fixtures/markdown` is
excluded from `.markdownlint-cli2.jsonc`'s real `ignores` list, so
`scripts/__tests__/markdown-toolchain-contract.test.ts` lints this file directly instead.
-->

# Fixture document

### Skipped heading level
