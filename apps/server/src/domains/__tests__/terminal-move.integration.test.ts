import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { listPaneTerminalIds } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import type { spawn as spawnPty } from 'node-pty';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { createFakePty } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Regression coverage for `terminal.moveToNewSession`: proves the moved Terminal keeps its live PTY (same process
 * identity, no respawn) and that the in-memory `TerminalManager` cache tracking, not just the durable DB row, is kept
 * in sync, otherwise deleting the source Session after a move would kill the just-moved, still-live process. See the
 * JSDoc on `TerminalManager.reassignSession` (`apps/server/src/domains/terminal/manager.ts`) for the underlying
 * hazard.
 */
describe('terminal.moveToNewSession', () => {
    it('moves a live Terminal into a new selected Session and switches to it without respawning the PTY', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-move-terminal-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const spawn = vi.fn<typeof spawnPty>(() => createFakePty());
        const events: ServerEvent[] = [];
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: (event) => {
                events.push(event);
            },
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn,
            },
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'codex',
            });
            const sourceSessionId = created.session.id;
            const terminalId = created.terminal!.id;
            expect(spawn).toHaveBeenCalledTimes(1);

            const moved = await runtime.handlers['terminal.moveToNewSession']({ terminalId });

            expect(moved.session.id).not.toBe(sourceSessionId);
            expect(moved.session.projectId).toBe(project.id);
            expect(moved.terminal).toMatchObject({ id: terminalId, sessionId: moved.session.id });
            /**
             * The PTY is preserved, not restarted: `spawn` is still called exactly once.
             */
            expect(spawn).toHaveBeenCalledTimes(1);

            const bootstrap = await runtime.handlers['app.bootstrap']({});
            expect(bootstrap.selectedSessionId).toBe(moved.session.id);
            const liveTerminal = bootstrap.terminals.find((entry) => entry.id === terminalId);
            expect(liveTerminal).toMatchObject({
                id: terminalId,
                sessionId: moved.session.id,
                processId: 4242,
            });
            const movedState = bootstrap.sessionStates.find(
                (state) => state.sessionId === moved.session.id,
            );
            expect(movedState && listPaneTerminalIds(movedState.paneLayout)).toEqual([terminalId]);

            expect(
                events
                    .filter((event) => event.event === 'state.changed')
                    .some(
                        (event) =>
                            event.payload.kind === 'full' &&
                            event.payload.reason === 'terminal.moveToNewSession',
                    ),
            ).toBe(true);

            /**
             * Deleting the OLD (now empty) Session must not kill the moved, still-live PTY: this is exactly the hazard
             * `TerminalManager.reassignSession` exists to prevent (a stale cached `sessionId` would let
             * `terminateSession` match and kill it).
             */
            await runtime.handlers['session.delete']({ sessionId: sourceSessionId });
            const live = (await runtime.handlers['app.bootstrap']({})).terminals.find(
                (entry) => entry.id === terminalId,
            );
            expect(live).toMatchObject({ id: terminalId, sessionId: moved.session.id });
            expect(await runtime.handlers['terminal.runningCount']({})).toBe(1);
        } finally {
            await runtime.close();
        }
    });
});
