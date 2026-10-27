import type { BotInboxItem, ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { AgentSystemNotification } from '../agent-notifications';
import {
    botInboxNotificationText,
    createBotInboxNotificationCoordinator,
} from '../bot-inbox-notifications';

function item(id: string, status: BotInboxItem['status'] = 'open'): BotInboxItem {
    return {
        id,
        kind: 'decision',
        status,
        title: `Item ${id}`,
        body: '',
    } as unknown as BotInboxItem;
}

const changed: ServerEvent = { event: 'botInbox.changed', payload: { itemIds: [] } };

function harness(initial: BotInboxItem[]) {
    let items = initial;
    let isEnabled = true;
    let isFocused = false;
    const shown: AgentSystemNotification[] = [];
    const clicks: Array<() => void> = [];
    const openInbox = vi.fn(() => Promise.resolve());
    const onDecision = vi.fn();
    const coordinator = createBotInboxNotificationCoordinator({
        isBotFocused: () => isFocused,
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
        setItems: (next: BotInboxItem[]) => (items = next),
        shown,
    };
}

describe('Bot Inbox notifications', () => {
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
                id: 'caxri-bot-inbox',
                groupId: 'caxri-bot-inbox',
                title: 'Caxri Bot needs your action',
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
            [{ itemCount: 1, outcome: 'botFocused' }],
            [{ itemCount: 1, outcome: 'disabled' }],
        ]);
    });

    it('collapses a burst into one count', () => {
        expect(botInboxNotificationText([item('a'), item('b')]).body).toBe(
            '2 new items in the Inbox',
        );
    });
});
