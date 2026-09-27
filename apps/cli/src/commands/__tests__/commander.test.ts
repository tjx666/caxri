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
});
