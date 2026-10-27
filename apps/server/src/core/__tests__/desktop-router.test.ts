import type { DesktopOperation } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../core/domain-service';
import { ServerDesktopRouter } from '../desktop-router';

const project = {
    id: 'project-1',
    rootPath: '/project',
    title: 'Project',
    orderIndex: 0,
    createdAt: 1,
    lastVisitedAt: 1,
};
const session = {
    id: 'session-1',
    projectId: project.id,
    rootPath: project.rootPath,
    createdAt: 1,
    lastVisitedAt: 1,
    sidebarOrder: 0,
    sessionActivityAt: 1,
    sessionActivityReason: 'created',
    agentActivityState: 'idle',
    attentionGeneration: 0,
    acknowledgedAttentionGeneration: 0,
    hasUnread: false,
    title: 'Session',
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

type ServerOperationRequestStub =
    | ((method: string) => Promise<unknown>)
    | ((method: string, parameters: unknown) => Promise<unknown>);

function domainService(request?: ServerOperationRequestStub) {
    const implementation =
        request ??
        vi.fn((method: string) => {
            if (method === 'app.bootstrap') return Promise.resolve(bootstrap);
            if (method === 'files.authorizeOpen') return Promise.resolve(authorized);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
    return {
        request: implementation,
        requestInWorkbenchContext: implementation,
        requestWithSignal: implementation,
    } as unknown as Pick<
        ServerDomainService,
        'request' | 'requestInWorkbenchContext' | 'requestWithSignal'
    >;
}

describe('Host Desktop router', () => {
    it('issues a one-use target and revalidates its identity before exposing a path', async () => {
        let operation: DesktopOperation | undefined;
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap') return Promise.resolve(bootstrap);
            if (method === 'files.authorizeOpen') return Promise.resolve(authorized);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const router = new ServerDesktopRouter({
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
            domainService: domainService(request),
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
        const router = new ServerDesktopRouter({
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
            domainService: domainService(),
        });
        await router.open('reveal', undefined, {
            launchIfNeeded: false,
            location: { mode: 'line', startLine: 12, endLine: 14 },
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
            location: { mode: 'line', startLine: 12, endLine: 14 },
        });
        await expect(router.consumeTarget(operation.targetId, 4)).rejects.toMatchObject({
            code: 'NOT_FOUND',
        });
    });

    it('carries the configured external editor with the openInEditor command', async () => {
        let operation: DesktopOperation | undefined;
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap') return Promise.resolve(bootstrap);
            if (method === 'files.authorizeOpen')
                return Promise.resolve({ ...authorized, kind: 'directory', path: '/project' });
            if (method === 'settings.get')
                return Promise.resolve({ value: { 'workbench.externalEditor': '  code  ' } });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const router = new ServerDesktopRouter({
            bridge: {
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 5,
                    expiresAt: Date.now() + 1_000,
                }),
                invoke: (value) => {
                    operation = value;
                    return Promise.resolve(null);
                },
            },
            domainService: domainService(request),
        });

        await router.open('openInEditor', 'directory', {
            launchIfNeeded: false,
            path: '/project',
        });
        // Server Core must resolve the editor here. If Main asked for `settings.get` while servicing
        // this command it would queue behind the very request awaiting its reply and deadlock.
        expect(operation).toMatchObject({ kind: 'openInEditor', editorCommand: 'code' });
        expect(request).toHaveBeenCalledWith('settings.get', {});
    });

    it('omits the editor command from the openInEditor operation when none is configured', async () => {
        let operation: DesktopOperation | undefined;
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap') return Promise.resolve(bootstrap);
            if (method === 'files.authorizeOpen')
                return Promise.resolve({ ...authorized, kind: 'directory', path: '/project' });
            if (method === 'settings.get')
                return Promise.resolve({ value: { 'workbench.externalEditor': null } });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const router = new ServerDesktopRouter({
            bridge: {
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 6,
                    expiresAt: Date.now() + 1_000,
                }),
                invoke: (value) => {
                    operation = value;
                    return Promise.resolve(null);
                },
            },
            domainService: domainService(request),
        });

        await router.open('openInEditor', 'directory', {
            launchIfNeeded: false,
            path: '/project',
        });
        expect(operation?.kind).toBe('openInEditor');
        expect(operation && 'editorCommand' in operation).toBe(false);
    });

    it('binds Extension native-operation preflights to the attested Workbench Root', async () => {
        const context = {
            sessionId: session.id,
            workbenchRootProjectId: 'workbench-project-1',
        };
        const request = vi.fn((method: string) => {
            if (method === 'app.bootstrap') return Promise.resolve(bootstrap);
            return Promise.reject(new Error(`Unexpected unscoped method: ${method}`));
        });
        const requestInWorkbenchContext = vi.fn((method: string) => {
            if (method === 'files.authorizeOpen') return Promise.resolve(authorized);
            if (method === 'git.discard.preflight')
                return Promise.resolve({
                    status: 'ready' as const,
                    token: 'scoped-token',
                    repositoryName: 'canonical-repository',
                    scope: { kind: 'all' as const, fileCount: 1 },
                });
            if (method === 'git.discard.apply') return Promise.resolve(null);
            return Promise.reject(new Error(`Unexpected scoped method: ${method}`));
        });
        const invoke = vi.fn((operation: DesktopOperation) =>
            Promise.resolve(operation.kind === 'confirmGitDiscard' ? { confirmed: true } : null),
        );
        const router = new ServerDesktopRouter({
            bridge: {
                invoke,
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 5,
                    expiresAt: Date.now() + 1_000,
                }),
            },
            domainService: {
                request,
                requestInWorkbenchContext,
                requestWithSignal: vi.fn(),
            } as unknown as Pick<
                ServerDomainService,
                'request' | 'requestInWorkbenchContext' | 'requestWithSignal'
            >,
        });

        await router.open(
            'reveal',
            undefined,
            { launchIfNeeded: false, path: 'file.ts', sessionId: session.id },
            undefined,
            context,
        );
        await router.discard(
            {
                repositoryId: 'repo-1',
                scope: { kind: 'all' },
                sessionId: session.id,
            },
            undefined,
            context,
        );

        expect(requestInWorkbenchContext).toHaveBeenNthCalledWith(
            1,
            'files.authorizeOpen',
            { path: 'file.ts', sessionId: session.id },
            context,
            undefined,
            undefined,
        );
        expect(requestInWorkbenchContext).toHaveBeenNthCalledWith(
            2,
            'git.discard.preflight',
            {
                repositoryId: 'repo-1',
                scope: { kind: 'all' },
                sessionId: session.id,
            },
            context,
            undefined,
            undefined,
        );
        expect(requestInWorkbenchContext).toHaveBeenNthCalledWith(
            3,
            'git.discard.apply',
            { token: 'scoped-token' },
            context,
        );
        expect(request.mock.calls.map(([method]) => method)).toEqual(['app.bootstrap']);
    });

    it('confirms Runtime-canonical Git discard details and applies only its one-use token', async () => {
        const parameters = {
            repositoryId: 'repo-1',
            scope: { kind: 'all' as const },
            sessionId: session.id,
        };
        const preflight = {
            status: 'ready' as const,
            token: 'discard-token',
            repositoryName: 'canonical-repository',
            scope: { kind: 'file' as const, path: 'current.txt', untracked: true },
        };
        const request = vi.fn((method: string, received: unknown) => {
            if (method === 'git.discard.preflight')
                return Promise.resolve({
                    ...preflight,
                });
            if (
                method === 'git.discard.apply' &&
                received !== undefined &&
                typeof received === 'object' &&
                received !== null &&
                'token' in received &&
                received.token === preflight.token
            )
                return Promise.resolve(null);
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const invoke = vi.fn(() => Promise.resolve({ confirmed: true }));
        const router = new ServerDesktopRouter({
            bridge: {
                invoke,
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 7,
                    expiresAt: Date.now() + 1_000,
                }),
            },
            domainService: domainService(request),
        });

        await expect(router.discard(parameters)).resolves.toBeNull();
        expect(invoke).toHaveBeenCalledWith(
            {
                kind: 'confirmGitDiscard',
                target: { repositoryName: preflight.repositoryName, scope: preflight.scope },
            },
            7,
        );
        expect(request).toHaveBeenNthCalledWith(1, 'git.discard.preflight', {
            repositoryId: parameters.repositoryId,
            scope: { kind: 'all' },
            sessionId: parameters.sessionId,
        });
        expect(request).toHaveBeenNthCalledWith(2, 'git.discard.apply', {
            token: preflight.token,
        });
    });

    it('never prompts or mutates when Runtime says the requested path is already clean', async () => {
        const parameters = {
            repositoryId: 'repo-1',
            scope: { kind: 'file' as const, path: 'stale.txt' },
            sessionId: session.id,
        };
        const request = vi.fn((method: string) => {
            if (method === 'git.discard.preflight')
                return Promise.resolve({ status: 'noop' as const });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const invoke = vi.fn(() => Promise.resolve({ confirmed: true }));
        const router = new ServerDesktopRouter({
            bridge: {
                invoke,
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 8,
                    expiresAt: Date.now() + 1_000,
                }),
            },
            domainService: domainService(request),
        });

        await expect(router.discard(parameters)).resolves.toBeNull();
        expect(invoke).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledOnce();
    });

    it('does not apply a Runtime consent token after the Desktop confirmation is canceled', async () => {
        const parameters = {
            repositoryId: 'repo-1',
            scope: { kind: 'all' as const },
            sessionId: session.id,
        };
        const request = vi.fn((method: string) => {
            if (method === 'git.discard.preflight')
                return Promise.resolve({
                    status: 'ready' as const,
                    token: 'unused-token',
                    repositoryName: 'canonical-repository',
                    scope: { kind: 'all' as const, fileCount: 2 },
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const invoke = vi.fn(() => Promise.resolve({ confirmed: false }));
        const router = new ServerDesktopRouter({
            bridge: {
                invoke,
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 9,
                    expiresAt: Date.now() + 1_000,
                }),
            },
            domainService: domainService(request),
        });

        await expect(router.discard(parameters)).resolves.toEqual({ canceled: true });
        expect(request).toHaveBeenCalledOnce();
        expect(invoke).toHaveBeenCalledOnce();
    });

    it('does not apply a discard consent after the Extension request is cancelled', async () => {
        const confirmation = Promise.withResolvers<{ confirmed: boolean }>();
        const request = vi.fn((method: string) => {
            if (method === 'git.discard.preflight')
                return Promise.resolve({
                    status: 'ready' as const,
                    token: 'cancelled-token',
                    repositoryName: 'canonical-repository',
                    scope: { kind: 'all' as const, fileCount: 2 },
                });
            return Promise.reject(new Error(`Unexpected method: ${method}`));
        });
        const invoke = vi.fn(() => confirmation.promise);
        const router = new ServerDesktopRouter({
            bridge: {
                invoke,
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 10,
                    expiresAt: Date.now() + 1_000,
                }),
            },
            domainService: domainService(request),
        });
        const controller = new AbortController();
        const discarded = router.discard(
            {
                repositoryId: 'repo-1',
                scope: { kind: 'all' },
                sessionId: session.id,
            },
            controller.signal,
        );
        await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());

        controller.abort();
        confirmation.resolve({ confirmed: true });

        await expect(discarded).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(request).toHaveBeenCalledOnce();
    });

    it('rejects paths outside every Project without routing a Desktop command', async () => {
        const invoke = vi.fn(() => Promise.resolve(null));
        const router = new ServerDesktopRouter({
            bridge: {
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 1,
                    expiresAt: Date.now() + 1_000,
                }),
                invoke,
            },
            domainService: domainService(
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

    it.each([
        ['target', { device: authorized.device, inode: '999', root: authorized.root }],
        [
            'Project root',
            {
                device: authorized.device,
                inode: authorized.inode,
                root: { ...authorized.root, inode: '999' },
            },
        ],
    ])('rejects a replaced %s identity after Terminal-link authorization', async (_, identity) => {
        const invoke = vi.fn(() => Promise.resolve(null));
        const router = new ServerDesktopRouter({
            bridge: {
                lease: () => ({
                    desktopId: 'desktop-1',
                    generation: 1,
                    expiresAt: Date.now() + 1_000,
                }),
                invoke,
            },
            domainService: domainService(),
        });

        await expect(
            router.open('open', 'file', {
                expectedIdentity: identity,
                launchIfNeeded: false,
                path: authorized.path,
                sessionId: session.id,
            }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('rejects an offline outside-Project target before launching Desktop', async () => {
        const launch = vi.fn(() => Promise.resolve());
        const waitForLease = vi.fn(() =>
            Promise.resolve({ desktopId: 'desktop-launched', generation: 9, expiresAt: 10_000 }),
        );
        const router = new ServerDesktopRouter({
            bridge: {
                invoke: () => Promise.resolve(null),
                launch,
                lease: () => {},
                waitForLease,
            },
            domainService: domainService(
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
        const router = new ServerDesktopRouter({
            bridge: {
                lease: () =>
                    isOnline
                        ? { desktopId: 'desktop-1', generation: 8, expiresAt: Date.now() + 1_000 }
                        : undefined,
                invoke,
            },
            domainService: domainService(),
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
        const router = new ServerDesktopRouter({
            bridge: {
                invoke: () => Promise.resolve(null),
                launch,
                lease: () => {},
                waitForLease,
            },
            domainService: domainService(),
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
        const router = new ServerDesktopRouter({
            bridge: {
                invoke,
                lease: () => ({
                    desktopId: 'desktop-old',
                    generation: 4,
                    expiresAt: Date.now() + 1_000,
                }),
            },
            domainService: domainService(),
        });

        await expect(router.focus(false)).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(invoke).toHaveBeenCalledWith({ kind: 'focus' }, 4);
    });
});
