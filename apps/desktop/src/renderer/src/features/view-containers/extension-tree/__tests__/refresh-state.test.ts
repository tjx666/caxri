import { describe, expect, it } from 'vitest';

import { isMessageRefreshAction, reconcilePendingTreeRefresh } from '../refresh-state';

describe('extension tree refresh state', () => {
    it('shares the header refresh lifecycle only with an argument-free message action', () => {
        const refreshAction = {
            commandId: 'publisher.fixture.refresh',
            role: 'resource.refresh' as const,
        };
        const message = {
            accessibilityLabel: 'Refresh fixture',
            collapsibleState: 'none' as const,
            command: { id: refreshAction.commandId, title: 'Refresh' },
            handle: 'message',
            label: 'Fixture unavailable',
            variant: 'message' as const,
        };

        expect(isMessageRefreshAction(message, refreshAction)).toBe(true);
        expect(isMessageRefreshAction({ ...message, variant: undefined }, refreshAction)).toBe(
            false,
        );
        expect(
            isMessageRefreshAction(
                { ...message, command: { ...message.command, arguments: ['force'] } },
                refreshAction,
            ),
        ).toBe(false);
        expect(
            isMessageRefreshAction(message, {
                ...refreshAction,
                commandId: 'publisher.fixture.other',
            }),
        ).toBe(false);
    });

    it('ignores an older root completion and waits for the next root load', () => {
        const pending = { afterRootLoad: 2, id: 'manual-refresh' };

        expect(reconcilePendingTreeRefresh(pending, { started: 2, completed: 2 })).toBe(pending);
        expect(reconcilePendingTreeRefresh(pending, { started: 3, completed: 2 })).toEqual({
            ...pending,
            targetRootLoad: 3,
        });
        expect(reconcilePendingTreeRefresh(pending, { started: 3, completed: 3 })).toBeUndefined();
        expect(reconcilePendingTreeRefresh(pending, { started: 4, completed: 3 })).toBeUndefined();
    });
});
