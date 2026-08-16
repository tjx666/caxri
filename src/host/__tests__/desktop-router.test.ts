import { describe, expect, it, vi } from 'vitest';

import { CaxriError } from '../../shared/ipc/errors';
import type { DesktopOperation } from '../../shared/ipc/local-transport';
import { HostDesktopRouter } from '../desktop-router';
import type { HostRuntimeSupervisor } from '../runtime-supervisor';

const project = {
    id: 'project-1',
    rootPath: '/project',
    displayTitle: 'Project',
    orderIndex: 0,
    createdAt: 1,
    lastOpenedAt: 1,
};
const session = {
    id: 'session-1',
    projectId: project.id,
    rootPath: project.rootPath,
    createdAt: 1,
    lastOpenedAt: 1,
    lastActivityState: 'idle',
    attentionEpoch: 0,
    readAttentionEpoch: 0,
    hasUnread: false,
    layoutVersion: 1,
    displayTitle: 'Session',
    titleMode: 'automatic',
};
const bootstrap = {
    projects: [project],
    sessions: [session],
    terminals: [],
    selectedProjectId: project.id,
    selectedSessionId: session.id,
    sessionStates: [],
    settings: {},
    keybindings: [],
    keybindingConflicts: [],
    theme: {},
    runtime: { status: 'ready', restartCount: 0 },
};
const authorized = {
    kind: 'file',
    name: 'file.ts',
    path: '/project/file.ts',
    device: '1',
    inode: '2',
    root: { path: '/project', device: '1', inode: '1' },
} as const;

