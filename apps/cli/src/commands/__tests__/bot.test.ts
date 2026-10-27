import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { methods } from '@caxri/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';

import { findCliCommand } from '../catalog';

function remote(path: string[]) {
    const command = findCliCommand(path);
    if (command?.kind !== 'remote') throw new Error(`Missing remote command ${path.join(' ')}`);
    return command;
}

describe('Caxri Bot CLI', () => {
    it('reads the board without options', () => {
        const board = remote(['bot', 'board']);

        expect(board.method).toBe('bot.board');
        expect(board.parseParams([])).toEqual({});
        expect(() => board.parseParams(['--all'])).toThrow(/Unexpected argument: --all/u);
    });

    it('creates an empty Session for exactly one Project', () => {
        const create = remote(['bot', 'session', 'create']);
        const parameters = create.parseParams(['--project', 'project-1']);

        expect(create.method).toBe('bot.session.create');
        expect(parameters).toEqual({ projectId: 'project-1' });
        expect(methods['bot.session.create'].params.parse(parameters)).toEqual({
            projectId: 'project-1',
        });
        for (const tokens of [
            [],
            ['--project'],
            ['--project', '--json'],
            ['--project', 'project-1', '--project', 'project-2'],
            ['--session', 'session-1'],
        ])
            expect(() => create.parseParams(tokens)).toThrow(/one --project/u);
    });

    it('asks only a human owner to confirm Session creation', () => {
        const create = remote(['bot', 'session', 'create']);

        expect(create.confirmation).toBeUndefined();
        expect(create.ownerConfirmation).toMatch(/Caxri Bot/u);
    });

    it('records a task with a title and optional fields the protocol accepts', () => {
        const add = remote(['bot', 'task', 'add']);
        const parameters = add.parseParams([
            '--title',
            'Fix login retry',
            '--project',
            'project-1',
            '--note',
            'From chat',
        ]);

        expect(add.method).toBe('bot.task.create');
        expect(methods['bot.task.create'].params.parse(parameters)).toEqual({
            title: 'Fix login retry',
            projectId: 'project-1',
            note: 'From chat',
        });
        expect(() => add.parseParams([])).toThrow(/--title is required/u);
        expect(() => add.parseParams(['--title', 'x', '--status', 'later'])).toThrow(
            /--status must be one of/u,
        );
        expect(() => add.parseParams(['--title', 'x', '--title', 'y'])).toThrow(/conflicts/u);
    });

    it('updates a task, clearing a field only through its --clear switch', () => {
        const update = remote(['bot', 'task', 'update']);
        const parameters = update.parseParams([
            'task-1',
            '--status',
            'done',
            '--pr',
            'https://example.com/pull/1',
            '--clear-note',
        ]);

        expect(update.method).toBe('bot.task.update');
        expect(methods['bot.task.update'].params.parse(parameters)).toEqual({
            taskId: 'task-1',
            status: 'done',
            pullRequestUrl: 'https://example.com/pull/1',
            note: null,
        });
        expect(() => update.parseParams(['task-1'])).toThrow(/at least one change/u);
        expect(() => update.parseParams(['--status', 'done'])).toThrow(/requires a task ID/u);
        expect(() => update.parseParams(['task-1', '--note', 'x', '--clear-note'])).toThrow(
            /conflicts/u,
        );
    });

    it('lists open tasks, or every task with --all', () => {
        const list = remote(['bot', 'task', 'list']);

        expect(list.method).toBe('bot.task.list');
        expect(list.parseParams([])).toEqual({});
        expect(list.parseParams(['--all'])).toEqual({ includeClosed: true });
        expect(() => list.parseParams(['--open'])).toThrow(/Unknown option: --open/u);
    });

    it('raises a merge item with its report from a file and repeated options', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-bot-cli-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const body = join(directory, 'report.md');
        await writeFile(body, 'Bug, Cause, Fix');
        const add = remote(['bot', 'inbox', 'add']);
        const url = 'https://github.com/acme/widgets/pull/7';
        const headSha = 'a'.repeat(40);

        expect(
            await add.parseParams([
                '--kind',
                'merge',
                '--title',
                'Ready',
                '--body-file',
                body,
                '--pr',
                url,
                '--head',
                headSha,
            ]),
        ).toEqual({
            kind: 'merge',
            title: 'Ready',
            body: 'Bug, Cause, Fix',
            options: [],
            pullRequest: { url, headSha },
        });
        expect(
            await add.parseParams([
                '--kind',
                'decision',
                '--title',
                'Pick',
                '--option',
                'A',
                '--option',
                'B',
                '--key',
                'schema',
            ]),
        ).toMatchObject({ kind: 'decision', key: 'schema', options: ['A', 'B'], body: '' });
        await expect(
            add.parseParams(['--kind', 'merge', '--title', 'x', '--pr', url]),
        ).rejects.toThrow(/--pr and --head/u);
        await expect(
            add.parseParams(['--kind', 'decision', '--title', 'x', '--title', 'y']),
        ).rejects.toThrow(/repeated/u);
        expect(add.confirmation).toBeUndefined();
    });

    it('lists, shows, resolves, and acknowledges by item ID', () => {
        expect(remote(['bot', 'inbox', 'list']).parseParams([])).toEqual({
            includeClosed: false,
        });
        expect(remote(['bot', 'inbox', 'list']).parseParams(['--all'])).toEqual({
            includeClosed: true,
        });
        expect(remote(['bot', 'inbox', 'show']).parseParams(['item-1'])).toEqual({
            id: 'item-1',
        });
        expect(remote(['bot', 'inbox', 'resolve']).parseParams(['item-1'])).toEqual({
            id: 'item-1',
        });
        const ack = remote(['bot', 'inbox', 'ack']);
        expect(ack.parseParams(['item-1', '--sequence', '2'])).toEqual({
            id: 'item-1',
            sequence: 2,
        });
        for (const tokens of [['item-1'], ['item-1', '--sequence', '0'], ['--sequence', '1']])
            expect(() => ack.parseParams(tokens)).toThrow(/--sequence/u);
    });

    it('never exposes the owner-only Inbox actions to the CLI', () => {
        for (const action of ['reply', 'dismiss', 'merge'])
            expect(findCliCommand(['bot', 'inbox', action])).toBeUndefined();
    });
});
