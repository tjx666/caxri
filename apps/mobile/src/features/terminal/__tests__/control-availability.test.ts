import { describe, expect, it } from 'vitest';

import {
    canUseTerminalControls,
    shouldObserveTerminal,
    terminalViewState,
} from '../control-availability';

describe('mobile Terminal controls', () => {
    it('keeps the last screen read-only without subscribing after the Terminal stops', () => {
        const admission = {
            isStopped: false,
            subscriptionAvailable: true,
            visible: true,
            webviewReady: true,
        };
        expect(shouldObserveTerminal(admission)).toBe(true);
        expect(shouldObserveTerminal({ ...admission, isStopped: true })).toBe(false);
        expect(terminalViewState('ready', true, true, true)).toBe('stopped');
        expect(terminalViewState('ready', false, false, true)).toBe('stale');
    });

    it('are available only to a live control-role subscription', () => {
        const input = {
            connected: true,
            generation: 4,
            hasSubscription: true,
            role: 'control' as const,
            state: 'ready' as const,
        };
        expect(canUseTerminalControls(input)).toBe(true);
        expect(canUseTerminalControls({ ...input, role: 'view' })).toBe(false);
        expect(canUseTerminalControls({ ...input, role: 'reply' })).toBe(false);
        expect(canUseTerminalControls({ ...input, connected: false })).toBe(false);
        expect(canUseTerminalControls({ ...input, state: 'stale' })).toBe(false);
        expect(canUseTerminalControls({ ...input, generation: null })).toBe(false);
        expect(canUseTerminalControls({ ...input, hasSubscription: false })).toBe(false);
    });
});
