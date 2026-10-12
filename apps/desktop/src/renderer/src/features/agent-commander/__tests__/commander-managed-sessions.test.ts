import type { ServerEvent } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    commanderSessionMarker,
    isCommanderManagedSessionsEvent,
    unseenInputTakeBacks,
} from '../commander-managed-sessions';

describe('commanderSessionMarker', () => {
    const managed = {
        sessionIds: ['created', 'handed-over'],
        inputTakeBackSessionIds: ['handed-over'],
    };

    it('warns only where typing takes the Session back', () => {
        expect(commanderSessionMarker(managed, 'handed-over')).toBe('inputTakesBack');
        expect(commanderSessionMarker(managed, 'created')).toBe('managed');
        expect(commanderSessionMarker(managed, 'own')).toBe('none');
    });
});

describe('unseenInputTakeBacks', () => {
    const first = { id: 'a', sessionId: 'session-1', at: 1 };
    const second = { id: 'b', sessionId: 'session-2', at: 2 };

    it('treats what the first read finds as already shown', () => {
        expect(unseenInputTakeBacks(undefined, [first])).toEqual({
            fresh: [],
            seen: new Set(['a']),
        });
    });

    it('announces each later take-back once', () => {
        const { fresh, seen } = unseenInputTakeBacks(new Set(['a']), [first, second]);
        expect(fresh).toEqual([second]);
        expect(unseenInputTakeBacks(seen, [first, second]).fresh).toEqual([]);
    });
});

describe('isCommanderManagedSessionsEvent', () => {
    it('re-reads on a full state change or a recovered connection, never on a record patch', () => {
        const events: Array<[ServerEvent, boolean]> = [
            [{ event: 'state.changed', payload: { kind: 'full', reason: 'session.create' } }, true],
            [
                {
                    event: 'state.changed',
                    payload: { kind: 'records', sessionIds: ['session-1'], terminalIds: [] },
                },
                false,
            ],
            [{ event: 'runtime.status', payload: { status: 'ready' } } as ServerEvent, true],
        ];
        for (const [event, expected] of events)
            expect(isCommanderManagedSessionsEvent(event)).toBe(expected);
    });
});
