import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalKind } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { LocalTerminalExecution } from '../../__tests__/support/local-terminal-execution';
import { createFakePty } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

/**
 * Each case closes its domain services before teardown, but APFS on GitHub-hosted macOS can briefly retain a directory
 * entry and report `ENOTEMPTY`. Node's bounded recursive-rm retry covers that transient window while a persistent
 * writer still exhausts the retries and fails the test.
 */
afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(
        pendingDirectories.map((path) =>
            rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
        ),
    );
});

/**
 * Holds `terminal.start` the way a slow Host round trip does: until it answers, the Terminal has no process ID, which
 * is exactly what archive parking used to treat as "nothing to park". `stopGate` holds the restart barrier's Host stop
 * the same way, which keeps a Session park in progress for as long as a test needs.
 */
class HeldStartExecution extends LocalTerminalExecution {
    gate: PromiseWithResolvers<void> | undefined;
    readonly heldTerminalIds: string[] = [];
    stopGate: PromiseWithResolvers<void> | undefined;
    readonly heldStopIds: string[] = [];

    override async start(input: Parameters<LocalTerminalExecution['start']>[0]): Promise<number> {
        const gate = this.gate;
        if (gate) {
            this.heldTerminalIds.push(input.record.id);
            await gate.promise;
        }
        return super.start(input);
    }

    override async restartBarrier(
        terminalId: string,
    ): ReturnType<LocalTerminalExecution['restartBarrier']> {
        const gate = this.stopGate;
        if (gate && this.processId(terminalId) !== undefined) {
            this.heldStopIds.push(terminalId);
            await gate.promise;
        }
        return super.restartBarrier(terminalId);
    }
}

/**
 * Gives a request that should be waiting a bounded chance to finish anyway, so a test can tell "still blocked" from
 * "already done" without asserting on its internals.
 */
async function settleBriefly(request: unknown): Promise<void> {
    await Promise.race([request, new Promise((resolve) => setTimeout(resolve, 50))]);
}

async function createRuntime(name: string) {
    const directory = await mkdtemp(join(tmpdir(), `caxri-archive-launch-${name}-`));
    temporaryDirectories.push(directory);
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    const logger = new StructuredLogger(join(directory, 'logs'));
    const kills: Array<Mock<() => void>> = [];
    const spawn = vi.fn<typeof spawnPty>(() => {
        const kill = vi.fn<() => void>();
        kills.push(kill);
        return { ...createFakePty(), kill };
    });
    const execution = new HeldStartExecution({ logger, spawn });
    const domains = await createTestDomainServices({
        userDataPath: join(directory, 'user-data'),
        logger,
        send: () => {},
        terminal: {
            resolveExecutable: (kind: TerminalKind) =>
                Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/local/bin/claude'),
            spawn,
        },
        terminalExecution: execution,
        terminalRestoreGridWaitMs: 0,
    });
    const project = await domains.handlers['project.create']({ rootPath: projectRoot });
    const record = async (terminalId: string) =>
        (await domains.handlers['app.bootstrap']({})).terminals.find(
            (terminal) => terminal.id === terminalId,
        );
    return { domains, execution, kills, project, record };
}

describe('archiving a Session while one of its Terminals is still launching', () => {
    it('parks a Terminal whose Host start answers after the archive', async () => {
        const { domains, execution, kills, project, record } = await createRuntime('create');
        try {
            const created = await domains.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const { session } = created;
            // The launching Terminal must be the only one, or parking the other first outlasts the held start.
            await domains.handlers['terminal.close']({ terminalId: created.terminal!.id });
            execution.gate = Promise.withResolvers();
            const creating = domains.handlers['terminal.create']({
                sessionId: session.id,
                kind: 'shell',
            });
            await vi.waitFor(() => expect(execution.heldTerminalIds).toHaveLength(1));
            const [launchingId] = execution.heldTerminalIds;

            const archiving = domains.handlers['session.archive']({ sessionId: session.id });
            await vi.waitFor(async () =>
                expect(
                    (await domains.handlers['app.bootstrap']({})).sessions.find(
                        (entry) => entry.id === session.id,
                    )?.archivedAt,
                ).toBeDefined(),
            );
            execution.gate.resolve();
            await Promise.all([creating, archiving]);

            await vi.waitFor(async () =>
                expect((await record(launchingId))?.lastProcessState).toBe('suspended'),
            );
            expect(await domains.handlers['terminal.runningCount']({})).toEqual({
                terminals: 0,
                chats: 0,
            });
            expect(kills).toHaveLength(2);
            expect(kills[1]).toHaveBeenCalled();
        } finally {
            execution.gate?.resolve();
            await domains.close();
        }
    });

    it('parks a Terminal whose selection restore was already starting when the Session was archived', async () => {
        const { domains, execution, kills, project, record } = await createRuntime('restore');
        try {
            const created = await domains.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const terminalId = created.terminal!.id;
            await domains.handlers['session.archive']({ sessionId: created.session.id });
            expect((await record(terminalId))?.lastProcessState).toBe('suspended');
            await domains.handlers['session.unarchive']({
                sessionId: created.session.id,
                placement: 'top',
            });

            execution.gate = Promise.withResolvers();
            await domains.handlers['session.select']({ sessionId: created.session.id });
            await vi.waitFor(() => expect(execution.heldTerminalIds).toEqual([terminalId]));
            const archiving = domains.handlers['session.archive']({
                sessionId: created.session.id,
            });
            await vi.waitFor(async () =>
                expect(
                    (await domains.handlers['app.bootstrap']({})).sessions.find(
                        (entry) => entry.id === created.session.id,
                    )?.archivedAt,
                ).toBeDefined(),
            );
            execution.gate.resolve();
            await archiving;

            await vi.waitFor(async () =>
                expect((await record(terminalId))?.lastProcessState).toBe('suspended'),
            );
            expect(await domains.handlers['terminal.runningCount']({})).toEqual({
                terminals: 0,
                chats: 0,
            });
            expect(kills).toHaveLength(2);
            for (const kill of kills) expect(kill).toHaveBeenCalled();
        } finally {
            execution.gate?.resolve();
            await domains.close();
        }
    });
});

