/**
 * Command-line parsing for `bun run check`, split from the runner so the parser and its guards stay small.
 */

export interface CheckOptions {
    e2e: boolean;
    e2eGrep?: string;
    e2eWaitSeconds?: number;
    files: string[];
    /**
     * No selector was passed, so the check picks its own gates: lint, related tests, and a typecheck plus `knip`
     * whenever a changed path can affect types. An explicit selector runs exactly what it names, which keeps fast
     * iteration fast.
     */
    isDefaultSelection: boolean;
    isStaged: boolean;
    knip: boolean;
    lint: boolean;
    /**
     * Run `vitest related` over the changed sources, so a test reaching a change only through another module also runs.
     */
    related: boolean;
    test: boolean;
    type: boolean;
}

export class CheckError extends Error {
    constructor(
        message: string,
        readonly exitCode = 1,
    ) {
        super(message);
    }
}

/**
 * A sibling session's focused E2E batch (rebuild plus several specs) routinely holds the desktop lease for 10 to 20
 * minutes, so a shorter cap pushed agents into hand-written retry loops around `--e2e`.
 */
const MAX_E2E_WAIT_SECONDS = 1800;

const usage = `Usage: bun run --silent check [files...] [--lint] [--test] [--type] [--knip] [--related] [--e2e] [--e2e-grep <pattern>] [--e2e-wait <seconds>] [--staged]

Selectors:
  --lint     Autofix supported changed files with ESLint and Prettier
  --test     Run changed tests and colocated tests for changed source files
  --type     Run the repository-wide TypeScript check
  --knip     Run the repository-wide dead code/export check (CI blocking)
  --related  Run every test that transitively imports a changed source (vitest related)
  --e2e      Build and run explicitly named e2e/*.e2e.ts Playwright specs
  --e2e-grep Narrow --e2e to a Playwright test-title pattern
  --e2e-wait Wait up to ${MAX_E2E_WAIT_SECONDS} seconds for the repository desktop lease (default: fail immediately)
  --staged   Discover only staged files when no file arguments are supplied

With no selector, --lint and --test are enabled.`;

/**
 * Applies a single CLI argument to `options` and reports whether the following argument in `arguments_` was consumed as
 * its value (e.g. `--e2e-grep <pattern>`). Extracted out of the parsing loop so the `switch` cases can `return` instead
 * of nesting `break` inside a loop.
 */
function didConsumeNextCheckArgument(
    argument: string,
    nextArgument: string | undefined,
    options: CheckOptions,
): boolean {
    switch (argument) {
        case '--help':
        case '-h':
            throw new CheckError(usage, 0);
        case '--knip':
            options.knip = true;
            return false;
        case '--e2e':
            options.e2e = true;
            return false;
        case '--e2e-grep': {
            if (!nextArgument || nextArgument.startsWith('--')) {
                throw new CheckError('--e2e-grep requires a test-title pattern', 2);
            }
            options.e2eGrep = nextArgument;
            return true;
        }
        case '--e2e-wait': {
            const seconds = Number(nextArgument);
            if (
                !nextArgument ||
                !Number.isSafeInteger(seconds) ||
                seconds < 1 ||
                seconds > MAX_E2E_WAIT_SECONDS
            )
                throw new CheckError(
                    `--e2e-wait requires an integer from 1 to ${MAX_E2E_WAIT_SECONDS} seconds`,
                    2,
                );
            options.e2eWaitSeconds = seconds;
            return true;
        }
        case '--lint':
            options.lint = true;
            return false;
        case '--related':
            options.related = true;
            return false;
        case '--staged':
            options.isStaged = true;
            return false;
        case '--test':
            options.test = true;
            return false;
        case '--type':
            options.type = true;
            return false;
        default:
            if (argument.startsWith('-')) {
                throw new CheckError(`Unknown option: ${argument}\n\n${usage}`, 2);
            }
            /**
             * Zsh does not word-split an unquoted `$files`, so `check $files` passes a newline-joined list as one path.
             * That path matches nothing and the check used to report a green "0 changed" without checking a file.
             */
            if (/[\n\r]/u.test(argument)) {
                throw new CheckError(
                    'A file argument contains a newline; pass one path per argument, e.g. `git diff --name-only | xargs bun run --silent check --lint`',
                    2,
                );
            }
            options.files.push(argument);
            return false;
    }
}

export function parseCheckArguments(arguments_: string[]): CheckOptions {
    const options: CheckOptions = {
        e2e: false,
        e2eGrep: undefined,
        e2eWaitSeconds: undefined,
        files: [],
        isDefaultSelection: false,
        isStaged: false,
        knip: false,
        lint: false,
        related: false,
        test: false,
        type: false,
    };

    for (let index = 0; index < arguments_.length; index += 1) {
        const isConsumedNext = didConsumeNextCheckArgument(
            arguments_[index],
            arguments_[index + 1],
            options,
        );
        if (isConsumedNext) index += 1;
    }

    if (options.e2eGrep && !options.e2e) {
        throw new CheckError('--e2e-grep requires --e2e', 2);
    }
    if (options.e2eWaitSeconds && !options.e2e)
        throw new CheckError('--e2e-wait requires --e2e', 2);

    if (
        !options.e2e &&
        !options.knip &&
        !options.lint &&
        !options.related &&
        !options.test &&
        !options.type
    ) {
        options.isDefaultSelection = true;
        options.lint = true;
        options.test = true;
    }

    return options;
}
