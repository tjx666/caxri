import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalManager, TerminalWorkingDirectoryIdentity } from '../../terminal';
import {
    closeDispatchFixtures,
    createService,
    fakeTerminals,
    openDatabase,
    PRINCIPAL,
    temporaryDirectories,
} from './dispatch-service.fixture';

afterEach(closeDispatchFixtures);

/**
 * A `session.detach` waits for `InFlightLaunches.settled`; a dispatch resolves its working directory before it calls
 * `start`, so that lookup must hold the detach too, while the Agent's readiness wait after `start` must not.
 */
describe('AgentDispatchService launch preparation', () => {
    it('holds a detach of the Session through launch preparation but not through the readiness wait', async () => {
        const database = await openDatabase();
        const base = fakeTerminals(database);
        const start = vi.spyOn(base, 'start');
        const running = Promise.withResolvers<void>();
        const terminals = {
            ...base,
            waitForAgentRunning: () => running.promise,
        } as unknown as TerminalManager;
        const resolving = Promise.withResolvers<TerminalWorkingDirectoryIdentity>();
        const directoryIdentity = vi.fn(() => resolving.promise);
        const service = createService(database, terminals, undefined, undefined, directoryIdentity);
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session } = database.createSession(project.id, 'shell');
        const dispatching = service.start('dispatch-detach-window', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            provider: 'codex',
        });
        await vi.waitFor(() => expect(directoryIdentity).toHaveBeenCalled());
        let isDetached = false;
        const detached = (async () => {
            await terminals.launches.settled(() => false, session.id);
            isDetached = true;
        })();

        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(isDetached).toBe(false);
        resolving.resolve({ device: '1', inode: '1', path: project.rootPath });
        await detached;
        expect(start).toHaveBeenCalledOnce();
        running.resolve();
        await expect(dispatching).resolves.toMatchObject({ status: 'running' });
    });

    it('prepares the validated working directory before a PTY launch and survives a failed preparation', async () => {
        const database = await openDatabase();
        const project = database.createProject(join(temporaryDirectories.at(-1)!, 'project'));
        const { session } = database.createSession(project.id, 'shell');
        const prepareLaunch = vi.fn(() => Promise.reject(new Error('config locked')));
        const service = createService(
            database,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { prepareLaunch },
        );
        const receipt = await service.start('prepared', PRINCIPAL, {
            projectId: project.id,
            sessionId: session.id,
            provider: 'claude',
        });

        expect(prepareLaunch).toHaveBeenCalledExactlyOnceWith('claude', project.rootPath);
        expect(receipt.status).not.toBe('failed');
    });
});
