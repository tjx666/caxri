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
 * The escape hatch belongs to the user alone: no heuristic about branch state, offline CI, or "this change is risky",
 * and no verdict from a subagent or another harness, opens it. The user grants it with `CAXRI_FULL_SUITE_AUTHORIZED=1`.
 * A local full run occupies the machine the user is working on, so an agent-issued review receipt was removed: while
 * repairing CI it kept authorizing runs the user never asked for.
 */

const AUTHORIZATION_VARIABLE = 'CAXRI_FULL_SUITE_AUTHORIZED';

export type FullSuiteRunner = 'unit' | 'e2e';

/**
 * Flags and positional filters that already narrow a run to a subset, in which case it is not a full-suite gate.
 * Positional arguments are spec paths or file filters for both runners.
 */
const FOCUS_FLAGS = new Map<FullSuiteRunner, readonly string[]>([
    ['unit', ['--changed', '--project', '--related', '--shard', '--testNamePattern', '-t']],
    [
        'e2e',
        [
            '--grep',
            '--grep-invert',
            '--last-failed',
            '--only-changed',
            '--project',
            '--shard',
            '--ui',
            '-g',
        ],
    ],
]);

/**
 * Flags whose value is a separate argument when it is not written with `=`.
 *
 * Without this the guard reads `vitest run --reporter json` as "there is a positional filter, so the run is narrowed"
 * and waves the full suite through — the exact bypass it exists to prevent. Only flags this repository or its runners
 * realistically pass are listed; an unrecognized flag is assumed boolean, which at worst costs one extra refusal that
 * the `=` form resolves.
 */
const VALUE_FLAGS = new Map<FullSuiteRunner, readonly string[]>([
    [
        'unit',
        [
            '--bail',
            '--config',
            '--coverage.reporter',
            '--dir',
            '--environment',
            '--maxConcurrency',
            '--maxWorkers',
            '--minWorkers',
            '--mode',
            '--outputFile',
            '--pool',
            '--reporter',
            '--retry',
            '--root',
            '-c',
        ],
    ],
    [
        'e2e',
        [
            '--config',
            '--max-failures',
            '--output',
            '--repeat-each',
            '--reporter',
            '--retries',
            '--timeout',
            '--trace',
            '--workers',
            '-c',
            '-j',
            '-x',
        ],
    ],
]);

const GUIDANCE = new Map<FullSuiteRunner, string>([
    [
        'unit',
        'Run the focused checker instead: `bun run check <changed files>` picks the owning suites, name the test ' +
            'files directly with `rtk vitest run <file>`, or narrow to one workspace with `vitest run --project ' +
            '<name>`. Watching the whole repository is the same gate, so `bun run test:watch` also takes a file or ' +
            'a `--project`. The full suite is a repository-wide gate; see the "Repository-wide gates" section of ' +
            'the `quality-check` skill.',
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
    const valueFlags = VALUE_FLAGS.get(runner) ?? [];
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--') continue;
        if (argument.startsWith('-')) {
            const name = argument.split('=', 1)[0];
            if (focusFlags.includes(name)) return false;
            if (valueFlags.includes(name) && !argument.includes('=')) index += 1;
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
        `Only the user can authorize a local full run. If they explicitly asked for one, re-run with`,
        `${AUTHORIZATION_VARIABLE}=1. Never set that variable on your own judgement or on another agent's verdict.`,
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
