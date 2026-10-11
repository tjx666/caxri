import { methods } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

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
});
