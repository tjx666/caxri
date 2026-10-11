// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type { AgentChatSnapshot, Principal } from '@caxri/protocol';
import { MOBILE_AGENT_CHAT_IMAGE_CHUNK_LENGTH } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import type { MobileAgentChatRequest } from '../agent-chat-requests';
import { invokeMobileAgentChatRequest } from '../agent-chat-requests';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';

const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-1'],
};

const chatSnapshot = (status: AgentChatSnapshot['status']): AgentChatSnapshot => ({
    terminalId: 'terminal-1',
    revision: 3,
    status,
    truncated: false,
    items: [
        {
            id: 'item-1',
            type: 'agentMessage',
            text: 'x'.repeat(20_000),
            streaming: false,
        },
    ],
    turns: [],
    requests: [],
});

function domainFixture(options: {
    surface?: 'chat';
    snapshot?: AgentChatSnapshot;
    terminals?: number;
    original?: string;
}) {
    const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(
        async (method) => {
            if (method === 'terminal.queryForPrincipal')
                return {
                    terminals:
                        options.terminals === 0
                            ? []
                            : [
                                  {
                                      id: 'terminal-1',
                                      sessionId: 'session-1',
                                      kind: 'codex',
                                      title: 'Codex',
                                      lastProcessState: 'running',
                                      ...(options.surface && { surface: options.surface }),
                                  },
                              ],
                };
            if (method === 'agentChat.read') return options.snapshot ?? chatSnapshot('ready');
            if (method === 'mobile.image.readInternal') return ['T1JJRw==', 'VEhVTUI='];
            if (method === 'agentChat.readImage')
                return options.original === undefined
                    ? null
                    : { mediaType: 'image/png', data: options.original };
            throw new Error(`Unexpected ${method}`);
        },
    );
    return { domainService: { request } as unknown as ServerDomainService, request };
}

const invoke = (
    request: MobileAgentChatRequest,
    domain: ReturnType<typeof domainFixture>,
    forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null),
) => invokeMobileAgentChatRequest(request, principal, domain.domainService, forward, () => {});

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
                params: { terminalId: 'terminal-1', text: 'hi', delivery: 'steer' },
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
                delivery: 'steer',
            },
        });
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

    it('forwards a model or effort switch through Core admission without inventing the other field', async () => {
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
        expect(forward.mock.calls.map(([operation]) => operation)).toEqual([
            { method: 'agentChat.configure', params: { terminalId: 'terminal-1', model: 'opus' } },
            { method: 'agentChat.configure', params: { terminalId: 'terminal-1', effort: 'high' } },
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
