import {
    CaxriError,
    commanderInboxAddSchema,
    commanderInboxKindIds,
    commanderTaskStatuses,
    MAX_COMMANDER_INBOX_BODY_LENGTH,
} from '@caxri/protocol';

import { readBoundedTextFile } from './text-file';
import type { RemoteCommandDefinition } from './types';

function sessionArchiveParameters(tokens: readonly string[]) {
    if (tokens.length !== 1 || tokens[0].startsWith('--'))
        throw new CaxriError('VALIDATION', 'commander session archive requires one <session-id>');
    return { sessionId: tokens[0] };
}

function sessionCreateParameters(tokens: readonly string[]) {
    if (tokens.length !== 2 || tokens[0] !== '--project' || tokens[1].startsWith('--'))
        throw new CaxriError('VALIDATION', 'commander session create requires one --project <id>');
    return { projectId: tokens[1] };
}

const inboxAddFlags = new Set([
    '--kind',
    '--key',
    '--title',
    '--body-file',
    '--session',
    '--delegation',
    '--pr',
    '--head',
]);

/**
 * `--option` is the one repeatable flag; every other flag appears at most once.
 */
async function inboxAddParameters(tokens: readonly string[]) {
    const values = new Map<string, string>();
    const options: string[] = [];
    for (let index = 0; index < tokens.length; index += 2) {
        const flag = tokens[index];
        const value = tokens[index + 1];
        if (!value || value.startsWith('--'))
            throw new CaxriError('VALIDATION', `${flag} requires a value`);
        if (flag === '--option') options.push(value);
        else if (!inboxAddFlags.has(flag) || values.has(flag))
            throw new CaxriError('VALIDATION', `Unexpected or repeated argument: ${flag}`);
        else values.set(flag, value);
    }
    const url = values.get('--pr');
    const headSha = values.get('--head');
    if (Boolean(url) !== Boolean(headSha))
        throw new CaxriError('VALIDATION', 'Pass --pr and --head together');
    const bodyFile = values.get('--body-file');
    return commanderInboxAddSchema.parse({
        kind: values.get('--kind'),
        ...(values.has('--key') && { key: values.get('--key') }),
        title: values.get('--title'),
        ...(bodyFile && {
            body: await readBoundedTextFile(
                bodyFile,
                MAX_COMMANDER_INBOX_BODY_LENGTH,
                'Inbox body',
            ),
        }),
        options,
        ...(values.has('--session') && { sessionId: values.get('--session') }),
        ...(values.has('--delegation') && { delegationId: values.get('--delegation') }),
        ...(url && headSha && { pullRequest: { url, headSha } }),
    });
}

function inboxItem(tokens: readonly string[]) {
    if (tokens.length !== 1 || tokens[0].startsWith('-'))
        throw new CaxriError('VALIDATION', 'Expected one Inbox item ID');
    return { id: tokens[0] };
}

function inboxAcknowledgement(tokens: readonly string[]) {
    const sequence = Number(tokens[2]);
    if (
        tokens.length !== 3 ||
        tokens[0].startsWith('-') ||
        tokens[1] !== '--sequence' ||
        !Number.isSafeInteger(sequence) ||
        sequence < 1
    )
        throw new CaxriError('VALIDATION', 'Expected <item-id> --sequence <n>');
    return { id: tokens[0], sequence };
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
        path: ['commander', 'session', 'archive'],
        method: 'commander.session.archive',
        summary:
            'Archive a Session the Agent Commander created; the user can restore it from Archived Sessions.',
        usage: '<session-id>',
        ownerConfirmation: 'Archive this Agent Commander Session?',
        parseParams: sessionArchiveParameters,
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
    {
        kind: 'remote',
        path: ['commander', 'inbox', 'add'],
        method: 'commander.inbox.add',
        summary:
            'Raise an item for the user: a decision, a step needing their hands, or a verified pull request to merge. Reusing --key (or the same --pr) updates the open item.',
        usage: `--kind <${commanderInboxKindIds.join('|')}> --title <text> [--key <key>] [--body-file <path>] [--option <text>]... [--session <id>] [--delegation <id>] [--pr <url> --head <sha>]`,
        ownerConfirmation: 'Add this item to the Agent Commander Inbox?',
        parseParams: inboxAddParameters,
    },
    {
        kind: 'remote',
        path: ['commander', 'inbox', 'list'],
        method: 'commander.inbox.list',
        summary: 'List open Inbox items, or with --all the recently closed ones too.',
        usage: '[--all]',
        parseParams: (tokens) => {
            if (tokens.length > 1 || (tokens.length === 1 && tokens[0] !== '--all'))
                throw new CaxriError('VALIDATION', 'Expected only --all');
            return { includeClosed: tokens.length === 1 };
        },
        quietKey: 'items',
    },
    {
        kind: 'remote',
        path: ['commander', 'inbox', 'show'],
        method: 'commander.inbox.show',
        summary: 'Read one Inbox item with every reply from the user.',
        usage: '<item-id>',
        parseParams: inboxItem,
    },
    {
        kind: 'remote',
        path: ['commander', 'inbox', 'resolve'],
        method: 'commander.inbox.resolve',
        summary: 'Close an Inbox item whose matter is settled.',
        usage: '<item-id>',
        ownerConfirmation: 'Resolve this Agent Commander Inbox item?',
        parseParams: inboxItem,
    },
    {
        kind: 'remote',
        path: ['commander', 'inbox', 'ack'],
        method: 'commander.inbox.ack',
        summary:
            "Record that you read the user's replies up to a sequence, so they are not announced again after a restart.",
        usage: '<item-id> --sequence <n>',
        parseParams: inboxAcknowledgement,
    },
];
