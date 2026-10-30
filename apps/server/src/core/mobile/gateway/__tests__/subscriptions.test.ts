import type { MobileServerPayload } from '@caxri/mobile-transport';
// oxlint-disable typescript/require-await -- Async Host and authorization fakes preserve the production Promise boundary.
import type { Principal, ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { TerminalExecutionPort } from '../../../../domains/terminal';
import { MobileGatewaySubscriptions } from '../subscriptions';

const principal: Principal = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-1'],
};
const port = () => ({
    observe: vi.fn(async () => ({ snapshot: null, generation: 1, nextSequence: 0 })),
    unobserve: vi.fn(async () => {}),
    releaseTakeOver: vi.fn(async () => {}),
});

describe('MobileGatewaySubscriptions', () => {
    it('sends only the subscribed Session Git invalidation', async () => {
        const sent: MobileServerPayload[] = [];
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => 'changes-subscription',
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
        });
        const id = await subscriptions.subscribe({ kind: 'changes', sessionId: 'session-granted' });
        subscriptions.activate(id);
        subscriptions.publish({
            event: 'git.changed',
            payload: {
                repositoryIds: ['repo-other'],
                sessionIds: ['session-other'],
                scope: 'status',
            },
        });
        subscriptions.publish({
            event: 'git.changed',
            payload: {
                repositoryIds: ['repo-granted'],
                sessionIds: ['session-granted'],
                scope: 'status',
            },
        });
        await vi.waitFor(() =>
            expect(sent).toEqual([
                {
                    type: 'event',
                    subscriptionId: id,
                    sequence: 0,
                    kind: 'changes.changed',
                },
            ]),
        );
        subscriptions.close();
    });

    it('turns a change published while the subscribe is authorized into one re-read hint', async () => {
        const sent: MobileServerPayload[] = [];
        const { promise: authorized, resolve: allow } = Promise.withResolvers<void>();
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: () => authorized,
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => 'changes-subscription',
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
        });
        const subscribed = subscriptions.subscribe({ kind: 'changes', sessionId: 'session-1' });
        // The phone's read, sent right behind the subscribe, can take its snapshot before this change.
        const changed: ServerEvent = {
            event: 'git.changed',
            payload: { repositoryIds: ['repo-1'], sessionIds: ['session-1'], scope: 'status' },
        };
        subscriptions.publish(changed);
        subscriptions.publish(changed);
        allow();
        const id = await subscribed;
        expect(sent).toEqual([]);
        subscriptions.activate(id);
        await vi.waitFor(() =>
            expect(sent).toEqual([
                { type: 'event', subscriptionId: id, sequence: 0, kind: 'changes.changed' },
            ]),
        );
        subscriptions.close();
    });

    it('forwards only the subscribed Chat patches, shortened for the phone', async () => {
        const sent: MobileServerPayload[] = [];
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => 'chat-subscription',
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
        });
        const id = await subscriptions.subscribe({ kind: 'agentChat', terminalId: 'terminal-1' });
        const patch = (terminalId: string, revision: number) => ({
            event: 'agentChat.patch' as const,
            payload: {
                terminalId,
                baseRevision: revision - 1,
                revision,
                operations: [
                    {
                        op: 'upsertItem' as const,
                        item: {
                            id: `item-${revision}`,
                            type: 'agentMessage' as const,
                            text: 'x'.repeat(10_000),
                            streaming: false,
                        },
                    },
                ],
            },
        });
        // Not activated yet: the phone's first read may predate this patch, so activation asks it to read again.
        subscriptions.publish(patch('terminal-1', 1));
        expect(sent).toHaveLength(0);
        subscriptions.activate(id);
        subscriptions.publish(patch('terminal-other', 2));
        subscriptions.publish(patch('terminal-1', 2));
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        expect(sent[0]).toMatchObject({
            kind: 'agentChat.changed',
            sequence: 0,
            subscriptionId: id,
        });
        const event = sent[1] as Extract<MobileServerPayload, { kind: 'agentChat.patch' }>;
        expect(event).toMatchObject({ kind: 'agentChat.patch', sequence: 1, subscriptionId: id });
        const forwarded = event.patch as { operations: Array<{ item: { text: string } }> };
        expect(forwarded.operations[0]?.item.text.length).toBeLessThan(10_000);
        subscriptions.close();
    });

    it('names changed files in Chat patches relative to the Session Project', async () => {
        const sent: MobileServerPayload[] = [];
        const agentChatProjectRoot = vi.fn(async () => '/work/demo');
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => 'chat-subscription',
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
            agentChatProjectRoot,
        });
        const id = await subscriptions.subscribe({ kind: 'agentChat', terminalId: 'terminal-1' });
        expect(agentChatProjectRoot).toHaveBeenCalledWith(principal, 'terminal-1');
        subscriptions.activate(id);
        subscriptions.publish({
            event: 'agentChat.patch',
            payload: {
                terminalId: 'terminal-1',
                baseRevision: 0,
                revision: 1,
                operations: [
                    {
                        op: 'upsertItem',
                        item: {
                            id: 'change-1',
                            type: 'fileChange',
                            status: 'completed',
                            changes: [
                                { path: '/work/demo/src/greeting.ts', kind: 'update', diff: '' },
                            ],
                        },
                    },
                ],
            },
        });
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        const [event] = sent as Array<Extract<MobileServerPayload, { kind: 'agentChat.patch' }>>;
        const forwarded = event.patch as { operations: unknown[] };
        expect(forwarded.operations[0]).toMatchObject({
            item: { changes: [{ path: 'src/greeting.ts' }] },
        });
        subscriptions.close();
    });

    it('names changed files against the root the Session moved to', async () => {
        const sent: MobileServerPayload[] = [];
        let root = '/work/demo';
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => 'chat-subscription',
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
            agentChatProjectRoot: async () => root,
        });
        const id = await subscriptions.subscribe({ kind: 'agentChat', terminalId: 'terminal-1' });
        subscriptions.activate(id);
        const fileChange = (revision: number, path: string): ServerEvent => ({
            event: 'agentChat.patch',
            payload: {
                terminalId: 'terminal-1',
                baseRevision: revision - 1,
                revision,
                operations: [
                    {
                        op: 'upsertItem',
                        item: {
                            id: `change-${revision}`,
                            type: 'fileChange',
                            status: 'completed',
                            changes: [{ path, kind: 'update', diff: '' }],
                        },
                    },
                ],
            },
        });
        root = '/work/demo-worktree';
        subscriptions.publish({
            event: 'workbench.changed',
            payload: {
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-2',
                reason: 'followed',
            },
        });
        subscriptions.publish(fileChange(1, '/work/demo-worktree/src/a.ts'));
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]).toMatchObject({ kind: 'agentChat.changed' });
        await vi.waitFor(() => {
            subscriptions.publish(fileChange(2, '/work/demo-worktree/src/b.ts'));
            expect(sent.at(-1)).toMatchObject({ kind: 'agentChat.patch' });
        });
        const patch = sent.at(-1) as Extract<MobileServerPayload, { kind: 'agentChat.patch' }>;
        expect((patch.patch as { operations: unknown[] }).operations[0]).toMatchObject({
            item: { changes: [{ path: 'src/b.ts' }] },
        });
        subscriptions.close();
    });

    it('keeps a root the Session moved to while the first lookup was still pending', async () => {
        const sent: MobileServerPayload[] = [];
        const first = Promise.withResolvers<string>();
        const lookups = [first.promise, Promise.resolve('/work/demo-worktree')];
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => 'chat-subscription',
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
            agentChatProjectRoot: () => lookups.shift() ?? Promise.resolve('/unexpected'),
        });
        const subscribed = subscriptions.subscribe({ kind: 'agentChat', terminalId: 'terminal-1' });
        await vi.waitFor(() => expect(lookups).toHaveLength(1));
        subscriptions.publish({
            event: 'workbench.changed',
            payload: {
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-2',
                reason: 'followed',
            },
        });
        await vi.waitFor(() => expect(lookups).toHaveLength(0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        first.resolve('/work/demo');
        subscriptions.activate(await subscribed);
        subscriptions.publish({
            event: 'agentChat.patch',
            payload: {
                terminalId: 'terminal-1',
                baseRevision: 0,
                revision: 1,
                operations: [
                    {
                        op: 'upsertItem',
                        item: {
                            id: 'change-1',
                            type: 'fileChange',
                            status: 'completed',
                            changes: [
                                { path: '/work/demo-worktree/src/a.ts', kind: 'update', diff: '' },
                            ],
                        },
                    },
                ],
            },
        });
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]).toMatchObject({ kind: 'agentChat.patch' });
        expect(
            (
                (sent[0] as Extract<MobileServerPayload, { kind: 'agentChat.patch' }>).patch as {
                    operations: unknown[];
                }
            ).operations[0],
        ).toMatchObject({ item: { changes: [{ path: 'src/a.ts' }] } });
        subscriptions.close();
    });

    it('asks the phone to re-read when a Chat patch cannot fit one frame', async () => {
        const sent: MobileServerPayload[] = [];
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => 'chat-subscription',
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
        });
        const id = await subscriptions.subscribe({ kind: 'agentChat', terminalId: 'terminal-1' });
        subscriptions.activate(id);
        subscriptions.publish({
            event: 'agentChat.patch',
            payload: {
                terminalId: 'terminal-1',
                baseRevision: 0,
                revision: 1,
                operations: [{ op: 'appendText', itemId: 'item-1', delta: 'y'.repeat(60_000) }],
            },
        });
        await vi.waitFor(() =>
            expect(sent).toEqual([
                { type: 'event', subscriptionId: id, sequence: 0, kind: 'agentChat.changed' },
            ]),
        );
        subscriptions.close();
    });

    it('streams a normal 256 KiB Host batch without a capacity resync', async () => {
        const sent: MobileServerPayload[] = [];
        const execution = port();
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => 'subscription-terminal',
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
            terminalExecution: execution as unknown as TerminalExecutionPort,
        });
        const id = await subscriptions.subscribe({ kind: 'terminal', terminalId: 'terminal-1' });
        expect(sent).toEqual([]);
        subscriptions.activate(id);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        subscriptions.publishObserverEvent({
            type: 'output',
            terminalId: 'terminal-1',
            generation: 1,
            sequence: 0,
            data: 'x'.repeat(256 * 1_024),
        });
        await vi.waitFor(() =>
            expect(sent.filter((frame) => frame.type === 'stream')).toHaveLength(12),
        );
        expect(sent.filter((frame) => frame.type === 'event')).toHaveLength(0);
        subscriptions.close();
        await vi.waitFor(() =>
            expect(execution.unobserve).toHaveBeenCalledWith(
                'terminal-1',
                'connection-1:subscription-terminal',
            ),
        );
    });

    it('limits subscriptions whose authorization resolves concurrently', async () => {
        const release = Promise.withResolvers<void>();
        let nextId = 0;
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: () => release.promise,
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => `subscription-${++nextId}`,
            send: async () => {},
            terminate: vi.fn(),
            connectionId: 'connection-1',
        });
        const attempts = Array.from({ length: 33 }, () =>
            subscriptions.subscribe({ kind: 'dashboard' }),
        );
        release.resolve();
        const results = await Promise.allSettled(attempts);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(32);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
        subscriptions.close();
    });

    it('rejects a duplicate Terminal observer on one connection while dashboard still pushes', async () => {
        const sent: MobileServerPayload[] = [];
        const execution = port();
        let nextId = 0;
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => `subscription-${++nextId}`,
            send: async (payload) => {
                sent.push(payload);
            },
            terminate: vi.fn(),
            connectionId: 'connection-1',
            terminalExecution: execution as unknown as TerminalExecutionPort,
        });
        await subscriptions.subscribe({ kind: 'terminal', terminalId: 'terminal-1' });
        await expect(
            subscriptions.subscribe({ kind: 'terminal', terminalId: 'terminal-1' }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        const dashboardId = await subscriptions.subscribe({ kind: 'dashboard' });
        subscriptions.publish({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        await vi.waitFor(() =>
            expect(sent).toContainEqual({
                type: 'event',
                subscriptionId: dashboardId,
                sequence: 0,
                kind: 'dashboard.changed',
            }),
        );
        subscriptions.close();
    });

    it('isolates a slow Terminal observer after capacity overflow', async () => {
        const sent: MobileServerPayload[] = [];
        const release = Promise.withResolvers<void>();
        const execution = port();
        const terminate = vi.fn();
        let nextId = 0;
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => true,
            randomId: () => `subscription-${++nextId}`,
            send: async (payload) => {
                sent.push(payload);
                if (payload.type === 'stream' && payload.kind === 'terminal.output')
                    await release.promise;
            },
            terminate,
            connectionId: 'connection-1',
            terminalExecution: execution as unknown as TerminalExecutionPort,
        });
        const terminalId = await subscriptions.subscribe({
            kind: 'terminal',
            terminalId: 'terminal-1',
        });
        const dashboardId = await subscriptions.subscribe({ kind: 'dashboard' });
        subscriptions.activate(terminalId);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        subscriptions.publishObserverEvent({
            type: 'output',
            terminalId: 'terminal-1',
            generation: 1,
            sequence: 0,
            data: 'first',
        });
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        for (let index = 1; index < 100; index++)
            subscriptions.publishObserverEvent({
                type: 'output',
                terminalId: 'terminal-1',
                generation: 1,
                sequence: index,
                data: 'x'.repeat(8 * 1_024),
            });
        subscriptions.publish({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        release.resolve();
        await vi.waitFor(() =>
            expect(sent).toContainEqual({
                type: 'event',
                subscriptionId: terminalId,
                sequence: 2,
                kind: 'resync-required',
                reason: 'capacity',
            }),
        );
        expect(sent).toContainEqual({
            type: 'event',
            subscriptionId: dashboardId,
            sequence: 0,
            kind: 'dashboard.changed',
        });
        expect(terminate).not.toHaveBeenCalled();
        subscriptions.close();
    });

    it('revalidates current grants before each dashboard push', async () => {
        let isAllowed = true;
        const send = vi.fn(async () => {});
        const terminate = vi.fn();
        const subscriptions = new MobileGatewaySubscriptions({
            authorize: async () => {},
            currentPrincipal: () => principal,
            matches: async () => {
                if (!isAllowed) throw new Error('Grant changed');
                return true;
            },
            randomId: () => 'subscription-1',
            send,
            terminate,
            connectionId: 'connection-1',
        });
        await subscriptions.subscribe({ kind: 'dashboard' });
        isAllowed = false;
        subscriptions.publish({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'unknown' },
        });
        await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
        expect(send).not.toHaveBeenCalled();
        subscriptions.close();
    });
});
