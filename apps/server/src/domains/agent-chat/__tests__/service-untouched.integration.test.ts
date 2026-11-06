import { describe, expect, it } from 'vitest';

import { fixture } from './chat-service-fixture';

describe('Agent Chat untouched state', () => {
    it('reads a new ready Chat as untouched until its first message, and a reloaded one as unknown', async () => {
        const chat = await fixture();
        await chat.until((snapshot) => snapshot.status === 'ready');
        expect(chat.service.states.isUntouched(chat.terminal.id)).toBe(true);

        const sending = chat.service.send(chat.terminal.id, { text: 'hi there' });
        // Input still in flight already counts, before any row reaches the projection.
        expect(chat.service.states.isUntouched(chat.terminal.id)).toBe(false);
        await sending;
        await chat.until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        expect(chat.service.states.isUntouched(chat.terminal.id)).toBe(false);

        const restarted = await chat.restartServer();
        expect(restarted.states.isUntouched(chat.terminal.id)).toBe(false);
    });
});
