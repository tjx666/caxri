// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type { AgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { MobileAgentChatRequest } from '../agent-chat-requests';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { chatSnapshot, domainFixture, invoke } from './agent-chat-requests.fixture';

describe('mobile Agent Chat queue and command requests', () => {
    it('queues a message sent during a turn unless the phone asks to steer', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const domain = domainFixture({ surface: 'chat' });
        await invoke(
            {
                method: 'mobile.agentChat.send',
                params: { terminalId: 'terminal-1', text: 'now', delivery: 'steer' },
            },
            domain,
            forward,
        );
        await invoke(
            {
                method: 'mobile.agentChat.send',
                params: { terminalId: 'terminal-1', text: 'later', delivery: 'queue' },
            },
            domain,
            forward,
        );
        expect(forward.mock.calls.map(([operation]) => operation)).toEqual([
            {
                method: 'agentChat.send',
                params: { terminalId: 'terminal-1', text: 'now', delivery: 'steer' },
            },
            {
                method: 'agentChat.send',
                params: { terminalId: 'terminal-1', text: 'later', delivery: 'queue' },
            },
        ]);
    });

    it('forwards the queue card actions through Core admission with only the queued id', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const domain = domainFixture({ surface: 'chat' });
        await invoke(
            {
                method: 'mobile.agentChat.removeQueued',
                params: { terminalId: 'terminal-1', id: 'queued-1' },
            },
            domain,
            forward,
        );
        await invoke(
            {
                method: 'mobile.agentChat.sendQueuedNow',
                params: { terminalId: 'terminal-1', id: 'queued-2' },
            },
            domain,
            forward,
        );
        await invoke(
            { method: 'mobile.agentChat.resumeQueue', params: { terminalId: 'terminal-1' } },
            domain,
            forward,
        );
        expect(forward.mock.calls.map(([operation]) => operation)).toEqual([
            {
                method: 'agentChat.removeQueued',
                params: { terminalId: 'terminal-1', id: 'queued-1' },
            },
            {
                method: 'agentChat.sendQueuedNow',
                params: { terminalId: 'terminal-1', id: 'queued-2' },
            },
            { method: 'agentChat.resumeQueue', params: { terminalId: 'terminal-1' } },
        ]);
    });

    it('refuses queue actions on a Terminal outside the grant or one that is not a Chat', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const requests: MobileAgentChatRequest[] = [
            {
                method: 'mobile.agentChat.removeQueued',
                params: { terminalId: 'terminal-1', id: 'queued-1' },
            },
            {
                method: 'mobile.agentChat.sendQueuedNow',
                params: { terminalId: 'terminal-1', id: 'queued-1' },
            },
            { method: 'mobile.agentChat.resumeQueue', params: { terminalId: 'terminal-1' } },
            {
                method: 'mobile.agentChat.takeQueued',
                params: { terminalId: 'terminal-1', id: 'queued-1' },
            },
        ];
        await Promise.all(
            requests.flatMap((request) => [
                expect(
                    invoke(request, domainFixture({ surface: 'chat', terminals: 0 }), forward),
                ).rejects.toMatchObject({ code: 'NOT_FOUND' }),
                expect(invoke(request, domainFixture({}), forward)).rejects.toMatchObject({
                    code: 'CONFLICT',
                }),
            ]),
        );
        expect(forward).not.toHaveBeenCalled();
    });

    it('takes a queued message back with its full text, checking it fits a phone send first', async () => {
        const long = 'x'.repeat(500);
        const snapshot: AgentChatSnapshot = {
            ...chatSnapshot('ready'),
            queue: [
                { id: 'queued-long', text: long },
                { id: 'queued-huge', text: 'y'.repeat(20_000) },
            ],
        };
        const forward = vi.fn<(operation: unknown) => Promise<unknown>>(async () => ({
            text: long,
        }));
        const domain = domainFixture({ surface: 'chat', snapshot });
        await expect(
            invoke(
                {
                    method: 'mobile.agentChat.takeQueued',
                    params: { terminalId: 'terminal-1', id: 'queued-long' },
                },
                domain,
                forward,
            ),
        ).resolves.toEqual({ text: long });
        expect(forward).toHaveBeenCalledWith({
            method: 'agentChat.takeQueued',
            params: { terminalId: 'terminal-1', id: 'queued-long' },
        });

        forward.mockClear();
        await expect(
            invoke(
                {
                    method: 'mobile.agentChat.takeQueued',
                    params: { terminalId: 'terminal-1', id: 'queued-huge' },
                },
                domain,
                forward,
            ),
        ).rejects.toMatchObject({ code: 'VALIDATION' });
        await expect(
            invoke(
                {
                    method: 'mobile.agentChat.takeQueued',
                    params: { terminalId: 'terminal-1', id: 'queued-gone' },
                },
                domain,
                forward,
            ),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        // Both stay queued: nothing reaches Core's take.
        expect(forward).not.toHaveBeenCalled();
    });

    it('forwards a slash command to the Chat, leaving the listed-command check to Core', async () => {
        const forward = vi.fn<(operation: unknown) => Promise<null>>(async () => null);
        const domain = domainFixture({ surface: 'chat' });
        await invoke(
            {
                method: 'mobile.agentChat.runCommand',
                params: { terminalId: 'terminal-1', name: 'compact', arguments: 'keep the plan' },
            },
            domain,
            forward,
        );
        await invoke(
            {
                method: 'mobile.agentChat.runCommand',
                params: { terminalId: 'terminal-1', name: 'review' },
            },
            domain,
            forward,
        );
        expect(forward.mock.calls.map(([operation]) => operation)).toEqual([
            {
                method: 'agentChat.runCommand',
                params: { terminalId: 'terminal-1', name: 'compact', arguments: 'keep the plan' },
            },
            {
                method: 'agentChat.runCommand',
                params: { terminalId: 'terminal-1', name: 'review' },
            },
        ]);
        await expect(
            invoke(
                {
                    method: 'mobile.agentChat.runCommand',
                    params: { terminalId: 'terminal-1', name: 'compact' },
                },
                domainFixture({}),
                forward,
            ),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(forward).toHaveBeenCalledTimes(2);
    });

    it('grants slash commands with sending: reply and control devices, never view', () => {
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.agentChat.runCommand')).toBe(
            false,
        );
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.agentChat.runCommand')).toBe(
            true,
        );
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.agentChat.runCommand')).toBe(
            true,
        );
    });

    it('grants the queue card actions with sending: reply and control devices, never view', () => {
        for (const method of [
            'mobile.agentChat.removeQueued',
            'mobile.agentChat.sendQueuedNow',
            'mobile.agentChat.resumeQueue',
            'mobile.agentChat.takeQueued',
        ]) {
            expect(isMobileGatewayMethodAllowedForRole('view', method)).toBe(false);
            expect(isMobileGatewayMethodAllowedForRole('reply', method)).toBe(true);
            expect(isMobileGatewayMethodAllowedForRole('control', method)).toBe(true);
        }
    });
});
