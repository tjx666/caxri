import type {
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    ServerEvent,
} from '@caxri/protocol';
import {
    applyAgentChatPatch,
    emptyAgentChatSnapshot,
    MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS,
    MAX_AGENT_CHAT_ITEMS,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import { readChatHistoryPage } from '../chat-history';
import { ChatProjection } from '../chat-projection';

const logger = { write: () => {} } as unknown as StructuredLogger;

function message(index: number): AgentChatItem {
    return { id: `m${index}`, turnId: `t${index}`, type: 'userMessage', text: `Message ${index}` };
}

function projection(): { projection: ChatProjection; events: ServerEvent[] } {
    const events: ServerEvent[] = [];
    return {
        events,
        projection: new ChatProjection({
            terminalId: 'terminal-1',
            revision: 0,
            taskRevisionFloors: new Map(),
            logger,
            send: (event) => events.push(event),
            onChange: () => {},
        }),
    };
}

/**
 * What a Client mirroring the projection holds after every patch it was sent.
 */
function mirror(events: readonly ServerEvent[]): AgentChatSnapshot {
    let snapshot: AgentChatSnapshot | undefined = emptyAgentChatSnapshot('terminal-1');
    for (const event of events)
        if (event.event === 'agentChat.patch')
            snapshot = applyAgentChatPatch(snapshot!, event.payload);
    return snapshot!;
}

/**
 * Pages back from the projection's first item until the history ends.
 */
async function pageAll(chat: ChatProjection): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor = chat.snapshot.items[0].id;
    let pages = 0;
    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- each page's cursor is the previous page's oldest item
        const page = await readChatHistoryPage({} as never, chat, cursor);
        pages += 1;
        expect(page.historyId).toBe(chat.snapshot.historyId);
        expect(page.truncated).toBe(false);
        ids.unshift(...page.items.map((item) => item.id));
        if (!page.hasMore) return { ids, pages };
        cursor = page.items[0].id;
    }
}

describe('Chat history archive', () => {
    it('keeps the items a live conversation evicts and pages back through them', async () => {
        const { projection: chat } = projection();
        const total = MAX_AGENT_CHAT_ITEMS + 250;
        for (let index = 0; index < total; index += 1)
            chat.apply([{ op: 'upsertItem', item: message(index) }]);
        expect(chat.snapshot.items).toHaveLength(MAX_AGENT_CHAT_ITEMS);
        expect(chat.snapshot.truncated).toBe(true);
        const { ids, pages } = await pageAll(chat);
        expect(pages).toBe(Math.ceil(250 / MAX_AGENT_CHAT_HISTORY_PAGE_ITEMS));
        expect(ids).toEqual(Array.from({ length: 250 }, (_, index) => `m${index}`));
    });

    it('sends a resumed history as only the part the projection keeps, with its turns', async () => {
        const { projection: chat, events } = projection();
        const total = MAX_AGENT_CHAT_ITEMS + 1500;
        const operations: AgentChatPatchOperation[] = [{ op: 'reset' }];
        for (let index = 0; index < total; index += 1)
            operations.push({ op: 'upsertItem', item: message(index) });
        operations.push({
            op: 'state',
            state: {
                turns: Array.from({ length: total }, (_, index) => ({
                    id: `t${index}`,
                    status: 'completed' as const,
                })),
                truncated: false,
            },
        });
        chat.apply(operations);
        chat.flush();
        const sent = events.flatMap((event) =>
            event.event === 'agentChat.patch' ? event.payload.operations : [],
        );
        expect(sent.filter((operation) => operation.op === 'upsertItem')).toHaveLength(
            MAX_AGENT_CHAT_ITEMS,
        );
        const client = mirror(events);
        expect(client.items).toEqual(chat.snapshot.items);
        expect(client.turns).toEqual(chat.snapshot.turns);
        expect(client.turns).toHaveLength(MAX_AGENT_CHAT_ITEMS);
        expect(client.truncated).toBe(true);
        expect(client.historyId).toBe(chat.snapshot.historyId);

        const { ids } = await pageAll(chat);
        expect(ids).toEqual(Array.from({ length: 1500 }, (_, index) => `m${index}`));
        const first = await readChatHistoryPage({} as never, chat, chat.snapshot.items[0].id);
        // Archived items keep the turns the provider reported after evicting them.
        expect(first.turns.map((turn) => turn.id)).toEqual(first.items.map((item) => item.turnId));
    });

    it('starts a new history on reset, so older pages of the previous one are not stitched to it', async () => {
        const { projection: chat } = projection();
        for (let index = 0; index < MAX_AGENT_CHAT_ITEMS + 10; index += 1)
            chat.apply([{ op: 'upsertItem', item: message(index) }]);
        const previous = chat.snapshot.historyId;
        chat.apply([{ op: 'reset' }, { op: 'upsertItem', item: message(0) }]);
        expect(chat.snapshot.historyId).not.toBe(previous);
        expect(chat.snapshot.truncated).toBe(false);
        expect(await readChatHistoryPage({} as never, chat, 'm0')).toEqual({
            historyId: chat.snapshot.historyId,
            items: [],
            turns: [],
            hasMore: false,
            truncated: false,
        });
    });
});
