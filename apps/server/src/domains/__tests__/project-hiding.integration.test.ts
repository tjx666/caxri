import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { GitService } from '../git';
import { createFakePty } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

it('hides a Project from bootstrap and restores its Sessions when the root is added again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-project-hide-'));
    temporaryDirectories.push(directory);
    const keeperRoot = join(directory, 'keeper');
    const hiddenRoot = join(directory, 'hidden');
    await Promise.all([mkdir(keeperRoot), mkdir(hiddenRoot)]);
    const events: ServerEvent[] = [];
    const evict = vi.spyOn(GitService.prototype, 'evictSessions');
    const runtime = await createTestDomainServices({
        userDataPath: join(directory, 'user-data'),
        logger: new StructuredLogger(join(directory, 'logs')),
        send: (event) => events.push(event),
        terminal: { spawn: () => createFakePty() },
    });

    try {
        const keeper = await runtime.handlers['project.create']({ rootPath: keeperRoot });
        await runtime.handlers['session.create']({ projectId: keeper.id, defaultAgent: 'shell' });
        const project = await runtime.handlers['project.create']({ rootPath: hiddenRoot });
        const created = await runtime.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'shell',
        });

        const hidden = await runtime.handlers['project.hide']({ projectId: project.id });

        expect(hidden.projects.map(({ id }) => id)).toEqual([keeper.id]);
        expect(hidden.sessions.some(({ projectId }) => projectId === project.id)).toBe(false);
        expect(hidden.terminals.some(({ sessionId }) => sessionId === created.session.id)).toBe(
            false,
        );
        expect(hidden.sessionStates.some(({ sessionId }) => sessionId === created.session.id)).toBe(
            false,
        );
        expect(hidden.selectedProjectId).toBe(keeper.id);
        expect(evict).toHaveBeenCalledWith([created.session.id]);
        expect(events).toContainEqual({
            event: 'state.changed',
            payload: { kind: 'full', reason: 'project.hide' },
        });
        expect((await runtime.handlers['project.list']({})).projects.map(({ id }) => id)).toEqual([
            keeper.id,
        ]);

        const restored = await runtime.handlers['project.create']({ rootPath: hiddenRoot });

        expect(restored.id).toBe(project.id);
        const bootstrap = await runtime.handlers['app.bootstrap']({});
        expect(bootstrap.sessions.map(({ id }) => id)).toContain(created.session.id);
        expect(bootstrap.terminals.map(({ id }) => id)).toContain(created.terminal!.id);
    } finally {
        await runtime.close();
    }
});
