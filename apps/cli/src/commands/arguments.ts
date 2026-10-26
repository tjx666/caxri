import type { CaxriMethod } from '@caxri/protocol';
import { CaxriError, MAX_DELEGATION_WAIT_TIMEOUT_MS } from '@caxri/protocol';

export interface ParsedCliArguments {
    connectTimeoutMs: number;
    help: boolean;
    json: boolean;
    profile?: string;
    quiet: boolean;
    requestId?: string;
    timeoutMs: number;
    tokens: string[];
    version: boolean;
    yes: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ARGUMENT_COUNT = 128;
const MAX_ARGUMENT_LENGTH = 4_096;
const MIN_TIMEOUT_MS = 100;
/**
 * Ceiling of `--connect-timeout`, and of `--timeout` on every command without its own long-poll ceiling.
 */
const MAX_REQUEST_TIMEOUT_MS = 120_000;
/**
 * Commands whose `--timeout` becomes the Server long-poll `timeoutMs`. A ceiling above `MAX_REQUEST_TIMEOUT_MS` is the
 * method schema's own `timeoutMs` maximum, so `--help` and validation cannot disagree.
 */
const LONG_POLL_TIMEOUT_CEILINGS: Partial<Record<CaxriMethod, number>> = {
    'agent.delegation.wait': MAX_DELEGATION_WAIT_TIMEOUT_MS,
    'agent.dispatch.wait': MAX_REQUEST_TIMEOUT_MS,
    'agent.message.wait': MAX_REQUEST_TIMEOUT_MS,
};

function takeValue(argv: readonly string[], index: number, option: string): [string, number] {
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
        throw new CaxriError('VALIDATION', `${option} requires a value`);
    return [value, index + 1];
}

function timeoutRangeError(option: string, ceiling: number) {
    return new CaxriError(
        'VALIDATION',
        `${option} must be ${MIN_TIMEOUT_MS}-${ceiling} milliseconds`,
    );
}

/**
 * Rejects a `--timeout` outside the selected command's range. The ceiling is the method's long-poll maximum, or the
 * request ceiling for every other command.
 */
export function assertCommandTimeout(timeoutMs: number, method?: CaxriMethod): void {
    const ceiling = commandTimeoutCeiling(method);
    if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > ceiling)
        throw timeoutRangeError('--timeout', ceiling);
}

export function commandTimeoutCeiling(method?: CaxriMethod): number {
    return (method && LONG_POLL_TIMEOUT_CEILINGS[method]) ?? MAX_REQUEST_TIMEOUT_MS;
}

/**
 * Validates `--timeout` for a remote command and, for a long poll, maps it to the request's `timeoutMs`; the connect
 * deadline stays separate.
 */
export function withCommandTimeout(
    method: CaxriMethod,
    parameters: unknown,
    timeoutMs: number,
): unknown {
    assertCommandTimeout(timeoutMs, method);
    return method in LONG_POLL_TIMEOUT_CEILINGS
        ? { ...(parameters as object), timeoutMs }
        : parameters;
}

interface ArgumentApplyResult {
    isConnectTimeoutExplicit: boolean;
    nextIndex: number;
}

/**
 * Applies a single CLI argument to `parsed`, returning the loop cursor to resume from. Extracted from
 * `parseCliArguments`'s `for` loop so the `switch`/`break` pairs here are not nested inside a loop, satisfying
 * `unicorn/no-break-in-nested-loop`.
 */
function applyArgument(
    argv: readonly string[],
    index: number,
    argument: string,
    parsed: ParsedCliArguments,
    isConnectTimeoutExplicit: boolean,
): ArgumentApplyResult {
    switch (argument) {
        case '--json': {
            parsed.json = true;
            break;
        }
        case '--quiet': {
            parsed.quiet = true;
            break;
        }
        case '--yes': {
            parsed.yes = true;
            break;
        }
        case '--help':
        case '-h': {
            parsed.help = true;
            break;
        }
        case '--version':
        case '-V': {
            parsed.version = true;
            break;
        }
        case '--profile': {
            const [value, consumed] = takeValue(argv, index, '--profile');
            if (parsed.profile !== undefined)
                throw new CaxriError('VALIDATION', '--profile may be provided only once');
            parsed.profile = value;
            index = consumed;
            break;
        }
        case '--request-id': {
            const [value, consumed] = takeValue(argv, index, '--request-id');
            if (parsed.requestId !== undefined)
                throw new CaxriError('VALIDATION', '--request-id may be provided only once');
            if (value.length > 200)
                throw new CaxriError('VALIDATION', '--request-id exceeds 200 characters');
            parsed.requestId = value;
            index = consumed;
            break;
        }
        case '--timeout':
        case '--connect-timeout': {
            const [value, consumed] = takeValue(argv, index, argument);
            const timeoutMs = Number(value);
            if (!Number.isSafeInteger(timeoutMs))
                throw new CaxriError(
                    'VALIDATION',
                    `${argument} must be an integer of milliseconds`,
                );
            /**
             * `--timeout` depends on the command, so `assertCommandTimeout` checks its range once the command is known.
             */
            if (
                argument === '--connect-timeout' &&
                (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_REQUEST_TIMEOUT_MS)
            )
                throw timeoutRangeError(argument, MAX_REQUEST_TIMEOUT_MS);
            if (argument === '--connect-timeout') {
                parsed.connectTimeoutMs = timeoutMs;
                isConnectTimeoutExplicit = true;
            } else {
                parsed.timeoutMs = timeoutMs;
                /**
                 * Preserve `--timeout` as the legacy transport/request deadline unless split.
                 */
                if (!isConnectTimeoutExplicit)
                    parsed.connectTimeoutMs = Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS);
            }
            index = consumed;
            break;
        }
        default:
            parsed.tokens.push(argument);
    }
    return { isConnectTimeoutExplicit, nextIndex: index };
}

export function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
    if (
        argv.length > MAX_ARGUMENT_COUNT ||
        argv.some((argument) => argument.length > MAX_ARGUMENT_LENGTH)
    )
        throw new CaxriError('VALIDATION', 'CLI arguments exceed the supported limit');
    const parsed: ParsedCliArguments = {
        connectTimeoutMs: DEFAULT_TIMEOUT_MS,
        help: false,
        json: false,
        quiet: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        tokens: [],
        version: false,
        yes: false,
    };
    let isConnectTimeoutExplicit = false;
    for (let index = 0; index < argv.length; index += 1) {
        const result = applyArgument(argv, index, argv[index], parsed, isConnectTimeoutExplicit);
        index = result.nextIndex;
        isConnectTimeoutExplicit = result.isConnectTimeoutExplicit;
    }
    if (parsed.json && parsed.quiet)
        throw new CaxriError('VALIDATION', '--json and --quiet cannot be combined');
    return parsed;
}
