import type { ServerEvent } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    botSessionMarker,
    inputTakeBackNotice,
    isBotManagedSessionsEvent,
    unseenInputTakeBacks,
} from '../bot-managed-sessions';

describe('botSessionMarker', () => {
    const managed = {
        sessionIds: ['created', 'handed-over', 'handed-over-chat'],
        inputTakeBackSessionIds: ['handed-over', 'handed-over-chat'],
        chatTakeBackSessionIds: ['handed-over-chat'],
    };

    it('warns only where input takes the Session back, with Chat wording for a Chat', () => {
        expect(botSessionMarker(managed, 'handed-over', 'idle')).toBe('inputTakesBack');
        expect(botSessionMarker(managed, 'handed-over-chat', 'working')).toBe('chatInputTakesBack');
        expect(botSessionMarker(managed, 'created', 'waiting')).toBe('managed');
        expect(botSessionMarker(managed, 'own', 'idle')).toBe('none');
    });

    it('shows no marker once Caxri Bot has stopped, though the Sessions stay handed over', () => {
        expect(botSessionMarker(managed, 'created', 'stopped')).toBe('none');
        expect(botSessionMarker(managed, 'handed-over', undefined)).toBe('none');
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

describe('isBotManagedSessionsEvent', () => {
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
            expect(isBotManagedSessionsEvent(event)).toBe(expected);
    });
});

describe('inputTakeBackNotice', () => {
    it('names the Session typing took back and offers to hand it back', () => {
        expect(inputTakeBackNotice({ sessionId: 'session-1' }, 'Fix login', translate)).toEqual({
            message: 'Took Fix login back from Caxri Bot',
            action: { id: 'caxriBot.handBack', params: { sessionId: 'session-1' } },
        });
        expect(inputTakeBackNotice({ sessionId: 'session-2' }, undefined, translate)).toMatchObject(
            {
                message: 'Took a Session back from Caxri Bot',
                action: { params: { sessionId: 'session-2' } },
            },
        );
    });
});
