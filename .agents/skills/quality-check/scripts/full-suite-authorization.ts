import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
 * The escape hatch is deliberately never the agent's to infer: no heuristic about branch state, offline CI, or "this
 * change is risky" opens it. The user grants it with `CAXRI_FULL_SUITE_AUTHORIZED=1`. While the user is away, the only
 * other key is an independent review receipt: a subagent or another harness judged that one full run is worth the
 * runner time, and recorded that verdict against the exact head (`e2e-testing` skill, "Local full-suite review").
 */

const AUTHORIZATION_VARIABLE = 'CAXRI_FULL_SUITE_AUTHORIZED';
const REVIEW_RECEIPT_VARIABLE = 'CAXRI_FULL_SUITE_REVIEW_RECEIPT';

/**
 * Written by the primary agent from an independent reviewer's verdict. `head` binds it to one commit, so a receipt for
 * an earlier head cannot be replayed after later edits change what the full run would validate.
 */
interface FullSuiteReviewReceipt {
    /**
     * Full commit SHA the reviewer judged.
     */
    head: string;
    /**
     * Who judged it, for example `subagent:general-purpose` or `dianjiang:codex`.
     */
    reviewer: string;
    /**
     * Only `run` authorizes; a reviewer that says `skip` is recorded the same way and still refuses.
     */
    verdict: 'run' | 'skip';
    /**
     * Why focused specs or remote CI cannot answer the question instead.
     */
    reason: string;
}

export interface FullSuiteAuthorizationDependencies {
    readHead: () => string;
    readReceipt: (path: string) => string;
}

/**
 * Synchronous on purpose: the guard runs once at runner startup, before any test work, and staying sync keeps every
 * caller (`globalSetup`, the package-script entrypoint, the pool runner) a plain boolean check.
 */
const DEFAULT_DEPENDENCIES: FullSuiteAuthorizationDependencies = {
    // oxlint-disable-next-line node/no-sync -- see the startup-only rationale above
    readHead: () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    // oxlint-disable-next-line node/no-sync -- see the startup-only rationale above
    readReceipt: (path) => readFileSync(path, 'utf8'),
};

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
 * Accepts only a well-formed `run` verdict for the current head. Any read or parse failure refuses, never authorizes.
 */
function isReviewReceiptValid(
    path: string,
    dependencies: FullSuiteAuthorizationDependencies = DEFAULT_DEPENDENCIES,
): boolean {
    try {
        const receipt = JSON.parse(
            dependencies.readReceipt(path),
        ) as Partial<FullSuiteReviewReceipt>;
        return (
            receipt.verdict === 'run' &&
            typeof receipt.reviewer === 'string' &&
            receipt.reviewer.trim() !== '' &&
            typeof receipt.reason === 'string' &&
            receipt.reason.trim() !== '' &&
            receipt.head === dependencies.readHead()
        );
    } catch {
        return false;
    }
}

/**
 * `CI` is set by GitHub Actions on every runner, which is exactly where the full gate is supposed to execute.
 */
export function isFullSuiteAuthorized(
    environment: NodeJS.ProcessEnv = process.env,
    dependencies: FullSuiteAuthorizationDependencies = DEFAULT_DEPENDENCIES,
): boolean {
    if (environment.CI || environment[AUTHORIZATION_VARIABLE]) return true;
    const receipt = environment[REVIEW_RECEIPT_VARIABLE];
    return Boolean(receipt) && isReviewReceiptValid(receipt as string, dependencies);
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
        `If the user has explicitly authorized a local full run, re-run with ${AUTHORIZATION_VARIABLE}=1. Never set`,
        `that variable on your own judgement. While the user is away, ask a subagent or another harness to judge`,
        `whether one full run is justified, and pass its current-head \`run\` verdict with`,
        `${REVIEW_RECEIPT_VARIABLE}=<receipt.json> (\`e2e-testing\` skill, "Local full-suite review").`,
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
