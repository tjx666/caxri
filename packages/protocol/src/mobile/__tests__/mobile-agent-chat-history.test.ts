import { describe, expect, it } from 'vitest';

import type { AgentChatHistoryPage, AgentChatItem } from '../../agent/agent-chat-contract.js';
import { agentChatHistoryPageSchema } from '../../agent/agent-chat-contract.js';
import {
    MOBILE_AGENT_CHAT_CLIP_MARKER,
    MOBILE_AGENT_CHAT_MAX_BYTES,
    mobileAgentChatMethods,
    windowAgentChatHistoryPageForMobile,
} from '../mobile-contract.js';

const message = (id: string, text: string, turnId = `turn-${id}`): AgentChatItem => ({
    id,
    turnId,
    type: 'agentMessage',
    text,
    streaming: false,
});

const pageOf = (
    items: AgentChatItem[],
    options: Partial<Pick<AgentChatHistoryPage, 'hasMore' | 'truncated'>> = {},
): AgentChatHistoryPage => ({
    historyId: 'history-1',
    items,
    turns: items.map((item) => ({ id: item.turnId!, status: 'completed' as const })),
    hasMore: options.hasMore ?? false,
    truncated: options.truncated ?? false,
});

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe('windowAgentChatHistoryPageForMobile', () => {
    it('passes a small page through unchanged', () => {
        const page = pageOf([message('a', 'one'), message('b', 'two')], { truncated: true });
        expect(windowAgentChatHistoryPageForMobile(page)).toEqual(page);
    });

    it('clips each item like the window and names changed files relative to the Project', () => {
        const page = pageOf([
            message('a', 'x'.repeat(20_000)),
            {
                id: 'b',
                type: 'fileChange',
                status: 'completed',
                changes: [{ path: '/work/demo/src/a.ts', kind: 'update', diff: '' }],
            },
        ]);
        const windowed = windowAgentChatHistoryPageForMobile(page, '/work/demo');
        expect(
            (windowed.items[0] as { text: string }).text.startsWith(MOBILE_AGENT_CHAT_CLIP_MARKER),
        ).toBe(true);
        expect(windowed.items[1]).toMatchObject({ changes: [{ path: 'src/a.ts' }] });
    });

    it('keeps the newest items that fit one frame, their turns, and marks the rest as more to load', () => {
        const items = Array.from({ length: 40 }, (_, index) =>
            message(`m${index}`, 'x'.repeat(3_000)),
        );
        const windowed = windowAgentChatHistoryPageForMobile(pageOf(items));
        expect(windowed.hasMore).toBe(true);
        expect(windowed.items.at(-1)?.id).toBe('m39');
        expect(windowed.items.length).toBeLessThan(40);
        expect(windowed.turns.map((turn) => turn.id)).toEqual(
            windowed.items.map((item) => item.turnId),
        );
        expect(bytes(windowed)).toBeLessThanOrEqual(MOBILE_AGENT_CHAT_MAX_BYTES);
        expect(agentChatHistoryPageSchema.safeParse(windowed).success).toBe(true);
    });

    it('keeps the source page hasMore and truncated when nothing is dropped', () => {
        const page = pageOf([message('a', 'one')], { hasMore: true });
        expect(windowAgentChatHistoryPageForMobile(page)).toMatchObject({
            hasMore: true,
            truncated: false,
        });
    });

    it('accepts a history cursor through the mobile method', () => {
        const parameters = mobileAgentChatMethods['mobile.agentChat.readHistory'].params;
        expect(parameters.safeParse({ terminalId: 'terminal-1', beforeItemId: 'a' }).success).toBe(
            true,
        );
        expect(parameters.safeParse({ terminalId: 'terminal-1', beforeItemId: '' }).success).toBe(
            false,
        );
    });
});
