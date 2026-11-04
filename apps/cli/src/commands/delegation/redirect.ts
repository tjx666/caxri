import { randomUUID } from 'node:crypto';

import { CaxriError, delegationRedirectParametersSchema } from '@caxri/protocol';

import { readBoundedTextFile } from '../text-file';
import type { RemoteCommandDefinition } from '../types';

/**
 * A character is at most four UTF-8 bytes, so the file read is bounded by bytes and the schema then bounds characters.
 */
const MAX_UTF8_BYTES_PER_CHAR = 4;

/**
 * Reads `<delegation-id> (--text <text> | --prompt-file <path>) [--operation-id <id>]`. Every invocation without
 * `--operation-id` is a new redirect; repeating one deliberately (after a transport failure that left the outcome
 * unknown) means passing the same `--operation-id` again, which the Server answers from its record and never delivers
 * twice.
 */
async function redirectParameters(tokens: readonly string[]) {
    const [delegationId, ...rest] = tokens;
    if (!delegationId || delegationId.startsWith('-'))
        throw new CaxriError('VALIDATION', 'Expected one delegation ID');
    const values = new Map<string, string>();
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index];
        const value = rest.at(index + 1);
        if (
            value === undefined ||
            values.has(flag) ||
            !['--text', '--prompt-file', '--operation-id'].includes(flag)
        )
            throw new CaxriError(
                'VALIDATION',
                'Expected unique --text <text> or --prompt-file <path>, and optional --operation-id <id>',
            );
        values.set(flag, value);
    }
    const file = values.get('--prompt-file');
    const text = values.get('--text');
    if ((file === undefined) === (text === undefined))
        throw new CaxriError('VALIDATION', 'Pass exactly one of --text or --prompt-file');
    return delegationRedirectParametersSchema.parse({
        delegationId,
        operationId: values.get('--operation-id') ?? randomUUID(),
        text:
            file === undefined
                ? text
                : await readBoundedTextFile(
                      file,
                      4_096 * MAX_UTF8_BYTES_PER_CHAR,
                      'Redirect direction',
                  ),
    });
}

export const DELEGATION_REDIRECT_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'redirect'],
        method: 'agent.delegation.redirect',
        quietIdKey: 'delegationId',
        summary:
            'Steer your running delegated Chat task with new direction in its own turn, or be refused; it is never queued or started as a new turn.',
        usage: '<delegation-id> (--text <text> | --prompt-file <path>) [--operation-id <id>]',
        ownerConfirmation: 'Redirect this delegated task?',
        parseParams: redirectParameters,
    },
];
