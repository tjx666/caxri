/**
 * Path rules shared by the retry policy and the affected pull-request path: which files are CI infrastructure that a
 * focused run must never trust, which changes an import graph cannot bound, and which E2E specs an affected run
 * selects.
 */

const protectedPathPatterns = [
    /^\.github\/workflows\//,
    /^\.github\/actions\//,
    /^\.bun-version$/,
    /^package\.json$/,
    /^(?:mise\.toml|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
    /^(?:electron\.vite|eslint|knip|playwright|tsconfig|vite|vitest)(?:\.[^/]+)?$/,
    /^scripts\/(?:doctor-changed|native-spike)\.ts$/,
    /^scripts\/(?:ci-bundle-budget|ci-checks-worktree|ci-checks-worktree-setup|ci-child-environment|ci-concurrent-validation|ci-concurrent-validation-report|ci-execution-plan|ci-green-reuse|ci-metrics|ci-path-policy|ci-platform-checks|ci-platform-gates|ci-retry-policy|prepare-public-e2e-receipts|report-e2e-manifest|run-ci-focused-checks|run-ci-parity)\.ts$/,
    /^scripts\/performance-baseline[^/]*\.(?:json|ts)$/,
    // Every `run-e2e-*` runner and everything under `scripts/fixtures/` participates in E2E job
    // steps (census fixture included), so protect them by prefix instead of enumerating each file
    // and re-creating the omission that let census infrastructure bypass full validation.
    /^scripts\/run-e2e-[^/]+\.ts$/,
    /^scripts\/fixtures\//,
    /^scripts\/reporters\//,
    /^e2e\/support\//,
    /^e2e\/editor\.performance\.e2e\.ts$/,
    /^e2e\/failure-isolation\.e2e\.ts$/,
    /^e2e\/mobile-acceptance-scenarios\.e2e\.ts$/,
    /^e2e\/mobile-pairing-desktop-acceptance\.e2e\.ts$/,
    /^e2e\/real-agent-smoke\.e2e\.ts$/,
    /^e2e\/renderer\.performance\.e2e\.ts$/,
    /^e2e\/startup\.performance\.e2e\.ts$/,
    /^\.agents\/skills\/(?:quality-check|switch-worktree)\//,
    /^\.agents\/skills\/e2e-testing\//,
    /^\.agents\/skills\/(?:build|release)\//,
    /^build\//,
    /^RELEASING\.md$/,
];

export function isProtectedRetryPath(path: string): boolean {
    return protectedPathPatterns.some((pattern) => pattern.test(path));
}

/**
 * Paths whose change can plausibly move startup, Renderer interaction, or Server request latency. The performance
 * baseline gate (`scripts/performance-baseline-gate.ts`) only compares against `scripts/performance-baseline.json` when
 * a pull request's changed files intersect this set, so an unrelated change (docs, an extension, a CLI-only fix) never
 * pays for a comparison that cannot regress what the baseline measures. This is deliberately broader than the
 * baseline's current single measured scenario (Renderer `session.switch`): the owning process for each performance E2E
 * spec, kept ready for `startup.performance.e2e.ts` and `editor.performance.e2e.ts` once they gain their own committed
 * baselines.
 */
const performanceRelevantPathPatterns = [
    /^apps\/desktop\/src\/(?:main|preload|renderer)\//,
    /^apps\/server\/src\//,
    /^packages\/client\/src\//,
    /^packages\/protocol\/src\//,
    /^packages\/system\/src\//,
    /^e2e\/(?:editor|renderer|startup)\.performance\.e2e\.ts$/,
    /^scripts\/performance-baseline[^/]*\.(?:json|ts)$/,
];

export function isPerformanceRelevantPath(path: string): boolean {
    return performanceRelevantPathPatterns.some((pattern) => pattern.test(path));
}

export const ordinaryE2ESpecPattern = /^e2e\/[a-z0-9][a-z0-9-]*\.e2e\.ts$/u;

/**
 * Workspace manifests, compiler/test configuration, and dependency patches change how every module resolves or runs,
 * which `vitest related` cannot see through the import graph. Together with the retry-protected infrastructure paths
 * they keep a ready pull request on the full suite.
 */
const fullValidationPathPatterns = [
    /(?:^|\/)package\.json$/u,
    /(?:^|\/)tsconfig[^/]*\.json$/u,
    /(?:^|\/)(?:vite|vitest|electron\.vite|playwright)\.config\.[^/]+$/u,
    /^patches\//u,
];

export function isFullValidationPath(path: string): boolean {
    return (
        isProtectedRetryPath(path) ||
        fullValidationPathPatterns.some((pattern) => pattern.test(path))
    );
}

/**
 * Reads the optional `CI-E2E-Tests: ["e2e/example.e2e.ts"]` line an author adds to the pull-request body to name specs
 * the import graph cannot infer. Throws on a malformed or protected entry so the caller falls back to the full suite.
 */
export function parsePullRequestE2ETests(body: string | undefined): string[] {
    const lines = (body ?? '')
        .split(/\r?\n/u)
        .flatMap((line) => /^CI-E2E-Tests:(.+)$/u.exec(line.trim())?.[1]?.trim() ?? []);
    if (lines.length > 1) throw new Error('duplicate CI-E2E-Tests line in the pull-request body');
    const [raw] = lines;
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    if (
        !Array.isArray(value) ||
        value.some(
            (path) =>
                typeof path !== 'string' ||
                !ordinaryE2ESpecPattern.test(path) ||
                isProtectedRetryPath(path),
        )
    ) {
        throw new Error(
            'CI-E2E-Tests in the pull-request body must be a JSON array of ordinary E2E spec paths',
        );
    }
    return [...new Set(value as string[])];
}

/**
 * Unions declared, changed, and source-importing specs. Protected specs (performance, real Agent, failure isolation)
 * never run on the affected path; changing one already routes the pull request to the full suite. The policy job has no
 * dependency install, so it passes no `related` specs; the E2E job adds them before running.
 */
export function selectAffectedE2ETests(input: {
    changedFiles: readonly string[];
    declared: readonly string[];
    existingSpecs: ReadonlySet<string>;
    related: readonly string[];
}): string[] {
    return [
        ...new Set(
            [...input.declared, ...input.changedFiles, ...input.related].filter(
                (path) =>
                    ordinaryE2ESpecPattern.test(path) &&
                    !isProtectedRetryPath(path) &&
                    input.existingSpecs.has(path),
            ),
        ),
    ].toSorted((left, right) => left.localeCompare(right));
}
