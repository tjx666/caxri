import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalKind } from '@caxri/protocol';
import { defaultAgentProviderSettings } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import Database from 'better-sqlite3';
import type { spawn as spawnPty } from 'node-pty';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { LocalTerminalExecution } from '../../__tests__/support/local-terminal-execution';
import { UNTOUCHED_SUSPENSION_DELAY_MS } from '../terminal/suspension-policy';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

const resolveExecutable = (kind: TerminalKind) =>
    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/claude');

async function createRuntime(name: string) {
    const directory = await mkdtemp(join(tmpdir(), `caxri-suspension-${name}-`));
    temporaryDirectories.push(directory);
    const userDataPath = join(directory, 'user-data');
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    let now = Date.now();
    const kills: Array<Mock<() => void>> = [];
    const spawnSpy = vi.fn<typeof spawnPty>(() => {
        const kill = vi.fn<() => void>();
        kills.push(kill);
        return { ...createFakePty(), kill };
    });
    const start = vi.spyOn(LocalTerminalExecution.prototype, 'start');
    const domains = await createTestDomainServices({
        userDataPath,
        logger: new StructuredLogger(join(directory, 'logs')),
        send: () => {},
        terminal: { resolveExecutable, spawn: spawnSpy },
        terminalRestoreGridWaitMs: 0,
        terminalSuspension: { now: () => now, sweepIntervalMs: 20 },
        agentAdapters: createPendingAgentAdapters(),
    });
    const project = await domains.handlers['project.create']({ rootPath: projectRoot });
    return {
        advance: (ms: number) => {
            now += ms;
        },
        domains,
        project,
        kills,
        spawnSpy,
        start,
        userDataPath,
    };
}

