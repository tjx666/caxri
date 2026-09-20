import process from 'node:process';

/**
 * Fail-closed guard for the two repository-wide test gates.
 *
 * Both `bun run test` and `bun run test:e2e` are remote gates: GitHub Actions runs them on every pushed head, on the
 * self-hosted runner, in parallel with whatever the agent does next. Running either locally spends 3-40 minutes
 * producing a result the same push is about to produce anyway, and blocks the checkout for the whole duration.
 *
 * The cost is invisible from inside the run, which is what makes it recur: a full suite looks like diligence, and an
 * agent that has not loaded `e2e-testing` or `quality-check` never sees the rule forbidding it. So the rule is enforced
 * here, where the command itself refuses, rather than only in prose a session may never read.
 *
 * The escape hatch is deliberately the user's to grant, never the agent's to infer: no heuristic about branch state,
 * offline CI, or "this change is risky" opens it.
 */

const AUTHORIZATION_VARIABLE = 'CAXRI_FULL_SUITE_AUTHORIZED';

export type FullSuiteRunner = 'unit' | 'e2e';

/**
 * Flags and positional filters that already narrow a run to a subset, in which case it is not a full-suite gate.
 * Positional arguments are spec paths or file filters for both runners.
 */
const FOCUS_FLAGS = new Map<FullSuiteRunner, readonly string[]>([
    ['unit', ['--changed', '--related', '--shard', '--testNamePattern', '-t']],
    ['e2e', ['--grep', '--grep-invert', '--last-failed', '--only-changed', '--shard', '-g']],
]);

const GUIDANCE = new Map<FullSuiteRunner, string>([
    [
        'unit',
        'Run the focused checker instead: `bun run check <changed files>` picks the owning suites, or name the test ' +
            'files directly with `rtk vitest run <file>`. The full suite is a repository-wide gate; see the ' +
            '"Repository-wide gates" section of the `quality-check` skill.',
    ],
    [
        'e2e',
        'Run the specs you touched instead: `bun run check <spec> --e2e`, or push an authorized topic branch and let ' +
            'the self-hosted runner carry the full Electron suite. See the "Remote full suite" section of the ' +
            '`e2e-testing` skill.',
    ],
]);

/**
 * `CI` is set by GitHub Actions on every runner, which is exactly where the full gate is supposed to execute.
 */
export function isFullSuiteAuthorized(environment: NodeJS.ProcessEnv = process.env): boolean {
    return Boolean(environment.CI) || Boolean(environment[AUTHORIZATION_VARIABLE]);
}

/**
 * Treats an invocation as full-suite only when nothing narrows it, so a focused run never trips the guard.
 */
export function isFullSuiteInvocation(runner: FullSuiteRunner, argv: readonly string[]): boolean {
    const focusFlags = FOCUS_FLAGS.get(runner) ?? [];
    for (const argument of argv) {
        if (argument === '--') continue;
        if (argument.startsWith('-')) {
            const name = argument.split('=', 1)[0];
            if (focusFlags.includes(name)) return false;
            continue;
        }
        /**
         * A bare subcommand is the runner's own verb (`vitest run`, `playwright test`), not a filter.
         */
        if (argument === 'run' || argument === 'test') continue;
        return false;
    }
    return true;
}

export function fullSuiteRefusalMessage(runner: FullSuiteRunner): string {
    const gate = runner === 'unit' ? 'full unit suite' : 'full Electron E2E suite';
    return [
        `Refusing to run the ${gate} locally — this is a wrong operation, not a slow one.`,
        '',
        `CI runs this exact gate on every pushed head, so a local run duplicates it and blocks this checkout for the`,
        `whole duration.`,
        '',
        GUIDANCE.get(runner),
        '',
        `If the user has explicitly authorized a local full run, re-run with ${AUTHORIZATION_VARIABLE}=1. Never set`,
        `that variable on your own judgement.`,
    ].join('\n');
}

/**
 * Throws when an unauthorized full-suite run is starting. Called from both runners' `globalSetup`, which executes once
 * in the runner's main process, so `process.argv` is the real command line rather than a worker's.
 */
export function assertFullSuiteAuthorized(
    runner: FullSuiteRunner,
    argv: readonly string[] = process.argv.slice(2),
    environment: NodeJS.ProcessEnv = process.env,
): void {
    if (!isFullSuiteInvocation(runner, argv)) return;
    if (isFullSuiteAuthorized(environment)) return;
    throw new Error(fullSuiteRefusalMessage(runner));
}
