import { describe, expect, it } from 'vitest';

import { parseRelayedSessionMessage, relayedSessionMessage } from '../agent-session-contract';

describe('parseRelayedSessionMessage', () => {
    it('round-trips a message relayed from a named Session', () => {
        const message = relayedSessionMessage(' Fix login ', 'Please check\n\nthe tests');
        expect(parseRelayedSessionMessage(message)).toEqual({
            sourceTitle: 'Fix login',
            text: 'Please check\n\nthe tests',
        });
    });

    it('round-trips a message relayed from an unnamed Session', () => {
        expect(parseRelayedSessionMessage(relayedSessionMessage(undefined, 'Hi'))).toEqual({
            text: 'Hi',
        });
        expect(parseRelayedSessionMessage(relayedSessionMessage('  ', 'Hi'))).toEqual({
            text: 'Hi',
        });
    });

    it('ignores an ordinary message', () => {
        expect(parseRelayedSessionMessage('Relayed from Session "X"')).toBeUndefined();
        expect(parseRelayedSessionMessage('hello')).toBeUndefined();
    });
});
