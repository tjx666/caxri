import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { AgentCoordinator } from '../agents';
import type { ConfigService } from '../config';
import { CaxriDatabase } from '../db';
import type { TerminalManager, TerminalWorkingDirectoryIdentity } from '../terminal';
import { createTerminalCreation } from '../terminal/creation';
import { InFlightLaunches } from '../terminal/in-flight-launches';
import { createTerminalRestartHandler } from '../terminal-restart';

/**
 * A `session.detach` waits for `InFlightLaunches.settled` before it returns. These cover the work a launch request does
 * before `start` or `restart` tracks it: a detach that begins then must still wait for that launch to land.
 */
async function fixture() {
    const temporary = await mkdtemp(join(tmpdir(), 'caxri-launch-preparation-'));
    const directory = await realpath(temporary);
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    const database = new CaxriDatabase(join(directory, 'state.db'));
    onTestFinished(() => database.close());
    const { session } = database.createSession(database.createProject(projectRoot).id, null);
    const launches = new InFlightLaunches();
    let isDetached = false;
    const detach = async () => {
        await launches.settled(() => false, session.id);
        isDetached = true;
    };
    const coordinator = {
        prepareTerminalResume: vi.fn(),
        prepareTerminalStart: vi.fn(),
        probeTerminal: vi.fn(),
    } as unknown as AgentCoordinator;
    return {
        coordinator,
        database,
        detach,
        isDetached: () => isDetached,
        launches,
        projectRoot,
        session,
    };
}

describe('launch preparation', () => {
    it('keeps a detach waiting while terminal.create resolves the working directory', async () => {
        const { coordinator, database, detach, isDetached, launches, session } = await fixture();
        let wasDetachedAtStart: boolean | undefined;
        const { createAndStartTerminal } = createTerminalCreation({
            configuration: { getSettings: () => ({ value: {} }) } as unknown as ConfigService,
            coordinator,
            database,
            terminals: {
                launches,
                start: (terminal: TerminalRecord) => {
                    wasDetachedAtStart = isDetached();
                    return Promise.resolve(terminal);
                },
            },
        });

        const creating = createAndStartTerminal(session.id, 'codex');
        const detached = detach();
        await creating;
        await detached;

        expect(wasDetachedAtStart).toBe(false);
    });

    it('keeps a detach waiting while terminal.restart looks up the working directory', async () => {
        const { coordinator, database, detach, isDetached, launches, projectRoot, session } =
            await fixture();
        const terminal = database.createTerminal(session.id, 'codex', projectRoot);
        const resolving = Promise.withResolvers<TerminalWorkingDirectoryIdentity>();
        const restart = vi.fn((terminalId: string) =>
            Promise.resolve(database.getTerminal(terminalId)!),
        );
        const handler = createTerminalRestartHandler({
            coordinator,
            database,
            logger: { write: vi.fn() } as unknown as StructuredLogger,
            restartChat: vi.fn(),
            send: vi.fn(),
            terminalDirectoryIdentity: () => resolving.promise,
            terminals: { launches, restart } as unknown as TerminalManager,
        });

        const restarting = handler({ mode: 'fresh', terminalId: terminal.id });
        const detached = detach();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(isDetached()).toBe(false);
        resolving.resolve({ device: 1, inode: 1, path: projectRoot } as never);
        await restarting;
        await detached;

        expect(restart).toHaveBeenCalledOnce();
    });
});