function runtime(request?: (method: string) => Promise<unknown>) {
    const implementation =
        request ??
        vi.fn((method: string) => {
            if (method === 'app.bootstrap') return Promise.resolve(bootstrap);
            if (method === 'files.authorizeOpen') return Promise.resolve(authorized);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
    return { request: implementation } as unknown as Pick<HostRuntimeSupervisor, 'request'>;
}

describe('Host Desktop router', () => {
    it('issues a one-use target and revalidates its identity before exposing a path', async () => {
        let operation: DesktopOperation | undefined;
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap') return Promise.resolve(bootstrap);
            if (method === 'files.authorizeOpen') return Promise.resolve(authorized);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const router = new HostDesktopRouter({
            bridge: {
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 3,
                    expiresAt: Date.now() + 1_000,
                }),
                invoke: (value) => {
                    operation = value;
                    return Promise.resolve(null);
                },
            },
            runtime: runtime(request),
        });

        await expect(
            router.open('open', 'file', {
                launchIfNeeded: false,
                path: authorized.path,
            }),
        ).resolves.toEqual({
            state: 'requested',
            generation: 3,
            projectId: project.id,
            sessionId: session.id,
        });
        expect(operation).toMatchObject({ kind: 'open' });
        if (operation?.kind !== 'open') throw new Error('Open target was not issued');
        await expect(router.consumeTarget(operation.targetId, 2)).rejects.toMatchObject({
            code: 'CONFLICT',
        });
        await expect(router.consumeTarget(operation.targetId, 3)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('returns only a revalidated target to the matching generation', async () => {
        let operation: DesktopOperation | undefined;
        const router = new HostDesktopRouter({
            bridge: {
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 4,
                    expiresAt: Date.now() + 1_000,
                }),
                invoke: (value) => {
                    operation = value;
                    return Promise.resolve(null);
                },
            },
            runtime: runtime(),
        });
        await router.open('reveal', undefined, {
            launchIfNeeded: false,
            path: authorized.path,
            sessionId: session.id,
        });
        if (operation?.kind !== 'reveal') throw new Error('Reveal target was not issued');
        await expect(router.consumeTarget(operation.targetId, 4)).resolves.toEqual({
            targetId: operation.targetId,
            operation: 'reveal',
            kind: 'file',
            sessionId: session.id,
            path: authorized.path,
        });
        await expect(router.consumeTarget(operation.targetId, 4)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('rejects paths outside every Project without routing a Desktop command', async () => {
        const invoke = vi.fn(() => Promise.resolve(null));
        const router = new HostDesktopRouter({
            bridge: {
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 1,
                    expiresAt: Date.now() + 1_000,
                }),
                invoke,
            },
            runtime: runtime(
                vi.fn((method: string) => {
                    if (method === 'app.bootstrap') return Promise.resolve(bootstrap);
                    return Promise.reject(
                        new CaxriError('PATH_DENIED', 'Path escapes the Project'),
                    );
                }),
            ),
        });
        await expect(
            router.open('open', 'file', {
                launchIfNeeded: false,
                path: '/outside/file.ts',
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('rejects an offline outside-Project target before launching Desktop', async () => {
        const launch = vi.fn(() => Promise.resolve());
        const waitForLease = vi.fn(() =>
            Promise.resolve({ desktopId: 'desktop-launched', generation: 9, expiresAt: 10_000 }),
        );
        const router = new HostDesktopRouter({
            bridge: {
                invoke: () => Promise.resolve(null),
                launch,
                lease: () => {},
                waitForLease,
            },
            runtime: runtime(
                vi.fn((method: string) => {
                    if (method === 'app.bootstrap') return Promise.resolve(bootstrap);
                    return Promise.reject(
                        new CaxriError('PATH_DENIED', 'Path escapes the Project'),
                    );
                }),
            ),
        });

        await expect(
            router.open('open', 'file', {
                launchIfNeeded: true,
                path: '/outside/file.ts',
            }),
        ).rejects.toMatchObject({ code: 'PATH_DENIED' });
        expect(launch).not.toHaveBeenCalled();
        expect(waitForLease).not.toHaveBeenCalled();
    });

    it('distinguishes offline, background, and focused Desktop states', async () => {
        let isOnline = false;
        const invoke = vi.fn((operation: DesktopOperation) =>
            Promise.resolve(operation.kind === 'status' ? { state: 'background' } : null),
        );
        const router = new HostDesktopRouter({
            bridge: {
                lease: () =>
                    isOnline
                        ? { desktopId: 'desktop-1', generation: 8, expiresAt: Date.now() + 1_000 }
                        : undefined,
                invoke,
            },
            runtime: runtime(),
        });
        await expect(router.status()).resolves.toEqual({ state: 'offline' });
        isOnline = true;
        await expect(router.status()).resolves.toEqual({ state: 'background', generation: 8 });
        await expect(router.focus(false)).resolves.toEqual({ state: 'focused', generation: 8 });
    });

    it('coalesces explicit Desktop launch requests while waiting for one lease', async () => {
        const launch = vi.fn(() => Promise.resolve());
        const waitForLease = vi.fn(() =>
            Promise.resolve({ desktopId: 'desktop-launched', generation: 9, expiresAt: 10_000 }),
        );
        const router = new HostDesktopRouter({
            bridge: {
                invoke: () => Promise.resolve(null),
                launch,
                lease: () => {},
                waitForLease,
            },
            runtime: runtime(),
        });

        await expect(Promise.all([router.focus(true), router.focus(true)])).resolves.toEqual([
            { state: 'focused', generation: 9 },
            { state: 'focused', generation: 9 },
        ]);
        expect(launch).toHaveBeenCalledOnce();
        expect(waitForLease).toHaveBeenCalledOnce();
    });

    it('rejects a route when the Desktop generation changes after selection', async () => {
        const invoke = vi.fn((_operation: DesktopOperation, expectedGeneration: number) =>
            expectedGeneration === 4
                ? Promise.reject(
                      new CaxriError('CONFLICT', 'Desktop capability lease changed before routing'),
                  )
                : Promise.resolve(null),
        );
        const router = new HostDesktopRouter({
            bridge: {
                invoke,
                lease: () => ({
                    desktopId: 'desktop-old',
                    generation: 4,
                    expiresAt: Date.now() + 1_000,
                }),
            },
            runtime: runtime(),
        });

        await expect(router.focus(false)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(invoke).toHaveBeenCalledWith({ kind: 'focus' }, 4);
    });
});
