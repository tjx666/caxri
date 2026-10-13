import type { CommanderInboxItem, ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentSystemNotification } from '../agent-notifications';
import {
    commanderInboxNotificationText,
    createCommanderInboxNotificationCoordinator,
} from '../commander-inbox-notifications';

function item(id: string, status: CommanderInboxItem['status'] = 'open'): CommanderInboxItem {
    return {
        id,
        kind: 'decision',
        status,
        title: `Item ${id}`,
        body: '',
    } as unknown as CommanderInboxItem;
}

const changed: ServerEvent = { event: 'commanderInbox.changed', payload: { itemIds: [] } };

function harness(initial: CommanderInboxItem[]) {
    let items = initial;
    let isEnabled = true;
    let isFocused = false;
    const shown: AgentSystemNotification[] = [];
    const clicks: Array<() => void> = [];
    const openInbox = vi.fn(() => Promise.resolve());
    const onDecision = vi.fn();
    const coordinator = createCommanderInboxNotificationCoordinator({
        isCommanderFocused: () => isFocused,
        loadInbox: () => Promise.resolve(items),
        loadSettings: () => Promise.resolve({ 'agents.notifications.enabled': isEnabled }),
        onDecision,
        openInbox,
        showNotification: (notification, onClick) => {
            shown.push(notification);
            clicks.push(onClick);
            return { close: vi.fn() };
        },
    });
    return {
        clicks,
        coordinator,
        onDecision,
        openInbox,
        setEnabled: (isNext: boolean) => (isEnabled = isNext),
        setFocused: (isNext: boolean) => (isFocused = isNext),
        setItems: (next: CommanderInboxItem[]) => (items = next),
        shown,
    };
}

describe('Commander Inbox notifications', () => {
    it('does not replay items already open at launch', async () => {
        const test = harness([item('a')]);
        await test.coordinator.initialize();
        test.coordinator.observe(changed);
        await test.coordinator.flush();

        expect(test.shown).toEqual([]);
    });

    it('notifies for a newly opened item and opens the Inbox on click', async () => {
        const test = harness([item('a')]);
        await test.coordinator.initialize();
        test.setItems([item('a'), item('b'), item('c', 'closed')]);
        test.coordinator.observe(changed);
        await test.coordinator.flush();

        expect(test.shown).toEqual([
            {
                id: 'caxri-commander-inbox',
                groupId: 'caxri-commander-inbox',
                title: 'Commander needs your action',
                body: 'Item b',
            },
        ]);
        test.clicks[0]?.();
        await test.coordinator.flush();
        expect(test.openInbox).toHaveBeenCalledOnce();
    });

    it('records why a new item stayed silent', async () => {
        const test = harness([]);
        await test.coordinator.initialize();
        test.setFocused(true);
        test.setItems([item('a')]);
        test.coordinator.observe(changed);
        await test.coordinator.flush();
        test.setEnabled(false);
        test.setItems([item('a'), item('b')]);
        test.coordinator.observe(changed);
        await test.coordinator.flush();

        expect(test.shown).toEqual([]);
        expect(test.onDecision.mock.calls).toEqual([
            [{ itemCount: 1, outcome: 'commanderFocused' }],
            [{ itemCount: 1, outcome: 'disabled' }],
        ]);
    });

    it('collapses a burst into one count', () => {
        expect(commanderInboxNotificationText([item('a'), item('b')]).body).toBe(
            '2 new items in the Inbox',
        );
    });
});