describe('detaching a Session while one of its Agents is still launching', () => {
    it('hands over an Agent whose selection restore was already starting', async () => {
        const { domains, execution, kills, project, record } = await createRuntime('detach');
        try {
            const created = await domains.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'claude',
            });
            const terminalId = created.terminal!.id;
            await domains.handlers['session.archive']({ sessionId: created.session.id });
            expect((await record(terminalId))?.lastProcessState).toBe('suspended');
            await domains.handlers['session.unarchive']({
                sessionId: created.session.id,
                placement: 'top',
            });

            execution.gate = Promise.withResolvers();
            await domains.handlers['session.select']({ sessionId: created.session.id });
            await vi.waitFor(() => expect(execution.heldTerminalIds).toEqual([terminalId]));
            const detaching = domains.handlers['session.detach']({
                sessionId: created.session.id,
            });
            execution.gate.resolve();
            await detaching;

            expect((await record(terminalId))?.lastProcessState).toBe('detached');
            expect(await domains.handlers['terminal.runningCount']({})).toEqual({
                terminals: 0,
                chats: 0,
            });
            expect(kills).toHaveLength(2);
            for (const kill of kills) expect(kill).toHaveBeenCalled();
        } finally {
            execution.gate?.resolve();
            await domains.close();
        }
    });

    it.each(['create', 'restart'] as const)(
        'hands over an Agent whose terminal.%s launch lands after the detach began',
        async (path) => {
            const { domains, execution, kills, project, record } = await createRuntime(
                `detach-${path}`,
            );
            try {
                const created = await domains.handlers['session.create']({
                    projectId: project.id,
                    defaultAgent: 'claude',
                });
                const { session } = created;
                if (path === 'create')
                    await domains.handlers['terminal.close']({ terminalId: created.terminal!.id });
                execution.gate = Promise.withResolvers();
                const launching =
                    path === 'create'
                        ? domains.handlers['terminal.create']({
                              sessionId: session.id,
                              kind: 'claude',
                          })
                        : domains.handlers['terminal.restart']({
                              terminalId: created.terminal!.id,
                              mode: 'resume',
                          });
                await vi.waitFor(() => expect(execution.heldTerminalIds).toHaveLength(1));
                const [launchingId] = execution.heldTerminalIds;

                const detaching = domains.handlers['session.detach']({ sessionId: session.id });
                // The detach finds no process to stop; the launch it must still hand over answers afterwards.
                await settleBriefly(detaching);
                execution.gate.resolve();
                await Promise.all([launching, detaching]);

                await vi.waitFor(async () =>
                    expect((await record(launchingId))?.lastProcessState).toBe('detached'),
                );
                expect((await record(launchingId))?.lastAgentProcessState).toBe('detached');
                expect(await domains.handlers['terminal.runningCount']({})).toEqual({
                    terminals: 0,
                    chats: 0,
                });
                expect(kills.at(-1)).toHaveBeenCalled();
            } finally {
                execution.gate?.resolve();
                await domains.close();
            }
        },
    );
});

describe('resuming a Session while its detach is still running', () => {
    it('runs the resume after the detach, so every Agent ends up running again', async () => {
        const { domains, execution, project, record } = await createRuntime('resume-detach');
        try {
            const created = await domains.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'claude',
            });
            const { session } = created;
            const second = await domains.handlers['terminal.create']({
                sessionId: session.id,
                kind: 'claude',
            });
            const agentIds = [created.terminal!.id, second.id];
            const agentStates = () =>
                Promise.all(
                    agentIds.map(
                        async (terminalId) => (await record(terminalId))?.lastProcessState,
                    ),
                );
            expect(await agentStates()).toEqual(['running', 'running']);

            execution.stopGate = Promise.withResolvers();
            const detaching = domains.handlers['session.detach']({ sessionId: session.id });
            // Detach stops one Agent at a time; holding the first keeps the second still running.
            await vi.waitFor(() => expect(execution.heldStopIds).toHaveLength(1));
            const resuming = domains.handlers['session.resume']({ sessionId: session.id });
            await settleBriefly(resuming);
            execution.stopGate.resolve();
            await Promise.all([detaching, resuming]);

            await vi.waitFor(async () =>
                expect(await agentStates()).toEqual(['running', 'running']),
            );
            expect(await domains.handlers['terminal.runningCount']({})).toEqual({
                terminals: 2,
                chats: 0,
            });
        } finally {
            execution.stopGate?.resolve();
            execution.gate?.resolve();
            await domains.close();
        }
    });
});
