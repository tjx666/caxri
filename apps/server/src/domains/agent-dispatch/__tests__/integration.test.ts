import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentEndpointBeginParams as AgentEndpointBeginParameters } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { IPty, spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../../__tests__/support/domain-services';
import { createPendingAgentAdapters } from '../../__tests__/create-test-domain-services';
import { AgentEndpointLifecycle } from '../../agent-endpoints';

const temporaryDirectories: string[] = [];

function fakePty(pid: number) {
    let exit: ((event: { exitCode: number; signal?: number }) => void) | undefined;
    const kill = vi.fn();
    const write = vi.fn();
    const process = {
        pid,
        kill,
        onData: vi.fn(() => ({ dispose: vi.fn() })),
        onExit: vi.fn((listener: typeof exit) => {
            exit = listener;
            return { dispose: vi.fn() };
        }),
        resize: vi.fn(),
        write,
    } as unknown as IPty;
    return {
        emitExit: (event: { exitCode: number; signal?: number }) => exit?.(event),
        kill,
        process,
        write,
    };
}

function endpointLifecycle() {
    const generations = new Map<string, number>();
    return new AgentEndpointLifecycle(
        {
            activate: () => Promise.resolve(true),
            begin: (parameters: AgentEndpointBeginParameters) => {
                const generation = (generations.get(parameters.terminalId) ?? 0) + 1;
                generations.set(parameters.terminalId, generation);
                return Promise.resolve({
                    ref: {
                        hostId: 'host-1',
                        endpointId: `${parameters.terminalId}-${generation}`,
                        generation,
                    },
                    token: 'ab'.repeat(32),
                    expiresAt: Date.now() + 60_000,
                });
            },
            messaging: () => Promise.resolve(true),
            retire: () => Promise.resolve(true),
        },
        '/profile',
    );
}

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Agent dispatch Runtime integration', () => {
    it('durably deduplicates start and fences control to the exact Endpoint generation', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-dispatch-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const spawned: Array<ReturnType<typeof fakePty>> = [];
        const spawn = vi.fn<typeof spawnPty>(() => {
            const fake = fakePty(4_000 + spawned.length);
            spawned.push(fake);
            return fake.process;
        });
        const events: string[] = [];
        const runtime = await createTestDomainServices({
            agentAdapters: createPendingAgentAdapters(),
            agentEndpoints: endpointLifecycle(),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: (event) => {
                events.push(event.event);
            },
            terminal: {
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/fixture/agent'),
                spawn,
            },
            userDataPath: join(directory, 'profile'),
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const createdActivityAt = created.session.sessionActivityAt;
            const principal = { kind: 'human-cli' as const, id: 'human-cli:test' };
            const input = {
                projectId: project.id,
                sessionId: created.session.id,
                provider: 'codex' as const,
            };
            const first = await runtime.handlers['agent.dispatch.startInternal']({
                dispatchId: 'dispatch-1',
                principal,
                input,
            });
            const duplicate = await runtime.handlers['agent.dispatch.startInternal']({
                dispatchId: 'dispatch-1',
                principal,
                input,
            });

            expect(first).toMatchObject({
                dispatchId: 'dispatch-1',
                status: 'running',
                operation: 'start',
            });
            expect(duplicate).toEqual(first);
            expect(spawn).toHaveBeenCalledTimes(2);
            expect(events).toContain('agent.dispatch.changed');
            const dispatchedSession = (await runtime.handlers['app.bootstrap']({})).sessions.find(
                (session) => session.id === created.session.id,
            )!;
            expect(dispatchedSession.sessionActivityAt).toBeGreaterThan(createdActivityAt);
            expect(dispatchedSession.sessionActivityReason).toBe('agent_started');
            expect(dispatchedSession.agentActivityState).toBe('idle');

            const stale = { ...first.endpoint!, generation: first.endpoint!.generation + 1 };
            expect(() =>
                runtime.handlers['agent.control.interruptInternal']({ endpoint: stale }),
            ).toThrow(/unavailable/i);
            expect(spawned[1].kill).not.toHaveBeenCalled();

            expect(
                runtime.handlers['agent.control.interruptInternal']({ endpoint: first.endpoint! }),
            ).toMatchObject({ outcome: 'signaled', terminalId: first.terminalId });
            expect(spawned[1].kill).toHaveBeenCalledWith('SIGINT');

            await expect(
                runtime.handlers['terminal.sendInternal']({
                    terminalId: created.terminal!.id,
                    text: 'human steer',
                    enter: true,
                }),
            ).resolves.toMatchObject({ accepted: true, byteLength: 11, enter: true });
            expect(spawned[0].write).toHaveBeenCalledWith('human steer\r');
            const steeredSession = (await runtime.handlers['app.bootstrap']({})).sessions.find(
                (session) => session.id === created.session.id,
            )!;
            expect(steeredSession.sessionActivityAt).toBeGreaterThan(
                dispatchedSession.sessionActivityAt,
            );
            expect(steeredSession.sessionActivityReason).toBe('user_submission');
        } finally {
            await runtime.close();
        }
    });

    it('settles a pending dispatch as interrupted when its Terminal is detached', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-dispatch-detach-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const spawned: Array<ReturnType<typeof fakePty>> = [];
        const runtime = await createTestDomainServices({
            agentAdapters: createPendingAgentAdapters(),
            agentEndpoints: endpointLifecycle(),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
            terminal: {
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/fixture/agent'),
                spawn: () => {
                    const fake = fakePty(6_000 + spawned.length);
                    spawned.push(fake);
                    return fake.process;
                },
            },
            userDataPath: join(directory, 'profile'),
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const receipt = await runtime.handlers['agent.dispatch.startInternal']({
                dispatchId: 'dispatch-detach',
                principal: { kind: 'human-cli', id: 'human-cli:test' },
                input: {
                    projectId: project.id,
                    sessionId: created.session.id,
                    provider: 'claude',
                },
            });
            expect(receipt.status).toBe('running');
            const waiting = runtime.handlers['agent.dispatch.waitInternal']({
                afterRevision: receipt.revision,
                dispatchId: receipt.dispatchId,
                projectScope: null,
                timeoutMs: 10_000,
                waitId: 'wait-detach',
            });

            await runtime.handlers['session.detach']({ sessionId: created.session.id });

            await expect(waiting).resolves.toMatchObject({
                outcome: 'changed',
                receipt: { dispatchId: receipt.dispatchId, status: 'interrupted' },
            });
            expect(
                await runtime.handlers['agent.dispatch.statusInternal']({
                    dispatchId: receipt.dispatchId,
                    projectScope: null,
                }),
            ).toMatchObject({ status: 'interrupted' });
        } finally {
            await runtime.close();
        }
    });

    it('waits on typed lifecycle state and never resumes a changed Provider binding', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-dispatch-wait-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const spawned: Array<ReturnType<typeof fakePty>> = [];
        const runtime = await createTestDomainServices({
            agentAdapters: createPendingAgentAdapters(),
            agentEndpoints: endpointLifecycle(),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: () => {},
            terminal: {
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/fixture/agent'),
                spawn: () => {
                    const fake = fakePty(5_000 + spawned.length);
                    spawned.push(fake);
                    return fake.process;
                },
            },
            userDataPath: join(directory, 'profile'),
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const receipt = await runtime.handlers['agent.dispatch.startInternal']({
                dispatchId: 'dispatch-wait',
                principal: { kind: 'human-cli', id: 'human-cli:test' },
                input: {
                    projectId: project.id,
                    sessionId: created.session.id,
                    provider: 'claude',
                },
            });
            const waiting = runtime.handlers['agent.dispatch.waitInternal']({
                dispatchId: receipt.dispatchId,
                projectScope: [project.id],
                afterRevision: receipt.revision,
                timeoutMs: 1_000,
                waitId: 'wait-lifecycle',
            });
            const canceled = runtime.handlers['agent.dispatch.waitInternal']({
                dispatchId: receipt.dispatchId,
                projectScope: [project.id],
                afterRevision: receipt.revision,
                timeoutMs: 1_000,
                waitId: 'wait-canceled',
            });
            expect(
                runtime.handlers['agent.dispatch.cancelWaitInternal']({
                    waitId: 'wait-canceled',
                }),
            ).toEqual({ canceled: true });
            await expect(canceled).resolves.toMatchObject({
                outcome: 'canceled',
                receipt: { status: 'running' },
            });
            spawned[1].emitExit({ exitCode: 0 });

            await expect(waiting).resolves.toMatchObject({
                outcome: 'changed',
                receipt: { status: 'stopped' },
            });
            await expect(
                runtime.handlers['agent.dispatch.resumeInternal']({
                    dispatchId: 'dispatch-resume-stale',
                    principal: { kind: 'human-cli', id: 'human-cli:test' },
                    input: {
                        projectId: project.id,
                        sessionId: created.session.id,
                        terminalId: receipt.terminalId!,
                        providerSessionId: 'stale-provider-session',
                    },
                }),
            ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
            expect(spawned).toHaveLength(2);
            expect(() =>
                runtime.handlers['agent.dispatch.statusInternal']({
                    dispatchId: receipt.dispatchId,
                    projectScope: ['another-project'],
                }),
            ).toThrow('not found');
        } finally {
            await runtime.close();
        }
    });
});
