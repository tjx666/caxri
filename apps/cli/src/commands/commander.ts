import { CaxriError, commanderTaskStatuses } from '@caxri/protocol';

import type { RemoteCommandDefinition } from './types';

function sessionCreateParameters(tokens: readonly string[]) {
    if (tokens.length !== 2 || tokens[0] !== '--project' || tokens[1].startsWith('--'))
        throw new CaxriError('VALIDATION', 'commander session create requires one --project <id>');
    return { projectId: tokens[1] };
}

/**
 * Parses `--flag <value>` options and bare `--clear-*` switches for the task ledger commands. A clear switch maps to
 * `null` for its key, so `update` can distinguish "leave unchanged" from "remove".
 */
function taskOptions(
    tokens: readonly string[],
    values: Readonly<Record<string, string>>,
    clears: Readonly<Record<string, string>> = {},
): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    for (let index = 0; index < tokens.length; index += 1) {
        const flag = tokens[index];
        const key = values[flag] ?? clears[flag];
        if (!key) throw new CaxriError('VALIDATION', `Unknown option: ${flag.split('=', 1)[0]}`);
        if (key in result)
            throw new CaxriError(
                'VALIDATION',
                `${flag} conflicts with another option for the same field`,
            );
        if (clears[flag]) {
            result[key] = null;
            continue;
        }
        const value = tokens[index + 1];
        if (!value || value.startsWith('--'))
            throw new CaxriError('VALIDATION', `${flag} requires a value`);
        result[key] = value;
        index += 1;
    }
    if (
        typeof result.status === 'string' &&
        !(commanderTaskStatuses as readonly string[]).includes(result.status)
    )
        throw new CaxriError(
            'VALIDATION',
            `--status must be one of: ${commanderTaskStatuses.join(', ')}`,
        );
    return result;
}

function taskCreateParameters(tokens: readonly string[]) {
    const options = taskOptions(tokens, {
        '--title': 'title',
        '--status': 'status',
        '--project': 'projectId',
        '--note': 'note',
    });
    if (!options.title) throw new CaxriError('VALIDATION', '--title is required');
    return options;
}

function taskUpdateParameters(tokens: readonly string[]) {
    const [taskId, ...rest] = tokens;
    if (!taskId || taskId.startsWith('--'))
        throw new CaxriError('VALIDATION', 'commander task update requires a task ID');
    const options = taskOptions(
        rest,
        {
            '--title': 'title',
            '--status': 'status',
            '--project': 'projectId',
            '--delegation': 'delegationId',
            '--note': 'note',
            '--pr': 'pullRequestUrl',
        },
        {
            '--clear-project': 'projectId',
            '--clear-delegation': 'delegationId',
            '--clear-note': 'note',
            '--clear-pr': 'pullRequestUrl',
        },
    );
    if (Object.keys(options).length === 0)
        throw new CaxriError('VALIDATION', 'commander task update requires at least one change');
    return { taskId, ...options };
}

function taskListParameters(tokens: readonly string[]) {
    if (tokens.length === 0) return {};
    if (tokens.length === 1 && tokens[0] === '--all') return { includeClosed: true };
    throw new CaxriError('VALIDATION', `Unknown option: ${tokens[0].split('=', 1)[0]}`);
}

/**
 * Agent Commander commands. The Commander's own Agent Terminal runs them non-interactively: its Endpoint carries the
 * `commander` capability, so only a human owner is asked to confirm. See `docs/agent-commander.md`.
 */
export const COMMANDER_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['commander', 'board'],
        method: 'commander.board',
        summary: 'Read every visible Project and Session with Agent state and pull requests.',
        parseParams: (tokens) => {
            if (tokens.length > 0)
                throw new CaxriError(
                    'VALIDATION',
                    `Unexpected argument: ${tokens[0].split('=', 1)[0]}`,
                );
            return {};
        },
        quietKey: 'rows',
        quietIdKey: 'sessionId',
    },
    {
        kind: 'remote',
        path: ['commander', 'session', 'create'],
        method: 'commander.session.create',
        summary: 'Create an empty Session to delegate one task into.',
        usage: '--project <id>',
        ownerConfirmation: 'Create an empty Session for the Agent Commander?',
        parseParams: sessionCreateParameters,
        quietIdKey: 'sessionId',
    },
    {
        kind: 'remote',
        path: ['commander', 'task', 'list'],
        method: 'commander.task.list',
        summary: 'List open Agent Commander tasks, oldest first; --all adds recently closed ones.',
        usage: '[--all]',
        parseParams: taskListParameters,
        quietKey: 'tasks',
    },
    {
        kind: 'remote',
        path: ['commander', 'task', 'add'],
        method: 'commander.task.create',
        summary: 'Record a task the Agent Commander was asked to do.',
        usage: '--title <text> [--status <status>] [--project <id>] [--note <text>]',
        parseParams: taskCreateParameters,
    },
    {
        kind: 'remote',
        path: ['commander', 'task', 'update'],
        method: 'commander.task.update',
        summary: 'Change a task: status, title, note, Project, linked delegation, or pull request.',
        usage:
            '<taskId> [--title <text>] [--status <status>] [--project <id> | --clear-project] ' +
            '[--delegation <id> | --clear-delegation] [--note <text> | --clear-note] [--pr <url> | --clear-pr]',
        parseParams: taskUpdateParameters,
    },
];
