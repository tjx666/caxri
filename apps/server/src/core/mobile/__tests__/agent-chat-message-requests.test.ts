// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type { AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { chatSnapshot, domainFixture, invoke } from './agent-chat-requests.fixture';

const block = '# Files mentioned by the user:\n\n## a.ts: /tmp/a.ts\n\n## My request:\n';

const snapshot: AgentChatSnapshot = {
    ...chatSnapshot('ready'),
    items: [
        { id: 'user-ref', type: 'userMessage', turnId: 'turn-1', text: `${block}look here` },
        {
            id: 'reply',
            type: 'agentMessage',
            text: `${'a'.repeat(6_000)}\n\n**done**`,
            streaming: false,
        },
        {
            id: 'user-image',
            type: 'userMessage',
            turnId: 'turn-2',
            text: 'with a picture',
            images: [{}],
        },
        { id: 'long', type: 'agentMessage', text: 'y'.repeat(20_000), streaming: false },
        { id: 'huge', type: 'agentMessage', text: 'z'.repeat(300_000), streaming: false },
        {
            id: 'change',
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: '/work/demo/a.ts', kind: 'update', diff: '' }],
        },
    ],
};

describe('mobile Agent Chat message requests', () => {
    it("reads a message's whole text: a reply's Markdown source, a user message without its reference block", async () => {
        const domain = domainFixture({ surface: 'chat', snapshot });
        const read = (itemId: string) =>
            invoke(
                {
                    method: 'mobile.agentChat.readMessage',
                    params: { terminalId: 'terminal-1', itemId, offset: 0 },
                },
                domain,
            );
        await expect(read('user-ref')).resolves.toEqual({ text: 'look here', totalLength: 9 });
        await expect(read('reply')).resolves.toEqual({
            text: `${'a'.repeat(6_000)}\n\n**done**`,
            totalLength: 6_010,
        });
        await expect(read('huge')).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(read('change')).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(read('gone')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('reads a message over the 16 KiB send limit in slices that join to the original', async () => {
        const domain = domainFixture({ surface: 'chat', snapshot });
        const read = (offset: number) =>
            invoke(
                {
                    method: 'mobile.agentChat.readMessage',
                    params: { terminalId: 'terminal-1', itemId: 'long', offset },
                },
                domain,
            ) as Promise<{ text: string; totalLength: number; nextOffset?: number }>;
        const first = await read(0);
        expect(first).toMatchObject({ totalLength: 20_000, nextOffset: 16_000 });
        const second = await read(first.nextOffset ?? 0);
        expect(second.nextOffset).toBeUndefined();
        expect(first.text + second.text).toBe('y'.repeat(20_000));
        await expect(read(20_001)).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('rewinds to a user message with only the conversation, putting its reference block back', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const domain = domainFixture({ surface: 'chat', snapshot });
        await invoke(
            {
                method: 'mobile.agentChat.rewind',
                params: { terminalId: 'terminal-1', itemId: 'user-ref', text: 'look there' },
            },
            domain,
            forward,
        );
        expect(forward).toHaveBeenCalledWith({
            method: 'agentChat.rewind',
            params: {
                terminalId: 'terminal-1',
                itemId: 'user-ref',
                restoreFiles: false,
                text: `${block}look there`,
            },
        });
    });

    it('refuses to rewind to a message with images, a reply, or one no longer in the Chat', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const domain = domainFixture({ surface: 'chat', snapshot });
        await Promise.all(
            ['user-image', 'reply', 'gone'].map((itemId) =>
                expect(
                    invoke(
                        {
                            method: 'mobile.agentChat.rewind',
                            params: { terminalId: 'terminal-1', itemId, text: 'again' },
                        },
                        domain,
                        forward,
                    ),
                ).rejects.toMatchObject({ code: 'CONFLICT' }),
            ),
        );
        expect(forward).not.toHaveBeenCalled();
    });

    it('lets every role read a message and only sending roles rewind', () => {
        expect(
            (['view', 'reply', 'control'] as const).map((role) => [
                isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.readMessage'),
                isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.rewind'),
            ]),
        ).toEqual([
            [true, false],
            [true, true],
            [true, true],
        ]);
    });
});
