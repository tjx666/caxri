import { methods } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { findCliCommand } from '../catalog';

function parse(path: string[], tokens: string[]) {
    const command = findCliCommand(path);
    if (command?.kind !== 'remote') throw new Error(`missing ${path.join(' ')}`);
    return methods[command.method].params.parse(command.parseParams(tokens));
}

describe('session commands', () => {
    it('joins search terms and repeats --provider', () => {
        expect(
            parse(
                ['session', 'search'],
                [
                    'fix',
                    'login',
                    '--provider',
                    'claude',
                    '--provider',
                    'codex',
                    '--status',
                    'external',
                ],
            ),
        ).toEqual({ query: 'fix login', providers: ['claude', 'codex'], status: 'external' });
        expect(parse(['session', 'search'], [])).toEqual({ query: '' });
    });

    it('rejects an unknown provider or status', () => {
        expect(() => parse(['session', 'search'], ['--provider', 'gpt'])).toThrow(
            '--provider must be one of',
        );
        expect(() => parse(['session', 'search'], ['--status', 'open'])).toThrow(
            '--status must be one of',
        );
    });

    it('imports by a search key or by provider and conversation ID', () => {
        const expected = { provider: 'claude', agentSessionId: '3b1e2a4c' };
        expect(parse(['session', 'import'], ['claude:3b1e2a4c'])).toEqual(expected);
        expect(parse(['session', 'import'], ['claude', '3b1e2a4c'])).toEqual(expected);
        expect(() => parse(['session', 'import'], ['3b1e2a4c'])).toThrow('session import requires');
    });

    it('renames with the title in either position', () => {
        const expected = { sessionId: 's1', title: 'Ship it' };
        expect(parse(['session', 'rename'], ['s1', '--title', 'Ship it'])).toEqual(expected);
        expect(parse(['session', 'rename'], ['--title', 'Ship it', 's1'])).toEqual(expected);
        expect(() => parse(['session', 'rename'], ['s1'])).toThrow('--title <text>');
    });

    it('pins and unpins one Session', () => {
        expect(parse(['session', 'pin'], ['s1'])).toEqual({ sessionId: 's1', pinned: true });
        expect(parse(['session', 'unpin'], ['s1'])).toEqual({ sessionId: 's1', pinned: false });
        expect(() => parse(['session', 'pin'], [])).toThrow('requires one <session-id>');
    });
});
