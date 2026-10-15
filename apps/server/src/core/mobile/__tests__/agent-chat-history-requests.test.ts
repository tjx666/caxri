import type { AgentChatHistoryPage, AgentChatItem, AgentChatSnapshot } from '@caxri/protocol';
import { MOBILE_AGENT_CHAT_MAX_BYTES } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { isMobileAgentChatRead } from '../agent-chat-requests';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { chatSnapshot, domainFixture, invoke } from './agent-chat-requests.fixture';

const message = (id: string, text = id): AgentChatItem => ({
    id,
    type: 'agentMessage',
    text,
    streaming: false,
    turnId: `turn-${id}`,
});

const snapshotOf = (items: AgentChatItem[], isTruncated = false): AgentChatSnapshot => ({
    ...chatSnapshot('ready'),
    historyId: 'history-1',
    truncated: isTruncated,
    items,
    turns: items.map((item) => ({ id: item.turnId!, status: 'completed' as const })),
});

const readHistory = (beforeItemId: string, domain: ReturnType<typeof domainFixture>) =>
    invoke(
        {
            method: 'mobile.agentChat.readHistory',
            params: { terminalId: 'terminal-1', beforeItemId },
        },
        domain,
    ) as Promise<AgentChatHistoryPage>;

describe('mobile Agent Chat history', () => {
    it('pages the projection items older than the phone window before asking Core', async () => {
        const domain = domainFixture({
            surface: 'chat',
            snapshot: snapshotOf([message('a'), message('b'), message('c')], true),
        });
        const page = await readHistory('c', domain);
        expect(page).toEqual({
            historyId: 'history-1',
            items: [message('a'), message('b')],
            turns: [
                { id: 'turn-a', status: 'completed' },
                { id: 'turn-b', status: 'completed' },
            ],
            // The projection itself is truncated, so the archive or record holds more.
            hasMore: true,
            truncated: false,
        });
        expect(domain.request).not.toHaveBeenCalledWith('agentChat.readHistory', expect.anything());
    });

    it('reports no more history when the whole projection fits and nothing precedes it', async () => {
        const domain = domainFixture({
            surface: 'chat',
            snapshot: snapshotOf([message('a'), message('b')]),
        });
        expect(await readHistory('b', domain)).toMatchObject({
            items: [message('a')],
            hasMore: false,
        });
    });

    it('keeps the newest projection items that fit one frame and leaves the rest for the next page', async () => {
        const items = Array.from({ length: 30 }, (_, index) =>
            message(`m${index}`, 'x'.repeat(3_000)),
        );
        const domain = domainFixture({ surface: 'chat', snapshot: snapshotOf(items) });
        const page = await readHistory('m29', domain);
        expect(page.hasMore).toBe(true);
        expect(page.items.at(-1)?.id).toBe('m28');
        expect(page.items.length).toBeLessThan(29);
        expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(
            MOBILE_AGENT_CHAT_MAX_BYTES,
        );
    });

    it('forwards a cursor at the projection start or outside it to Core history paging', async () => {
        const history: AgentChatHistoryPage = {
            historyId: 'history-1',
            items: [
                {
                    id: 'old',
                    type: 'fileChange',
                    status: 'completed',
                    changes: [{ path: '/work/demo/src/old.ts', kind: 'update', diff: '' }],
                },
            ],
            turns: [],
            hasMore: false,
            truncated: true,
        };
        const domain = domainFixture({
            surface: 'chat',
            snapshot: snapshotOf([message('a'), message('b')]),
            history,
        });
        const fromStart = await readHistory('a', domain);
        const fromArchive = await readHistory('archived', domain);
        expect(domain.request).toHaveBeenCalledWith('agentChat.readHistory', {
            terminalId: 'terminal-1',
            beforeItemId: 'a',
        });
        expect(domain.request).toHaveBeenCalledWith('agentChat.readHistory', {
            terminalId: 'terminal-1',
            beforeItemId: 'archived',
        });
        // The page is clipped like the window, so changed files read relative to the Project.
        for (const page of [fromStart, fromArchive])
            expect(page).toMatchObject({
                items: [{ changes: [{ path: 'src/old.ts' }] }],
                hasMore: false,
                truncated: true,
            });
    });

    it('falls back to the original for a thumbnail of a message outside the projection', async () => {
        const domain = domainFixture({ surface: 'chat', original: 'T1JJRw==' });
        const result = await invoke(
            {
                method: 'mobile.agentChat.readImage',
                params: {
                    terminalId: 'terminal-1',
                    itemId: 'older-message',
                    index: 0,
                    variant: 'thumbnail',
                    chunkIndex: 0,
                },
            },
            domain,
        );
        expect(result).toMatchObject({ mediaType: 'image/png', data: 'T1JJRw==' });
    });

    it('is a read every paired role may call', () => {
        const request = {
            method: 'mobile.agentChat.readHistory',
            params: { terminalId: 'terminal-1', beforeItemId: 'a' },
        } as const;
        expect(isMobileAgentChatRead(request)).toBe(true);
        for (const role of ['view', 'reply', 'control'] as const)
            expect(isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.readHistory')).toBe(
                true,
            );
    });
});
