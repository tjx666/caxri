import { describe, expect, it } from 'vitest';

import { DELEGATION_APPROVAL_COMMANDS } from '../approval';

const approve = DELEGATION_APPROVAL_COMMANDS[0];

describe('delegation approval CLI', () => {
    it('maps one flag to one decision', () => {
        expect(approve.path).toEqual(['agent', 'delegate', 'approve']);
        expect(approve.method).toBe('agent.delegation.approve');
        expect(approve.parseParams(['d1', 'r1', '--revision', 'rev1', '--accept'])).toEqual({
            delegationId: 'd1',
            requestId: 'r1',
            decision: 'accept',
            revision: 'rev1',
        });
        expect(approve.parseParams(['d1', 'r1', '--decline', '--revision', 'rev1'])).toEqual({
            delegationId: 'd1',
            requestId: 'r1',
            decision: 'decline',
            revision: 'rev1',
        });
    });

    it('rejects a missing, doubled, or unknown decision and missing identifiers', () => {
        for (const tokens of [
            ['d1', 'r1', '--revision', 'rev1'],
            ['d1', 'r1', '--revision', 'rev1', '--accept', '--decline'],
            ['d1', 'r1', '--revision', 'rev1', '--accept', '--accept'],
            ['d1', 'r1', '--revision', 'rev1', '--always'],
            ['d1', 'r1', '--revision', 'rev1', 'accept'],
            ['d1', 'r1', '--accept'],
            ['d1', 'r1', '--revision', '--accept'],
            ['d1', 'r1', '--accept', '--revision'],
            ['d1', '--revision', 'rev1', '--accept'],
            ['--accept'],
            [],
        ])
            expect(() => approve.parseParams(tokens), tokens.join(' ')).toThrow();
    });
});
