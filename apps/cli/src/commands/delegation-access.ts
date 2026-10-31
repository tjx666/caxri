import { CaxriError, delegationAccessParametersSchema } from '@caxri/protocol';

import type { RemoteCommandDefinition } from './types';

function options(tokens: readonly string[]) {
    const values: Record<string, string | boolean> = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const flag = tokens[index];
        if (Object.hasOwn(values, flag))
            throw new CaxriError('VALIDATION', 'Delegation access options must be unique');
        if (flag === '--register-project') {
            values[flag] = true;
            continue;
        }
        const value = tokens[++index];
        if (
            !value ||
            !['--root', '--provider', '--ttl-ms', '--client', '--generation'].includes(flag) ||
            value.startsWith('--')
        )
            throw new CaxriError('VALIDATION', 'Invalid delegation access option');
        values[flag] = value;
    }
    return values;
}

export const DELEGATION_ACCESS_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'access', 'create'],
        method: 'agent.delegation.access.create',
        quietIdKey: 'clientId',
        requiresHumanOwner: true,
        summary: 'Authorize a bounded external caller in an explicit directory.',
        usage: '--root <absolute-path> --provider <claude|codex|grok|antigravity> [--register-project] [--ttl-ms <duration>]',
        confirmation: 'Authorize this external caller and create its dedicated Session?',
        parseParams: (tokens) => {
            const values = options(tokens);
            if (values['--client'] || values['--generation'])
                throw new CaxriError('VALIDATION', 'Client and generation are revoke options');
            return delegationAccessParametersSchema.parse({
                rootPath: values['--root'],
                callerProvider: values['--provider'],
                registerProject: values['--register-project'] ?? false,
                ...(values['--ttl-ms'] && { ttlMs: Number(values['--ttl-ms']) }),
            });
        },
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'access', 'list'],
        method: 'agent.delegation.access.list',
        requiresHumanOwner: true,
        summary: 'List external delegation authorizations without credentials.',
        parseParams: (tokens) => {
            if (tokens.length > 0)
                throw new CaxriError('VALIDATION', 'Access list takes no options');
            return {};
        },
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'access', 'revoke'],
        method: 'agent.delegation.access.revoke',
        quietIdKey: 'clientId',
        requiresHumanOwner: true,
        summary: 'Revoke one exact external caller generation.',
        usage: '--client <id> --generation <number>',
        confirmation: 'Revoke this external delegation client?',
        parseParams: (tokens) => {
            const values = options(tokens);
            if (Object.keys(values).some((key) => !['--client', '--generation'].includes(key)))
                throw new CaxriError('VALIDATION', 'Revoke requires client and generation only');
            return { clientId: values['--client'], generation: Number(values['--generation']) };
        },
    },
];
