import type { CommanderInboxItem } from '@caxri/protocol';
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
    COMMANDER_INBOX_DISMISS_UNDO_MS,
    commanderInboxUndoDismissUnavailableReason,
    dismissCommanderInboxItem,
    flushCommanderInboxDismissals,
    undoCommanderInboxDismissal,
} from '../commander-inbox-commands';
import { useCommanderInboxUiStore } from '../commander-inbox-store';

const item = { id: 'item-1', kind: 'decision' } as unknown as CommanderInboxItem;

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    mocks.request.mockReset().mockResolvedValue(undefined);
    mocks.pushToast.mockReset();
    mocks.tryCommand.mockReset().mockImplementation((_label, run: () => Promise<unknown>) => run());
});

afterEach(() => {
    flushCommanderInboxDismissals();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('dismissCommanderInboxItem', () => {
    it('hides the card and offers Undo without sending the request', () => {
        dismissCommanderInboxItem(item);

        expect(useCommanderInboxUiStore.getState().dismissingIds).toEqual({ 'item-1': true });
        expect(mocks.pushToast).toHaveBeenCalledWith(
            'info',
            'agentCommander.inboxCommands.dismissed',
            expect.objectContaining({
                action: { id: 'agentCommander.undoDismiss', params: { itemId: 'item-1' } },
            }),
        );
        expect(mocks.request).not.toHaveBeenCalled();
    });

    it('never sends the request when Undo is used inside the window', () => {
        dismissCommanderInboxItem(item);
        undoCommanderInboxDismissal('item-1');
        vi.advanceTimersByTime(COMMANDER_INBOX_DISMISS_UNDO_MS * 2);

        expect(mocks.request).not.toHaveBeenCalled();
        expect(useCommanderInboxUiStore.getState().dismissingIds).toEqual({});
    });

    it('sends the request once the Undo window ends, then refuses a late Undo', async () => {
        dismissCommanderInboxItem(item);
        await vi.advanceTimersByTimeAsync(COMMANDER_INBOX_DISMISS_UNDO_MS);

        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('commander.inbox.dismiss', {
            id: 'item-1',
        });
        expect(commanderInboxUndoDismissUnavailableReason('item-1')).toBe(
            'agentCommander.inboxCommands.dismissUndoExpired',
        );
        expect(useCommanderInboxUiStore.getState().dismissingIds).toEqual({});
    });

    it('sends a waiting dismissal immediately when the window closes', async () => {
        dismissCommanderInboxItem(item);
        flushCommanderInboxDismissals();
        await vi.advanceTimersByTimeAsync(COMMANDER_INBOX_DISMISS_UNDO_MS);

        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('commander.inbox.dismiss', {
            id: 'item-1',
        });
    });

    it('ignores a second dismissal of the same item', () => {
        dismissCommanderInboxItem(item);
        dismissCommanderInboxItem(item);

        expect(mocks.pushToast).toHaveBeenCalledOnce();
    });
});
