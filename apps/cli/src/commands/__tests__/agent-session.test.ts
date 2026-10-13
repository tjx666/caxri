import { describe, expect, it } from 'vitest';

import { findCliCommand } from '../catalog';

function parse(path: string[], tokens: string[]) {
    const command = findCliCommand(path);
    if (command?.kind !== 'remote') throw new Error(`missing ${path.join(' ')}`);
    return command.parseParams(tokens);
}

describe('agent session commands', () => {
    it('parses a rename with its title in either position', () => {
        expect(parse(['agent', 'session', 'rename'], ['s1', '--title', 'Ship it'])).toEqual({
            sessionId: 's1',
            title: 'Ship it',
        });
        expect(parse(['agent', 'session', 'rename'], ['--title', 'Ship it', 's1'])).toEqual({
            sessionId: 's1',
            title: 'Ship it',
        });
    });

    it.each([
        [['rename'], ['s1']],
        [['rename'], ['s1', 's2', '--title', 'x']],
        [['archive'], []],
        [['archive'], ['s1', 's2']],
        [['unarchive'], ['--all']],
    ])('refuses %j %j', (command, tokens) => {
        expect(() => parse(['agent', 'session', ...command], tokens)).toThrow(
            expect.objectContaining({ code: 'VALIDATION' }),
        );
    });

    it('targets one Session to archive or restore', () => {
        expect(parse(['agent', 'session', 'archive'], ['s1'])).toEqual({ sessionId: 's1' });
        expect(parse(['agent', 'session', 'unarchive'], ['s1'])).toEqual({ sessionId: 's1' });
    });
});
