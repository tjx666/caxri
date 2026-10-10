import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { StructuredLogger } from '@caxri/system';
import { afterEach, expect, it, vi } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { GitService } from '../git';
import { GitChangeTracker } from '../git/change-tracker';
import { ProjectStatusService } from '../project-status';
import { createFakePty } from './create-test-domain-services';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
    vi.restoreAllMocks();
});

it('evicts an archived Session from the Git and Project Status caches until it is restored and read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-archive-caches-'));
    temporaryDirectories.push(directory);
    const projectRoot = join(directory, 'project');
    await mkdir(projectRoot);
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: projectRoot });
    const evict = vi.spyOn(GitService.prototype, 'evictSessions');
    const evictStatus = vi.spyOn(ProjectStatusService.prototype, 'evictSessions');
    const register = vi.spyOn(GitChangeTracker.prototype, 'registerSession');
    const runtime = await createTestDomainServices({
        userDataPath: join(directory, 'user-data'),
        logger: new StructuredLogger(join(directory, 'logs')),
        send: () => {},
        terminal: { spawn: () => createFakePty() },
    });

    try {
        const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
        const { session } = await runtime.handlers['session.create']({
            projectId: project.id,
            defaultAgent: 'shell',
        });
        const readSummary = () =>
            runtime.handlers['git.summary']({
                sessionId: session.id,
                refresh: 0,
                requester: 'renderer',
            });
        const registrations = () =>
            register.mock.calls.filter(([sessionId]) => sessionId === session.id).length;
        expect((await readSummary()).isRepository).toBe(true);
        expect(registrations()).toBeGreaterThan(0);
        evict.mockClear();
        evictStatus.mockClear();
        register.mockClear();

        await runtime.handlers['session.archive']({ sessionId: session.id });
        expect(evict).toHaveBeenCalledWith([session.id]);
        expect(evictStatus).toHaveBeenCalledWith([session.id]);
        expect(registrations()).toBe(0);

        await runtime.handlers['session.unarchive']({ sessionId: session.id, placement: 'top' });
        expect((await readSummary()).isRepository).toBe(true);
        expect(registrations()).toBeGreaterThan(0);
    } finally {
        await runtime.close();
    }
});
