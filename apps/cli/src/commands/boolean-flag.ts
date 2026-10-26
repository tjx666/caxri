import { CaxriError } from '@caxri/protocol';

/**
 * Parses a command whose only argument is one optional boolean flag.
 */
export function booleanFlag(
    tokens: readonly string[],
    flag: string,
    key: string,
): Record<string, boolean> {
    if (tokens.length === 0) return { [key]: false };
    if (tokens.length === 1 && tokens[0] === flag) return { [key]: true };
    throw new CaxriError('VALIDATION', `Unknown option: ${tokens[0].split('=', 1)[0]}`);
}
