import { describe, expect, it, vi } from 'vitest';

import { announceServerReplacement, serverReplacementNotice } from '../stale-server-notice';

function notifier(overrides: Partial<Parameters<typeof announceServerReplacement>[1]> = {}) {
    return {
        isEnabled: vi.fn(() => Promise.resolve(true)),
        isSupported: () => true,
        show: vi.fn(),
        ...overrides,
    };
}

describe('serverReplacementNotice', () => {
    it('stays silent when no Terminal was stopped', () => {
        expect(serverReplacementNotice(0)).toBeUndefined();
    });

    it('words the singular and plural cases', () => {
        expect(serverReplacementNotice(1)?.body).not.toBe(serverReplacementNotice(3)?.body);
    });
});

describe('announceServerReplacement', () => {
    it('shows the notice when System notifications are enabled', async () => {
        const target = notifier();
        await announceServerReplacement(2, target);
        expect(target.show).toHaveBeenCalledOnce();
    });

    it('respects a disabled System notifications setting', async () => {
        const target = notifier({ isEnabled: () => Promise.resolve(false) });
        await announceServerReplacement(2, target);
        expect(target.show).not.toHaveBeenCalled();
    });

    it('shows the notice when the setting cannot be read', async () => {
        const target = notifier({
            isEnabled: () => Promise.reject(new Error('server down')),
        });
        await announceServerReplacement(2, target);
        expect(target.show).toHaveBeenCalledOnce();
    });

    it('does nothing when no Terminal stopped or notifications are unsupported', async () => {
        const none = notifier();
        await announceServerReplacement(0, none);
        const unsupported = notifier({ isSupported: () => false });
        await announceServerReplacement(2, unsupported);
        expect(none.show).not.toHaveBeenCalled();
        expect(unsupported.show).not.toHaveBeenCalled();
    });
});
