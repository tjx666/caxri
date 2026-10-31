// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type { AgentChatSnapshot } from '@caxri/protocol';
import {
    agentChatTextWithPathReferences,
    MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH,
} from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { invokeMobileAgentChatRequest } from '../agent-chat-requests';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { chatSnapshot, domainFixture, invoke, principal } from './agent-chat-requests.fixture';

describe('mobile Agent Chat requests', () => {
    it('refuses a PTY Terminal so a phone never drives one through the Chat methods', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        await expect(
            invoke(
                {
                    method: 'mobile.agentChat.send',
                    params: { terminalId: 'terminal-1', text: 'hi' },
                },
                domainFixture({}),
                forward,
            ),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(forward).not.toHaveBeenCalled();
    });

    it('refuses a Terminal outside the device grant', async () => {
        await expect(
            invoke(
                { method: 'mobile.agentChat.read', params: { terminalId: 'terminal-1' } },
                domainFixture({ surface: 'chat', terminals: 0 }),
            ),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('returns the frame-sized window of the Chat projection', async () => {
        const result = (await invoke(
            { method: 'mobile.agentChat.read', params: { terminalId: 'terminal-1' } },
            domainFixture({ surface: 'chat' }),
        )) as AgentChatSnapshot;
        expect(result.revision).toBe(3);
        const item = result.items[0] as { text: string };
        expect(item.text.length).toBeLessThan(20_000);
        // The phone never learns the Project root, so the Server names files relative to it.
        expect(result.items[1]).toMatchObject({ changes: [{ path: 'src/greeting.ts' }] });
    });

    it('forwards send, respond, and interrupt through Core admission', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const domain = domainFixture({ surface: 'chat' });
        await invoke(
            { method: 'mobile.agentChat.send', params: { terminalId: 'terminal-1', text: 'hi' } },
            domain,
            forward,
        );
        await invoke(
            {
                method: 'mobile.agentChat.respond',
                params: {
                    terminalId: 'terminal-1',
                    requestId: 'request-1',
                    response: { kind: 'decision', decision: 'accept' },
                },
            },
            domain,
            forward,
        );
        await invoke(
            { method: 'mobile.agentChat.interrupt', params: { terminalId: 'terminal-1' } },
            domain,
            forward,
        );
        expect(forward.mock.calls.map(([operation]) => operation)).toEqual([
            {
                method: 'agentChat.send',
                params: { terminalId: 'terminal-1', text: 'hi' },
            },
            {
                method: 'agentChat.respond',
                params: {
                    terminalId: 'terminal-1',
                    requestId: 'request-1',
                    response: { kind: 'decision', decision: 'accept' },
                },
            },
            { method: 'agentChat.interrupt', params: { terminalId: 'terminal-1' } },
        ]);
    });

    it('sends uploaded images with their thumbnails, read under the Chat Session for this device', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const domain = domainFixture({ surface: 'chat' });
        const attachment = {
            attachmentId: `image_${'a'.repeat(32)}`,
            thumbnailAttachmentId: `image_${'b'.repeat(32)}`,
        };
        await invoke(
            {
                method: 'mobile.agentChat.send',
                params: { terminalId: 'terminal-1', text: '', attachments: [attachment] },
            },
            domain,
            forward,
        );
        expect(domain.request).toHaveBeenCalledWith('mobile.image.readInternal', {
            sessionId: 'session-1',
            attachmentIds: [attachment.attachmentId, attachment.thumbnailAttachmentId],
            principal,
        });
        expect(forward).toHaveBeenCalledWith({
            method: 'agentChat.send',
            params: {
                terminalId: 'terminal-1',
                text: '',
                images: [
                    {
                        mediaType: 'image/jpeg',
                        data: 'T1JJRw==',
                        thumbnail: 'data:image/jpeg;base64,VEhVTUI=',
                    },
                ],
            },
        });
    });

    it('sends a message citing its uploaded files, and refuses one that leaves a file out', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const domain = domainFixture({ surface: 'chat' });
        const files = [`file_${'c'.repeat(32)}`, `file_${'d'.repeat(32)}`];
        const text = agentChatTextWithPathReferences(
            'Summarize these',
            [
                { path: '/tmp/uploads/file_1/clip.mov', isDirectory: false },
                { path: '/tmp/uploads/file_2/notes.pdf', isDirectory: false },
            ],
            'Codex',
        );
        await invoke(
            { method: 'mobile.agentChat.send', params: { terminalId: 'terminal-1', text, files } },
            domain,
            forward,
        );
        expect(domain.request).toHaveBeenCalledWith('mobile.file.pathsInternal', {
            sessionId: 'session-1',
            attachmentIds: files,
            principal,
        });
        expect(forward).toHaveBeenCalledWith({
            method: 'agentChat.send',
            params: { terminalId: 'terminal-1', text },
        });
        await expect(
            invoke(
                {
                    method: 'mobile.agentChat.send',
                    params: { terminalId: 'terminal-1', text: 'Summarize these', files },
                },
                domain,
                forward,
            ),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(forward).toHaveBeenCalledTimes(1);
        // Files sent with no words: the gateway's schema trims the text, which must still cite them.
        await invoke(
            {
                method: 'mobile.agentChat.send',
                params: {
                    terminalId: 'terminal-1',
                    text: agentChatTextWithPathReferences(
                        '',
                        [
                            { path: '/tmp/uploads/file_1/clip.mov', isDirectory: false },
                            { path: '/tmp/uploads/file_2/notes.pdf', isDirectory: false },
                        ],
                        'Claude Code',
                    ).trim(),
                    files,
                },
            },
            domain,
            forward,
        );
        expect(forward).toHaveBeenCalledTimes(2);
    });

    it('reads a thumbnail the window left out, and pages an original in frame-sized chunks', async () => {
        const snapshot = chatSnapshot('ready');
        snapshot.items = [
            {
                id: 'message-1',
                type: 'userMessage',
                text: '',
                images: [{ thumbnail: 'data:image/webp;base64,V0VCUA==' }, {}],
            },
        ];
        const domain = domainFixture({
            surface: 'chat',
            snapshot,
            original: 'A'.repeat(MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH + 8),
        });
        const read = (variant: 'thumbnail' | 'original', index: number, chunkIndex = 0) =>
            invoke(
                {
                    method: 'mobile.agentChat.readImage',
                    params: {
                        terminalId: 'terminal-1',
                        itemId: 'message-1',
                        index,
                        variant,
                        chunkIndex,
                    },
                },
                domain,
            );
        expect(await read('thumbnail', 0)).toEqual({
            mediaType: 'image/webp',
            data: 'V0VCUA==',
            chunkIndex: 0,
            chunkCount: 1,
        });
        expect(await read('thumbnail', 1)).toBeNull();
        expect(await read('original', 1, 1)).toEqual({
            mediaType: 'image/png',
            data: 'AAAAAAAA',
            chunkIndex: 1,
            chunkCount: 2,
        });
        await expect(read('original', 1, 2)).rejects.toMatchObject({ code: 'VALIDATION' });
    });

    it('forwards a model, effort, or ultracode switch through Core admission without inventing the other fields', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const domain = domainFixture({ surface: 'chat' });
        await invoke(
            {
                method: 'mobile.agentChat.configure',
                params: { terminalId: 'terminal-1', model: 'opus' },
            },
            domain,
            forward,
        );
        await invoke(
            {
                method: 'mobile.agentChat.configure',
                params: { terminalId: 'terminal-1', effort: 'high' },
            },
            domain,
            forward,
        );
        await invoke(
            {
                method: 'mobile.agentChat.configure',
                params: { terminalId: 'terminal-1', ultracode: true },
            },
            domain,
            forward,
        );
        expect(forward.mock.calls.map(([operation]) => operation)).toEqual([
            { method: 'agentChat.configure', params: { terminalId: 'terminal-1', model: 'opus' } },
            { method: 'agentChat.configure', params: { terminalId: 'terminal-1', effort: 'high' } },
            {
                method: 'agentChat.configure',
                params: { terminalId: 'terminal-1', ultracode: true },
            },
        ]);
    });

    it('lets only a control device switch the permission level or plan mode', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const domain = domainFixture({ surface: 'chat' });
        await invoke(
            {
                method: 'mobile.agentChat.configure',
                params: { terminalId: 'terminal-1', permissionMode: 'fullAccess', planMode: false },
            },
            domain,
            forward,
        );
        expect(forward).toHaveBeenCalledWith({
            method: 'agentChat.configure',
            params: { terminalId: 'terminal-1', permissionMode: 'fullAccess', planMode: false },
        });
        forward.mockClear();
        const reply = { ...principal, role: 'reply' as const };
        await Promise.all(
            [{ permissionMode: 'fullAccess' as const }, { planMode: true }].map((change) =>
                expect(
                    invokeMobileAgentChatRequest(
                        {
                            method: 'mobile.agentChat.configure',
                            params: { terminalId: 'terminal-1', ...change },
                        },
                        reply,
                        domain.domainService,
                        forward,
                        () => {},
                    ),
                ).rejects.toMatchObject({ code: 'FORBIDDEN' }),
            ),
        );
        // The model stays a reply device's choice.
        await invokeMobileAgentChatRequest(
            {
                method: 'mobile.agentChat.configure',
                params: { terminalId: 'terminal-1', model: 'opus' },
            },
            reply,
            domain.domainService,
            forward,
            () => {},
        );
        expect(forward.mock.calls.map(([operation]) => operation)).toEqual([
            { method: 'agentChat.configure', params: { terminalId: 'terminal-1', model: 'opus' } },
        ]);
    });

    it('restarts only a failed Chat on Retry', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        await invoke(
            { method: 'mobile.agentChat.retry', params: { terminalId: 'terminal-1' } },
            domainFixture({ surface: 'chat', snapshot: chatSnapshot('ready') }),
            forward,
        );
        expect(forward).not.toHaveBeenCalled();
        await invoke(
            { method: 'mobile.agentChat.retry', params: { terminalId: 'terminal-1' } },
            domainFixture({ surface: 'chat', snapshot: chatSnapshot('failed') }),
            forward,
        );
        expect(forward).toHaveBeenCalledWith({
            method: 'terminal.restart',
            params: { terminalId: 'terminal-1', mode: 'resume' },
        });
    });

    it('lets every role read, reply devices send and choose the model, and only control devices answer or stop', () => {
        for (const role of ['view', 'reply', 'control'] as const) {
            expect(isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.read')).toBe(true);
            expect(isMobileGatewayMethodAllowedForRole(role, 'mobile.agentChat.readImage')).toBe(
                true,
            );
        }
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.agentChat.send')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.agentChat.send')).toBe(true);
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.agentChat.configure')).toBe(
            false,
        );
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.agentChat.configure')).toBe(
            true,
        );
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.agentChat.configure')).toBe(
            true,
        );
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.agentChat.respond')).toBe(
            false,
        );
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.agentChat.interrupt')).toBe(
            false,
        );
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.agentChat.respond')).toBe(
            true,
        );
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.agentChat.interrupt')).toBe(
            true,
        );
    });
});
