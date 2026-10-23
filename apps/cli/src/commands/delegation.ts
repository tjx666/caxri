import {
    agentDelegationCreateRequestSchema,
    CaxriError,
    delegationProviderSchema,
    MAX_DELEGATION_WAIT_TASKS,
} from '@caxri/protocol';

import { AGENT_SESSION_COMMANDS } from './agent-session';
import { readBoundedTextFile } from './text-file';
import type { RemoteCommandDefinition } from './types';

const createFlags = new Set([
    '--project',
    '--session',
    '--provider',
    '--preset',
    '--model',
    '--effort',
    '--caller',
    '--prompt-file',
    '--follow-up',
    '--resume',
    '--continue-handover',
    '--title',
]);

const providerUsage = delegationProviderSchema.options.join('|');

async function createParameters(tokens: readonly string[]) {
    const values = new Map<string, string>();
    // `--new-session` and `--handoff` are the valueless flags; everything else is `--flag value`.
    const switches = new Set(['--new-session', '--handoff']);
    for (const flag of switches)
        if (tokens.filter((token) => token === flag).length > 1)
            throw new CaxriError('VALIDATION', `Pass ${flag} at most once`);
    const isNewSession = tokens.includes('--new-session');
    const isHandoff = tokens.includes('--handoff');
    const valueTokens = tokens.filter((token) => !switches.has(token));
    for (let index = 0; index < valueTokens.length; index += 2) {
        const flag = valueTokens[index];
        const value = valueTokens[index + 1];
        if (!value || !createFlags.has(flag) || value.startsWith('--') || values.has(flag))
            throw new CaxriError(
                'VALIDATION',
                'Delegation requires unique project, session, provider and prompt-file options',
            );
        values.set(flag, value);
    }
    const projectId = values.get('--project');
    const sessionId = values.get('--session');
    const path = values.get('--prompt-file');
    if (!projectId || !path || Boolean(sessionId) === isNewSession)
        throw new CaxriError(
            'VALIDATION',
            'Delegation requires --project, one of --session or --new-session, and --prompt-file',
        );
    if (isNewSession !== values.has('--title'))
        throw new CaxriError(
            'VALIDATION',
            'Name a new Session with --title; --title applies only with --new-session',
        );
    if (isHandoff && !isNewSession)
        throw new CaxriError('VALIDATION', '--handoff applies only with --new-session');
    return agentDelegationCreateRequestSchema.parse({
        projectId,
        ...(sessionId && { sessionId }),
        ...(isNewSession && { newSession: true }),
        ...(isHandoff && { handoff: true }),
        ...(values.has('--title') && { title: values.get('--title') }),
        provider: values.get('--provider'),
        preset: values.get('--preset'),
        model: values.get('--model'),
        effort: values.get('--effort'),
        callerProvider: values.get('--caller'),
        prompt: await readBoundedTextFile(path, 16_384, 'Delegation task'),
        ...(values.has('--follow-up') && { followUpOf: values.get('--follow-up') }),
        ...(values.has('--resume') && { resumeFrom: values.get('--resume') }),
        ...(values.has('--continue-handover') && {
            continueFromHandover: values.get('--continue-handover'),
        }),
    });
}

function identity(tokens: readonly string[]) {
    if (tokens.length !== 1 || tokens[0].startsWith('-'))
        throw new CaxriError('VALIDATION', 'Expected one delegation ID');
    return { delegationId: tokens[0] };
}

function waitIdentities(tokens: readonly string[]) {
    const [delegationId, ...otherDelegationIds] = tokens;
    if (
        !delegationId ||
        tokens.length > MAX_DELEGATION_WAIT_TASKS ||
        tokens.some((token) => token.startsWith('-'))
    )
        throw new CaxriError(
            'VALIDATION',
            `Expected one to ${MAX_DELEGATION_WAIT_TASKS} delegation IDs`,
        );
    return otherDelegationIds.length > 0 ? { delegationId, otherDelegationIds } : { delegationId };
}

function listParameters(tokens: readonly string[]) {
    let isActive = false;
    let limit: number | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === '--active') isActive = true;
        else if (token === '--limit') {
            const value = tokens[index + 1];
            if (!value || !/^\d+$/u.test(value))
                throw new CaxriError('VALIDATION', '--limit requires a positive integer');
            limit = Number(value);
            index += 1;
        } else throw new CaxriError('VALIDATION', `Unexpected argument: ${token.split('=', 1)[0]}`);
    }
    return limit === undefined ? { active: isActive } : { active: isActive, limit };
}

export const DELEGATION_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'presets'],
        method: 'agent.delegation.presets',
        summary: 'List the delegation presets available to this caller.',
        usage: `--project <id> --session <id> [--caller <${providerUsage}>]`,
        parseParams: (tokens) => {
            const values: Record<string, string> = {};
            const flags: Record<string, string> = {
                '--project': 'projectId',
                '--session': 'sessionId',
                '--caller': 'callerProvider',
            };
            for (let index = 0; index < tokens.length; index += 2) {
                const key = flags[tokens[index]];
                const value = tokens[index + 1];
                if (!key || !value || value.startsWith('--') || values[key])
                    throw new CaxriError(
                        'VALIDATION',
                        'Expected unique project, session and optional caller options',
                    );
                values[key] = value;
            }
            return values;
        },
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'stop'],
        method: 'agent.delegation.stop',
        quietIdKey: 'delegationId',
        summary: 'Interrupt your active delegated task without closing its visible Terminal.',
        usage: '<delegation-id>',
        ownerConfirmation: 'Interrupt this delegated task?',
        parseParams: identity,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'wait'],
        method: 'agent.delegation.wait',
        summary:
            'Wait for the first of your tasks to settle or block, without resending or stopping any of them.',
        usage: '<delegation-id> [<delegation-id>...] [--timeout <milliseconds>]',
        parseParams: waitIdentities,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'create'],
        method: 'agent.delegation.create',
        quietIdKey: 'delegationId',
        summary: 'Run a task in a visible Agent Terminal and preserve its exact result.',
        usage: `--project <id> (--session <id> | --new-session --title <text> [--handoff]) --prompt-file <path> [--preset <name> | --provider <${providerUsage}> [--model <name>] [--effort <level>]] [--caller <${providerUsage}>] [--follow-up <id> | --resume <id> | --continue-handover <id>]`,
        ownerConfirmation: 'Create this visible Agent delegation?',
        parseParams: createParameters,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'status'],
        method: 'agent.delegation.status',
        quietIdKey: 'delegationId',
        summary: 'Read the state of one visible Agent delegation.',
        usage: '<delegation-id>',
        parseParams: identity,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'result'],
        method: 'agent.delegation.result',
        summary: 'Retrieve the private answer for one exact delegated task.',
        usage: '<delegation-id>',
        parseParams: identity,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'list'],
        method: 'agent.delegation.list',
        quietKey: 'delegations',
        quietIdKey: 'delegationId',
        summary: 'List your own delegated tasks, newest first.',
        usage: '[--active] [--limit <count>]',
        parseParams: listParameters,
    },
    /**
     * Managing the Sessions `--new-session` created.
     */
    ...AGENT_SESSION_COMMANDS,
];
