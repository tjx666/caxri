import { describe, expect, it, vi } from 'vitest';

import {
    COMMANDER_INBOX_DEFAULT_WIDTH,
    COMMANDER_INBOX_MAX_WIDTH,
    COMMANDER_INBOX_MIN_WIDTH,
    commanderInboxWidth,
    runCommanderInboxAction,
    useCommanderInboxUiStore,
} from '../commander-inbox-store';

describe('commanderInboxWidth', () => {
    it('restores a stored width inside the bounds', () => {
        expect(commanderInboxWidth('400')).toBe(400);
    });

    it('falls back to the default for a missing or malformed value', () => {
        expect(commanderInboxWidth(null)).toBe(COMMANDER_INBOX_DEFAULT_WIDTH);
        expect(commanderInboxWidth('wide')).toBe(COMMANDER_INBOX_DEFAULT_WIDTH);
    });

    it('clamps a width from an older bound back into range', () => {
        expect(commanderInboxWidth('90')).toBe(COMMANDER_INBOX_MIN_WIDTH);
        expect(commanderInboxWidth('2000')).toBe(COMMANDER_INBOX_MAX_WIDTH);
    });
});

describe('runCommanderInboxAction', () => {
    it('marks the item pending while the request runs and clears it when it settles', async () => {
        const request = Promise.withResolvers<string>();
        const pending = runCommanderInboxAction('item-1', 'merge', () => request.promise);
        expect(useCommanderInboxUiStore.getState().pendingActions).toEqual({ 'item-1': 'merge' });
        request.resolve('merged');
        await expect(pending).resolves.toBe('merged');
        expect(useCommanderInboxUiStore.getState().pendingActions).toEqual({});
    });

    it('drops a second request for an item already in flight', async () => {
        const request = Promise.withResolvers<void>();
        const first = runCommanderInboxAction('item-1', 'answer', () => request.promise);
        const second = vi.fn(() => Promise.resolve('again'));
        await expect(runCommanderInboxAction('item-1', 'answer', second)).resolves.toBeUndefined();
        expect(second).not.toHaveBeenCalled();
        request.resolve();
        await first;
    });

    it('clears the pending mark when the request fails', async () => {
        await expect(
            runCommanderInboxAction('item-2', 'merge', () => Promise.reject(new Error('boom'))),
        ).rejects.toThrow('boom');
        expect(useCommanderInboxUiStore.getState().pendingActions).toEqual({});
    });
});
