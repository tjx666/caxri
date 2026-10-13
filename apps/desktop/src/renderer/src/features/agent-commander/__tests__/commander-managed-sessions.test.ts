import type { ServerEvent } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    commanderSessionMarker,
    inputTakeBackNotice,
    isCommanderManagedSessionsEvent,
    unseenInputTakeBacks,
} from '../commander-managed-sessions';

describe('commanderSessionMarker', () => {
    const managed = {
        sessionIds: ['created', 'handed-over', 'handed-over-chat'],
        inputTakeBackSessionIds: ['handed-over', 'handed-over-chat'],
        chatTakeBackSessionIds: ['handed-over-chat'],
    };

    it('warns only where input takes the Session back, with Chat wording for a Chat', () => {
        expect(commanderSessionMarker(managed, 'handed-over')).toBe('inputTakesBack');
        expect(commanderSessionMarker(managed, 'handed-over-chat')).toBe('chatInputTakesBack');
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

describe('inputTakeBackNotice', () => {
    it('names the Session typing took back and offers to hand it back', () => {
        expect(inputTakeBackNotice({ sessionId: 'session-1' }, 'Fix login')).toEqual({
            message: 'Took Fix login back from Agent Commander',
            action: { id: 'agentCommander.handBack', params: { sessionId: 'session-1' } },
        });
        expect(inputTakeBackNotice({ sessionId: 'session-2' }, undefined)).toMatchObject({
            message: 'Took a Session back from Agent Commander',
            action: { params: { sessionId: 'session-2' } },
        });
    });
});
