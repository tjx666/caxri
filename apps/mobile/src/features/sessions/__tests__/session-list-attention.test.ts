import { describe, expect, it } from 'vitest';

import {
    sessionListAttentionSource,
    shouldListFallbackToTerminal,
} from '../session-list-attention';

type Terminal = NonNullable<Parameters<typeof sessionListAttentionSource>[0]['primaryTerminal']>;

const session = (terminal: Partial<Terminal> | undefined) => ({
    primaryTerminal: terminal as Terminal | undefined,
});

describe('session list attention', () => {
    it('reads a Chat Session through its Chat and never points it at a Terminal', () => {
        for (const provider of ['codex', 'grok', 'claude'] as const) {
            const chat = session({ provider, surface: 'chat' });
            expect(sessionListAttentionSource(chat)).toBe('chat');
            expect(shouldListFallbackToTerminal(chat)).toBe(false);
        }
    });

    it('keeps the Terminal fallback for non-Claude PTY Sessions only', () => {
        expect(shouldListFallbackToTerminal(session({ provider: 'codex' }))).toBe(true);
        expect(shouldListFallbackToTerminal(session({ provider: 'claude' }))).toBe(false);
        expect(sessionListAttentionSource(session(undefined))).toBe('terminal');
    });
});
