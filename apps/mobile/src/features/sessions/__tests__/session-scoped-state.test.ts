import { describe, expect, it } from 'vitest';

import type { SessionScoped } from '../session-scoped-state';
import { patchSessionScoped, readSessionScoped } from '../session-scoped-state';

interface Switch {
    error: string | null;
    pending: 'chat' | 'pty' | null;
}

const IDLE: Switch = { error: null, pending: null };

describe('session scoped state', () => {
    it('keeps a switch started on Session A off Session B', () => {
        let states: SessionScoped<Switch> = {};
        states = patchSessionScoped(states, 'a', IDLE, { pending: 'pty' });
        expect(readSessionScoped(states, 'a', IDLE).pending).toBe('pty');
        expect(readSessionScoped(states, 'b', IDLE)).toBe(IDLE);
    });

    it('shows a failure on the Session that raised it, including after returning to it', () => {
        let states: SessionScoped<Switch> = {};
        states = patchSessionScoped(states, 'a', IDLE, { pending: 'pty' });
        states = patchSessionScoped(states, 'a', IDLE, { error: 'failed', pending: null });
        expect(readSessionScoped(states, 'b', IDLE).error).toBeNull();
        expect(readSessionScoped(states, 'a', IDLE)).toEqual({ error: 'failed', pending: null });
    });

    it('lets Session B switch while A is still pending', () => {
        let states: SessionScoped<Switch> = {};
        states = patchSessionScoped(states, 'a', IDLE, { pending: 'pty' });
        states = patchSessionScoped(states, 'b', IDLE, { pending: 'chat' });
        states = patchSessionScoped(states, 'b', IDLE, { pending: null });
        expect(readSessionScoped(states, 'a', IDLE).pending).toBe('pty');
    });
});