describe('background Agent suspension', () => {
    it.each([false, true])(
        'restores a suspended Terminal with explicit delegation ownership %s',
        async (isDelegated) => {
            const runtime = await createRuntime('untouched');
            const { domains } = runtime;
            try {
                const first = await domains.handlers['session.create']({
                    projectId: runtime.project.id,
                    defaultAgent: 'claude',
                });
                const terminalId = first.terminal!.id;
                const terminalRecord = async () => {
                    const state = await domains.handlers['app.bootstrap']({});
                    return state.terminals.find((entry) => entry.id === terminalId);
                };
                await vi.waitFor(async () =>
                    expect((await terminalRecord())?.lastAgentProcessState).toBe('running'),
                );
                /**
                 * Bind an Agent session id through raw SQL: `updateAgentMetadata` needs a provider snapshot this
                 * hermetic test never produces, and opening a second `CaxriDatabase` would run unclean-shutdown
                 * recovery on the live records.
                 */
                const direct = new Database(join(runtime.userDataPath, 'caxri.db'));
                direct
                    .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
                    .run('claude-session-1', terminalId);
                if (isDelegated) {
                    const record = {
                        receipt: {
                            delegationId: 'synthetic-delegation',
                            projectId: runtime.project.id,
                            sessionId: first.session.id,
                            terminalId,
                            provider: 'claude',
                            status: 'completed',
                            revision: 1,
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        principal: { kind: 'human-cli', id: 'synthetic-owner' },
                        input: {
                            projectId: runtime.project.id,
                            sessionId: first.session.id,
                            provider: 'claude',
                            prompt: 'Synthetic task',
                        },
                        fingerprint: 'synthetic',
                        promptDigest: 'a'.repeat(64),
                        frozenLaunch: { executable: 'claude', args: [] },
                        providerSessionId: 'claude-session-1',
                    };
                    direct
                        .prepare(
                            'INSERT INTO agent_delegations (id, session_id, terminal_id, status, record_json) VALUES (?, ?, ?, ?, ?)',
                        )
                        .run(
                            'synthetic-delegation',
                            first.session.id,
                            terminalId,
                            'completed',
                            JSON.stringify(record),
                        );
                }
                direct.close();

                // Switching to another Session leaves the untouched Agent behind.
                const second = await domains.handlers['session.create']({
                    projectId: runtime.project.id,
                    defaultAgent: 'shell',
                });
                await domains.handlers['session.select']({ sessionId: second.session.id });
                runtime.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
                await vi.waitFor(async () => {
                    const record = await terminalRecord();
                    expect(record?.lastProcessState).toBe('suspended');
                    expect(record?.lastAgentProcessState).toBe('suspended');
                });
                expect(runtime.kills[0]).toHaveBeenCalled();
                expect(runtime.spawnSpy).toHaveBeenCalledTimes(2);

                /**
                 * Returning restores the Terminal and resumes the bound Agent session. A settled delegation resumes it
                 * with the task's frozen launch rather than the user's current defaults.
                 */
                await domains.handlers['session.select']({ sessionId: first.session.id });
                await vi.waitFor(() => expect(runtime.spawnSpy).toHaveBeenCalledTimes(3));
                const resumed = runtime.start.mock.calls.at(-1)?.[0].agent;
                expect(resumed?.args).toEqual(
                    isDelegated
                        ? [
                              '--add-dir',
                              join(runtime.userDataPath, 'delegations', 'synthetic-delegation'),
                              '--resume',
                              'claude-session-1',
                          ]
                        : [
                              ...defaultAgentProviderSettings.claude.launch.args,
                              '--resume',
                              'claude-session-1',
                          ],
                );
                await vi.waitFor(async () => {
                    const record = await terminalRecord();
                    expect(record?.lastProcessState).toBe('running');
                    expect(record?.lastAgentProcessState).toBe('running');
                    expect(record?.agentSessionId).toBe('claude-session-1');
                });
            } finally {
                await domains.close();
            }
        },
    );

    it('keeps a detached Agent parked across Session selection and resumes it only on request', async () => {
        const runtime = await createRuntime('detach');
        const { domains } = runtime;
        try {
            const first = await domains.handlers['session.create']({
                projectId: runtime.project.id,
                defaultAgent: 'claude',
            });
            const terminalId = first.terminal!.id;
            const terminalRecord = async () => {
                const state = await domains.handlers['app.bootstrap']({});
                return state.terminals.find((entry) => entry.id === terminalId);
            };
            await vi.waitFor(async () =>
                expect((await terminalRecord())?.lastAgentProcessState).toBe('running'),
            );
            const direct = new Database(join(runtime.userDataPath, 'caxri.db'));
            direct
                .prepare('UPDATE terminals SET agent_session_id = ? WHERE id = ?')
                .run('claude-session-2', terminalId);
            direct.close();

            // Detaching the selected Session kills the Agent without leaving it.
            await domains.handlers['session.detach']({ sessionId: first.session.id });
            const detached = await terminalRecord();
            expect(detached?.lastProcessState).toBe('detached');
            expect(detached?.lastAgentProcessState).toBe('detached');
            expect(detached?.agentSessionId).toBe('claude-session-2');
            expect(runtime.kills[0]).toHaveBeenCalled();

            // Leaving and re-selecting the Session must not relaunch the handed-over conversation.
            const second = await domains.handlers['session.create']({
                projectId: runtime.project.id,
                defaultAgent: 'shell',
            });
            await domains.handlers['session.select']({ sessionId: second.session.id });
            await domains.handlers['session.select']({ sessionId: first.session.id });
            runtime.advance(UNTOUCHED_SUSPENSION_DELAY_MS);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(runtime.spawnSpy).toHaveBeenCalledTimes(2);
            expect((await terminalRecord())?.lastProcessState).toBe('detached');

            // An explicit resume relaunches with the provider's resume arguments and the same binding.
            await domains.handlers['session.resume']({ sessionId: first.session.id });
            await vi.waitFor(() => expect(runtime.spawnSpy).toHaveBeenCalledTimes(3));
            const resumed = runtime.start.mock.calls.at(-1)?.[0].agent;
            expect(resumed?.args).toEqual([
                ...defaultAgentProviderSettings.claude.launch.args,
                '--resume',
                'claude-session-2',
            ]);
            await vi.waitFor(async () => {
                const record = await terminalRecord();
                expect(record?.lastProcessState).toBe('running');
                expect(record?.agentSessionId).toBe('claude-session-2');
            });
        } finally {
            await domains.close();
        }
    });

    it('parks the live Terminals of an archived Session', async () => {
        const runtime = await createRuntime('archive');
        const { domains } = runtime;
        try {
            const created = await domains.handlers['session.create']({
                projectId: runtime.project.id,
                defaultAgent: 'claude',
            });
            const terminalId = created.terminal!.id;
            const other = await domains.handlers['session.create']({
                projectId: runtime.project.id,
                defaultAgent: 'shell',
            });
            await domains.handlers['session.select']({ sessionId: other.session.id });
            await domains.handlers['session.archive']({ sessionId: created.session.id });
            const state = await domains.handlers['app.bootstrap']({});
            const record = state.terminals.find((entry) => entry.id === terminalId);
            expect(record?.lastProcessState).toBe('suspended');
            expect(runtime.kills[0]).toHaveBeenCalled();
        } finally {
            await domains.close();
        }
    });
});
