import { describe, expect, it, vi } from 'vitest';

import {
    BOT_INBOX_DEFAULT_WIDTH,
    BOT_INBOX_MAX_WIDTH,
    BOT_INBOX_MIN_WIDTH,
    botInboxWidth,
    revealBotInbox,
    runBotInboxAction,
    setBotInboxVisible,
    settleBotInboxFocusRequest,
    useBotInboxUiStore,
} from '../bot-inbox-store';

describe('botInboxWidth', () => {
    it('restores a stored width inside the bounds', () => {
        expect(botInboxWidth('400')).toBe(400);
    });

    it('falls back to the default for a missing or malformed value', () => {
        expect(botInboxWidth(null)).toBe(BOT_INBOX_DEFAULT_WIDTH);
        expect(botInboxWidth('wide')).toBe(BOT_INBOX_DEFAULT_WIDTH);
    });

    it('clamps a width from an older bound back into range', () => {
        expect(botInboxWidth('90')).toBe(BOT_INBOX_MIN_WIDTH);
        expect(botInboxWidth('2000')).toBe(BOT_INBOX_MAX_WIDTH);
    });
});

describe('runBotInboxAction', () => {
    it('marks the item pending while the request runs and clears it when it settles', async () => {
        const request = Promise.withResolvers<string>();
        const pending = runBotInboxAction('item-1', 'merge', () => request.promise);
        expect(useBotInboxUiStore.getState().pendingActions).toEqual({ 'item-1': 'merge' });
        request.resolve('merged');
        await expect(pending).resolves.toBe('merged');
        expect(useBotInboxUiStore.getState().pendingActions).toEqual({});
    });

    it('drops a second request for an item already in flight', async () => {
        const request = Promise.withResolvers<void>();
        const first = runBotInboxAction('item-1', 'answer', () => request.promise);
        const second = vi.fn(() => Promise.resolve('again'));
        await expect(runBotInboxAction('item-1', 'answer', second)).resolves.toBeUndefined();
        expect(second).not.toHaveBeenCalled();
        request.resolve();
        await first;
    });

    it('clears the pending mark when the request fails', async () => {
        await expect(
            runBotInboxAction('item-2', 'merge', () => Promise.reject(new Error('boom'))),
        ).rejects.toThrow('boom');
        expect(useBotInboxUiStore.getState().pendingActions).toEqual({});
    });
});

describe('revealBotInbox', () => {
    it('opens a hidden Inbox and requests focus until the list settles it', () => {
        setBotInboxVisible(false);

        revealBotInbox();

        expect(useBotInboxUiStore.getState()).toMatchObject({
            isVisible: true,
            isFocusRequested: true,
        });
        settleBotInboxFocusRequest();
        expect(useBotInboxUiStore.getState().isFocusRequested).toBe(false);
    });
});
