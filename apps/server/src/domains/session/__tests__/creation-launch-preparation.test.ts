import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TerminalRecord } from '@caxri/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { CaxriDatabase } from '../../db';
import { InFlightLaunches } from '../../terminal/in-flight-launches';
import { createSessionCreator } from '../creation';

/**
 * `session.detach` and `terminal.terminateAll` wait for `InFlightLaunches.settled`. A new Session exists before its
 * Terminal launches, so one of them starting in that window must still wait for the launch to land.
 */
describe('session.create launch preparation', () => {
    it("keeps a detach of the new Session waiting until the Session's Terminal launch lands", async () => {
        const temporary = await mkdtemp(join(tmpdir(), 'caxri-session-launch-'));
        const directory = await realpath(temporary);
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const database = new CaxriDatabase(join(directory, 'state.db'));
        onTestFinished(() => database.close());
        const project = database.createProject(projectRoot);
        const launches = new InFlightLaunches();
        const starting = Promise.withResolvers<TerminalRecord>();
        const start = vi.fn<(terminal: TerminalRecord) => Promise<TerminalRecord>>(
            () => starting.promise,
        );
        const create = createSessionCreator({
            coordinator: { prepareTerminalStart: vi.fn(), probeTerminal: vi.fn() },
            database,
            observeSelectedSession: vi.fn(),
            sendFullStateChange: vi.fn(),
            startChat: vi.fn(),
            terminalSuspension: { observeSelection: vi.fn() },
            terminalWorkingDirectory: ({ defaultRoot }) => Promise.resolve(defaultRoot),
            terminals: { launches, start },
        });

        const creating = create(project.id, 'codex', 'preserve');
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        const terminal = start.mock.calls[0][0];
        let isDetached = false;
        const detached = (async () => {
            await launches.settled(() => false, terminal.sessionId);
            isDetached = true;
        })();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(isDetached).toBe(false);
        starting.resolve(terminal);
        await creating;
        await detached;
    });
});
