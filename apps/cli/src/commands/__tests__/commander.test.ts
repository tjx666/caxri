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

describe('Agent Commander CLI', () => {
    it('reads the board without options', () => {
        const board = remote(['commander', 'board']);

        expect(board.method).toBe('commander.board');
        expect(board.parseParams([])).toEqual({});
        expect(() => board.parseParams(['--all'])).toThrow(/Unexpected argument: --all/u);
    });

    it('creates an empty Session for exactly one Project', () => {
        const create = remote(['commander', 'session', 'create']);
        const parameters = create.parseParams(['--project', 'project-1']);

        expect(create.method).toBe('commander.session.create');
        expect(parameters).toEqual({ projectId: 'project-1' });
        expect(methods['commander.session.create'].params.parse(parameters)).toEqual({
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
        const create = remote(['commander', 'session', 'create']);

        expect(create.confirmation).toBeUndefined();
        expect(create.ownerConfirmation).toMatch(/Agent Commander/u);
    });

    it('records a task with a title and optional fields the protocol accepts', () => {
        const add = remote(['commander', 'task', 'add']);
        const parameters = add.parseParams([
            '--title',
            'Fix login retry',
            '--project',
            'project-1',
            '--note',
            'From chat',
        ]);

        expect(add.method).toBe('commander.task.create');
        expect(methods['commander.task.create'].params.parse(parameters)).toEqual({
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
        const update = remote(['commander', 'task', 'update']);
        const parameters = update.parseParams([
            'task-1',
            '--status',
            'done',
            '--pr',
            'https://example.com/pull/1',
            '--clear-note',
        ]);

        expect(update.method).toBe('commander.task.update');
        expect(methods['commander.task.update'].params.parse(parameters)).toEqual({
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
        const list = remote(['commander', 'task', 'list']);

        expect(list.method).toBe('commander.task.list');
        expect(list.parseParams([])).toEqual({});
        expect(list.parseParams(['--all'])).toEqual({ includeClosed: true });
        expect(() => list.parseParams(['--open'])).toThrow(/Unknown option: --open/u);
    });

    it('raises a merge item with its report from a file and repeated options', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-commander-cli-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const body = join(directory, 'report.md');
        await writeFile(body, 'Bug, Cause, Fix');
        const add = remote(['commander', 'inbox', 'add']);
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
        expect(remote(['commander', 'inbox', 'list']).parseParams([])).toEqual({
            includeClosed: false,
        });
        expect(remote(['commander', 'inbox', 'list']).parseParams(['--all'])).toEqual({
            includeClosed: true,
        });
        expect(remote(['commander', 'inbox', 'show']).parseParams(['item-1'])).toEqual({
            id: 'item-1',
        });
        expect(remote(['commander', 'inbox', 'resolve']).parseParams(['item-1'])).toEqual({
            id: 'item-1',
        });
        const ack = remote(['commander', 'inbox', 'ack']);
        expect(ack.parseParams(['item-1', '--sequence', '2'])).toEqual({
            id: 'item-1',
            sequence: 2,
        });
        for (const tokens of [['item-1'], ['item-1', '--sequence', '0'], ['--sequence', '1']])
            expect(() => ack.parseParams(tokens)).toThrow(/--sequence/u);
    });

    it('never exposes the owner-only Inbox actions to the CLI', () => {
        for (const action of ['reply', 'dismiss', 'merge'])
            expect(findCliCommand(['commander', 'inbox', action])).toBeUndefined();
    });
});
