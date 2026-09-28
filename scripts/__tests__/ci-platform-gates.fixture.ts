/**
 * Canonical expected `PLATFORM_NEUTRAL_CI_GATES` id/label snapshot, shared by every test that pins its exact order and
 * membership: `scripts/ci-platform-gates.ts`'s gate list, `.agents/skills/go/scripts/platform-neutral-gates.ts`'s
 * re-export of it, and `platformCheckCommands`'s wrapper around it all assert against this same literal. Kept as a
 * hand-written literal, independent of `ci-platform-gates.ts` itself, so a test failure here still means "the
 * production gate list actually changed" rather than "the fixture updated itself alongside it".
 */
export const EXPECTED_PLATFORM_NEUTRAL_GATE_IDS = [
    'gitleaks',
    'eslint',
    'oxlint-type-aware',
    'markdownlint',
    'docs-check',
    'source-size-ratchet',
    'knip',
    'react-doctor',
    'typescript',
    'format',
    'vitest',
    'bundle-budget',
] as const;

/**
 * Same order as `EXPECTED_PLATFORM_NEUTRAL_GATE_IDS`, in each gate's human-readable `label` form.
 */
export const EXPECTED_PLATFORM_NEUTRAL_GATE_LABELS = [
    'gitleaks',
    'ESLint',
    'oxlint type-aware',
    'markdownlint',
    'documentation check',
    'source-size ratchet',
    'knip',
    'React Doctor',
    'TypeScript',
    'format',
    'unit and integration tests',
    'bundle budget',
] as const;
