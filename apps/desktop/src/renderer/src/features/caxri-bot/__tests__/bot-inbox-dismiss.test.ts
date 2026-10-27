import type { BotInboxItem } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    pushToast: vi.fn(),
    tryCommand: vi.fn(),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));
vi.mock('../../../stores/toasts', () => ({
    pushToast: mocks.pushToast,
    tryCommand: mocks.tryCommand,
}));
vi.mock('../../../stores/confirmations', () => ({ showConfirm: vi.fn() }));
vi.mock('../../../queries/client', () => ({
    caxriQueryKey: vi.fn(),
    queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock('../../../i18n', () => ({ translate: (key: string) => key }));

import {
    BOT_INBOX_DISMISS_UNDO_MS,
    botInboxUndoDismissUnavailableReason,
    dismissBotInboxItem,
    flushBotInboxDismissals,
    undoBotInboxDismissal,
} from '../bot-inbox-commands';
import { useBotInboxUiStore } from '../bot-inbox-store';

const item = { id: 'item-1', kind: 'decision' } as unknown as BotInboxItem;

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    mocks.request.mockReset().mockResolvedValue(undefined);
    mocks.pushToast.mockReset();
    mocks.tryCommand.mockReset().mockImplementation((_label, run: () => Promise<unknown>) => run());
});

afterEach(() => {
    flushBotInboxDismissals();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('dismissBotInboxItem', () => {
    it('hides the card and offers Undo without sending the request', () => {
        dismissBotInboxItem(item);

        expect(useBotInboxUiStore.getState().dismissingIds).toEqual({ 'item-1': true });
        expect(mocks.pushToast).toHaveBeenCalledWith(
            'info',
            'caxriBot.inboxCommands.dismissed',
            expect.objectContaining({
                action: { id: 'caxriBot.undoDismiss', params: { itemId: 'item-1' } },
            }),
        );
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('never sends the request when Undo is used inside the window', () => {
        dismissBotInboxItem(item);
        undoBotInboxDismissal('item-1');
        vi.advanceTimersByTime(BOT_INBOX_DISMISS_UNDO_MS * 2);

        expect(mocks.request).not.toHaveBeenCalled();
        expect(useBotInboxUiStore.getState().dismissingIds).toEqual({});
    });

    it('sends the request once the Undo window ends, then refuses a late Undo', async () => {
        dismissBotInboxItem(item);
        await vi.advanceTimersByTimeAsync(BOT_INBOX_DISMISS_UNDO_MS);

        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('bot.inbox.dismiss', {
            id: 'item-1',
        });
        expect(botInboxUndoDismissUnavailableReason('item-1')).toBe(
            'caxriBot.inboxCommands.dismissUndoExpired',
        );
        expect(useBotInboxUiStore.getState().dismissingIds).toEqual({});
    });

    it('sends a waiting dismissal immediately when the window closes', async () => {
        dismissBotInboxItem(item);
        flushBotInboxDismissals();
        await vi.advanceTimersByTimeAsync(BOT_INBOX_DISMISS_UNDO_MS);

        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('bot.inbox.dismiss', {
            id: 'item-1',
        });
    });

    it('ignores a second dismissal of the same item', () => {
        dismissBotInboxItem(item);
        dismissBotInboxItem(item);

        expect(mocks.pushToast).toHaveBeenCalledOnce();
    });
});
