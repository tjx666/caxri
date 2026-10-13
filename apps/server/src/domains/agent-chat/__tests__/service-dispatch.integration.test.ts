import type { Principal } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { AgentDispatchService, AgentDispatchStateRelay } from '../../agent-dispatch';
import type { AgentEndpointLifecycle } from '../../agent-endpoints';
import type { AgentCoordinator } from '../../agents';
import type { TerminalManager } from '../../terminal';
import { InFlightLaunches } from '../../terminal/in-flight-launches';
import { fixture } from './chat-service-fixture';

const PRINCIPAL: Principal = { kind: 'human-cli', id: 'human-cli:test' };

describe('Agent dispatch of a Chat', () => {
    it('resumes a stopped Chat on its own thread and settles when the Chat stops', async () => {
        const active = new Set<string>();
        const relay = new AgentDispatchStateRelay();
        const f = await fixture({
            endpoint: {
                activate: (terminalId) => {
                    active.add(terminalId);
                    return Promise.resolve();
                },
                environment: () => Promise.resolve({}),
                retire: (terminalId) => {
                    active.delete(terminalId);
                    return Promise.resolve();
                },
            },
            onAgentStateChanged: relay.observe,
        });
        const { database, service: chats, terminal, threadOpens, until } = f;
        const dispatch = new AgentDispatchService({
            logger: { write: vi.fn() } as never,
            database,
            coordinator: {
                prepareTerminalResume: vi.fn(),
                probeTerminal: vi.fn(),
            } as unknown as AgentCoordinator,
            terminals: {
                agentLaunchId: () => {},
                agentProcessId: () => {},
                launches: new InFlightLaunches(),
            } as unknown as TerminalManager,
            endpoints: {
                endpointForTerminal: (terminalId: string) =>
                    active.has(terminalId)
                        ? {
                              launchId: 'launch',
                              terminalId,
                              ref: { hostId: 'host', endpointId: 'endpoint', generation: 1 },
                          }
                        : undefined,
            } as unknown as AgentEndpointLifecycle,
            agentChat: chats,
            launchSettings: () => ({ executable: '/fake/codex', args: [] }),
            terminalDirectoryIdentity: (path) => Promise.resolve({ device: '1', inode: '1', path }),
            terminalWorkingDirectory: ({ defaultRoot }) => Promise.resolve(defaultRoot),
            emit: vi.fn(),
        });
        relay.service = dispatch;
        onTestFinished(() => dispatch.close());

        await chats.send(terminal.id, { text: 'remember me' });
        await until((snapshot) => snapshot.turns.at(-1)?.status === 'completed');
        const threadId = database.getTerminal(terminal.id)?.agentSessionId;
        expect(threadId).toBeTruthy();
        await chats.stopProvider(terminal.id);
        expect(chats.isLive(terminal.id)).toBe(false);
        expect(database.getTerminal(terminal.id)?.lastAgentProcessState).toBe('stopped');

        const target = {
            projectId: database.getSession(terminal.sessionId)!.projectId,
            sessionId: terminal.sessionId,
            terminalId: terminal.id,
        };
        await expect(dispatch.wake('wake-chat', PRINCIPAL, target)).resolves.toMatchObject({
            operation: 'wake',
            status: 'running',
            endpoint: { endpointId: 'endpoint' },
        });
        expect(database.getTerminal(terminal.id)?.agentSessionId).toBe(threadId);
        expect((await threadOpens()).map(({ method }) => method)).toEqual([
            'thread/start',
            'thread/resume',
        ]);
        const resumed = await until((snapshot) => snapshot.status === 'ready');
        expect(resumed.items.some((item) => item.type === 'userMessage')).toBe(true);

        await expect(
            dispatch.resume('resume-live-chat', PRINCIPAL, {
                ...target,
                providerSessionId: threadId!,
            }),
        ).rejects.toThrow('Agent Terminal is already running');

        await chats.stopProvider(terminal.id);
        expect(dispatch.status('wake-chat', null)).toMatchObject({ status: 'stopped' });
    });
});
