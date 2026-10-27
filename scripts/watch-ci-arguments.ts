/**
 * Command-line parsing for `scripts/watch-ci.ts`.
 */

export interface CliOptions {
    branch?: string;
    pr?: string;
    quiet: boolean;
    run?: string;
    /**
     * Follow every workflow run of this commit, full or abbreviated SHA, including `workflow_run` downstreams.
     */
    sha?: string;
    /**
     * With `--pr`, watch only the runs of this workflow, such as `Guards`, the one check `main` requires.
     */
    workflow?: string;
}

const VALUE_FLAGS = new Set(['--run', '--workflow', '--pr', '--branch', '--sha']);

/**
 * Returns the operand of a value flag, or throws when it is missing, blank, or another flag. Failing open here would
 * let `--branch` with no value silently watch the current branch, so every value flag shares this one check.
 */
function readOperand(flag: string, value: string | undefined): string {
    if (value === undefined || value.trim() === '' || value.startsWith('-')) {
        throw new Error(`${flag} requires a value`);
    }
    return value;
}

/**
 * Applies one CLI argument and returns how many argv slots it consumed.
 */
function applyArgument(options: CliOptions, argument: string, value: string | undefined): number {
    if (argument === '--quiet') {
        options.quiet = true;
        return 1;
    }
    if (!VALUE_FLAGS.has(argument)) throw new Error(`unknown argument: ${argument}`);
    const operand = readOperand(argument, value);
    switch (argument) {
        case '--run': {
            options.run = operand;
            break;
        }
        case '--workflow': {
            options.workflow = operand;
            break;
        }
        case '--pr': {
            options.pr = operand;
            break;
        }
        case '--sha': {
            if (!/^[0-9a-f]{7,40}$/iu.test(operand)) {
                throw new Error(`--sha requires a 7 to 40 character hexadecimal commit SHA`);
            }
            options.sha = operand;
            break;
        }
        default:
            options.branch = operand;
    }
    return 2;
}

/**
 * Parses argv without touching Git, GitHub, or any process, so an invalid command line is rejected before any call.
 */

export function parseArguments(argv: string[]): CliOptions {
    const options: CliOptions = { quiet: false };
    let index = 0;
    while (index < argv.length) {
        index += applyArgument(options, argv[index], argv[index + 1]);
    }
    if (options.sha && (options.pr || options.run || options.branch || options.workflow)) {
        throw new Error('--sha cannot be combined with --pr, --run, --branch, or --workflow');
    }
    return options;
}
