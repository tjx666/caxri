import type { TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../session/session-commands', () => ({ didSelectSession: vi.fn() }));

import { chooseShareTarget } from './share-to-session';

function terminal(id: string, createdAt: number, isChat: boolean): TerminalRecord {
    return {
        id,
        sessionId: 'session-1',
        createdAt,
        orderIndex: 0,
        ...(isChat && { surface: 'chat' }),
    } as unknown as TerminalRecord;
}

describe('chooseShareTarget', () => {
    it('prefers an Agent Chat over a newer Terminal', () => {
        const chat = terminal('chat', 1, true);
        const shell = terminal('shell', 2, false);

        expect(chooseShareTarget([shell, chat], 'session-1', undefined)).toBe(chat);
    });

    it('falls back to a Terminal when the Session has no Chat', () => {
        const shell = terminal('shell', 2, false);

        expect(chooseShareTarget([shell], 'session-1', undefined)).toBe(shell);
    });

    it('finds nothing in another Session', () => {
        expect(
            chooseShareTarget([terminal('chat', 1, true)], 'session-2', undefined),
        ).toBeUndefined();
    });
});
