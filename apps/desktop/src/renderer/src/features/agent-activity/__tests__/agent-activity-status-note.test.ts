import { describe, expect, it } from 'vitest';

import { agentActivityStatusNote } from '../agent-activity-status-note';

type Row = Parameters<typeof agentActivityStatusNote>[0];

function row(overrides: Partial<Row> & { lastAttentionKind?: string } = {}): Row {
    const { lastAttentionKind, ...rest } = overrides;
    return {
        groupId: 'attention',
        isBackgroundWait: false,
        session: { lastAttentionKind } as Row['session'],
        ...rest,
    };
}

describe('agentActivityStatusNote', () => {
    it('says a working row waits on background work', () => {
        expect(
            agentActivityStatusNote(row({ groupId: 'working', isBackgroundWait: true }), false),
        ).toBe('background');
        expect(
            agentActivityStatusNote(row({ groupId: 'working', isBackgroundWait: true }), true),
        ).toBe('background');
        expect(agentActivityStatusNote(row({ groupId: 'working' }), false)).toBeUndefined();
    });

    it('marks a waiting or failed Needs attention row while excerpts are hidden', () => {
        expect(agentActivityStatusNote(row({ lastAttentionKind: 'waiting' }), false)).toBe(
            'waiting',
        );
        expect(agentActivityStatusNote(row({ lastAttentionKind: 'failed' }), false)).toBe('failed');
        expect(agentActivityStatusNote(row({ lastAttentionKind: 'completed' }), false)).toBe(
            undefined,
        );
    });

    it('leaves the state to the excerpt when excerpts are shown', () => {
        expect(agentActivityStatusNote(row({ lastAttentionKind: 'waiting' }), true)).toBe(
            undefined,
        );
    });

    it('adds nothing to idle rows', () => {
        expect(
            agentActivityStatusNote(row({ groupId: 'idle', lastAttentionKind: 'failed' }), false),
        ).toBeUndefined();
    });
});
