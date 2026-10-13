import { CaxriError } from '@caxri/protocol';

/**
 * Parses a command that takes no arguments.
 */
export function rejectOptions(tokens: readonly string[]): Record<string, never> {
    if (tokens.length > 0)
        throw new CaxriError('VALIDATION', `Unexpected argument: ${tokens[0].split('=', 1)[0]}`);
    return {};
}
