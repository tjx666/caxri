import { mkdir, mkdtemp, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DesktopOperation, ProjectRecord } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerDesktopRouter } from '../desktop-router';
import type { ServerDomainService } from '../domain-service';
import { authorizeProjectRoot } from '../project-root-target';

const temporaryDirectories: string[] = [];
afterEach(async () => {
    await Promise.all(
        temporaryDirectories.map((path) => rm(path, { recursive: true, force: true })),
    );
    temporaryDirectories.length = 0;
});

async function fixture() {
    const prefix = join(tmpdir(), 'caxri-project-root-');
    const directory = await realpath(await mkdtemp(prefix));
    temporaryDirectories.push(directory);
    const rootPath = join(directory, 'project');
    await mkdir(rootPath);
    const project: ProjectRecord = {
        id: 'project-1',
        rootPath,
        title: 'Project',
        orderIndex: 0,
        createdAt: 1,
        lastVisitedAt: 1,
    };
    const state = { projects: [project], sessions: [], selectedSessionId: 'unrelated' };
    const request = vi.fn((method: string) => {
        if (method === 'app.bootstrap') return Promise.resolve(state);
        if (method === 'settings.get')
            return Promise.resolve({ value: { 'workbench.externalEditor': 'code' } });
        throw new Error(`Unexpected method: ${method}`);
    });
    const invoke = vi.fn<(operation: DesktopOperation, generation: number) => Promise<null>>(() =>
        Promise.resolve(null),
    );
    const router = new ServerDesktopRouter({
        domainService: { request } as unknown as ServerDomainService,
        bridge: {
            lease: () => ({ desktopId: 'desktop', generation: 1, expiresAt: Date.now() + 10000 }),
            invoke,
        },
    });
    async function issue(app: 'finder' | 'editor' = 'finder') {
        await router.openProjectRoot({ projectId: project.id, application: app });
        const operation = invoke.mock.calls.at(-1)?.[0];
        if (!operation || !('targetId' in operation)) throw new Error('Missing native target');
        return operation.targetId;
    }
    return { directory, project, state, router, invoke, request, issue };
}

describe('Project root Desktop authority', () => {
    it.each(['finder', 'editor'] as const)(
        'opens a Project without Sessions in %s and preserves selection',
        async (app) => {
            const { project, state, router, invoke, request, issue } = await fixture();
            const targetId = await issue(app);
            expect(await router.consumeTarget(targetId, 1)).toMatchObject({
                operation: app === 'finder' ? 'reveal' : 'openInEditor',
                projectId: project.id,
                path: project.rootPath,
                kind: 'directory',
            });
            expect(state.selectedSessionId).toBe('unrelated');
            expect(
                request.mock.calls.every(
                    ([method]) => method === 'app.bootstrap' || method === 'settings.get',
                ),
            ).toBe(true);
            if (app === 'editor')
                expect(invoke).toHaveBeenCalledWith(
                    expect.objectContaining({ editorCommand: 'code' }),
                    1,
                );
            await expect(router.consumeTarget(targetId, 1)).rejects.toMatchObject({
                code: 'NOT_FOUND',
            });
        },
    );

    it('rejects an unknown or deleted Project instead of falling back to selection', async () => {
        const { router, state, issue } = await fixture();
        await expect(
            router.openProjectRoot({ projectId: 'missing', application: 'finder' }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        const targetId = await issue();
        state.projects = [];
        await expect(router.consumeTarget(targetId, 1)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('rejects a replaced root before the one-use target is consumed', async () => {
        const { project, router, issue } = await fixture();
        const targetId = await issue();
        await rename(project.rootPath, `${project.rootPath}-old`);
        await mkdir(project.rootPath);
        await expect(router.consumeTarget(targetId, 1)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('rejects a root replaced by a symbolic link', async () => {
        const { directory, project } = await fixture();
        await rename(project.rootPath, `${project.rootPath}-old`);
        await symlink(directory, project.rootPath);
        await expect(authorizeProjectRoot(project)).rejects.toMatchObject({ code: 'PATH_DENIED' });
    });

    it('rejects stale Desktop generations', async () => {
        const { router, issue } = await fixture();
        await expect(router.consumeTarget(await issue(), 2)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });
});
