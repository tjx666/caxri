import { CaxriError } from '@caxri/protocol';

export interface ParsedCliArguments {
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

function takeValue(argv: readonly string[], index: number, option: string): [string, number] {
    const value = argv[index + 1];
    if (!value || value.startsWith('--'))
        throw new CaxriError('VALIDATION', `${option} requires a value`);
    return [value, index + 1];
}

export function parseCliArguments(argv: readonly string[]): ParsedCliArguments {
    if (
        argv.length > MAX_ARGUMENT_COUNT ||
        argv.some((argument) => argument.length > MAX_ARGUMENT_LENGTH)
    )
        throw new CaxriError('VALIDATION', 'CLI arguments exceed the supported limit');
    const parsed: ParsedCliArguments = {
        help: false,
        json: false,
        quiet: false,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        tokens: [],
        version: false,
        yes: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--json') parsed.json = true;
        else if (argument === '--quiet') parsed.quiet = true;
        else if (argument === '--yes') parsed.yes = true;
        else if (argument === '--help' || argument === '-h') parsed.help = true;
        else if (argument === '--version' || argument === '-V') parsed.version = true;
        else if (argument === '--profile') {
            const [value, consumed] = takeValue(argv, index, '--profile');
            if (parsed.profile !== undefined)
                throw new CaxriError('VALIDATION', '--profile may be provided only once');
            parsed.profile = value;
            index = consumed;
        } else if (argument === '--request-id') {
            const [value, consumed] = takeValue(argv, index, '--request-id');
            if (parsed.requestId !== undefined)
                throw new CaxriError('VALIDATION', '--request-id may be provided only once');
            if (value.length > 200)
                throw new CaxriError('VALIDATION', '--request-id exceeds 200 characters');
            parsed.requestId = value;
            index = consumed;
        } else if (argument === '--timeout') {
            const [value, consumed] = takeValue(argv, index, '--timeout');
            const timeoutMs = Number(value);
            if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000)
                throw new CaxriError('VALIDATION', '--timeout must be 100-120000 milliseconds');
            parsed.timeoutMs = timeoutMs;
            index = consumed;
        } else parsed.tokens.push(argument);
    }
    if (parsed.json && parsed.quiet)
        throw new CaxriError('VALIDATION', '--json and --quiet cannot be combined');
    return parsed;
}
