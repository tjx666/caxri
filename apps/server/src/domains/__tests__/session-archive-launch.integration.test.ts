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

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Holds `terminal.start` the way a slow Host round trip does: until it answers, the Terminal has no process ID, which
 * is exactly what archive parking used to treat as "nothing to park".
 */
class HeldStartExecution extends LocalTerminalExecution {
    gate: PromiseWithResolvers<void> | undefined;
    readonly heldTerminalIds: string[] = [];

    override async start(input: Parameters<LocalTerminalExecution['start']>[0]): Promise<number> {
        const gate = this.gate;
        if (gate) {
            this.heldTerminalIds.push(input.record.id);
            await gate.promise;
        }
        return super.start(input);
    }
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
            expect(await domains.handlers['terminal.runningCount']({})).toBe(0);
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
            expect(await domains.handlers['terminal.runningCount']({})).toBe(0);
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
            expect(await domains.handlers['terminal.runningCount']({})).toBe(0);
            expect(kills).toHaveLength(2);
            for (const kill of kills) expect(kill).toHaveBeenCalled();
        } finally {
            execution.gate?.resolve();
            await domains.close();
        }
    });
});
