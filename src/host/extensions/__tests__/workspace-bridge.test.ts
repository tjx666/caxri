import { describe, expect, it, vi } from 'vitest';

import type { HostDesktopRouter } from '../../desktop-router';
import type { HostRuntimeSupervisor } from '../../runtime-supervisor';
import { createExtensionWorkspaceRequest, extensionActiveContext } from '../workspace-bridge';

function fixture() {
    const discard = vi.fn(() => Promise.resolve(null));
    const open = vi.fn(() => Promise.resolve({}));
    const requestInWorkbenchContext = vi.fn(() => Promise.resolve([]));
    const trash = vi.fn(() => Promise.resolve(null));
    const desktopRouter = { discard, open, trash } as unknown as HostDesktopRouter;
    return {
        desktopRouter,
        discard,
        open,
        requestInWorkbenchContext,
        trash,
        workspaceRequest: createExtensionWorkspaceRequest({
            desktopRouter: () => desktopRouter,
            runtime: { requestInWorkbenchContext } as unknown as Pick<
                HostRuntimeSupervisor,
                'requestInWorkbenchContext'
            >,
        }),
    };
}

describe('Extension workspace bridge', () => {
    it('projects the owner and selected Workbench Root as distinct identities', () => {
        expect(
            extensionActiveContext({
                selectedSessionId: 'session-1',
                sessions: [
                    {
                        id: 'session-1',
                        projectId: 'project-owner',
                        workbenchProjectId: 'project-worktree',
                    },
                ],
            }),
        ).toEqual({
            ownerProjectId: 'project-owner',
            sessionId: 'session-1',
            workbenchProjectId: 'project-worktree',
        });
    });

    it('routes allowlisted workspace reads to Runtime authority', async () => {
        const harness = fixture();
        const parameters = { directory: '/project', sessionId: 'session-1' };

        const context = { sessionId: 'session-1', workbenchProjectId: 'project-1' };
        await expect(harness.workspaceRequest('files.list', parameters, context)).resolves.toEqual(
            [],
        );
        expect(harness.requestInWorkbenchContext).toHaveBeenCalledWith(
            'files.list',
            parameters,
            context,
        );
        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.trash).not.toHaveBeenCalled();
        expect(harness.discard).not.toHaveBeenCalled();
    });

    it('uses a generation-bound Desktop target for Finder reveal', async () => {
        const harness = fixture();

        await expect(
            harness.workspaceRequest(
                'files.reveal',
                {
                    path: '/project/file.ts',
                    sessionId: 'session-1',
                },
                { sessionId: 'session-1', workbenchProjectId: 'project-1' },
            ),
        ).resolves.toBeNull();
        expect(harness.open).toHaveBeenCalledWith(
            'reveal',
            undefined,
            {
                launchIfNeeded: false,
                path: '/project/file.ts',
                sessionId: 'session-1',
            },
            undefined,
            { sessionId: 'session-1', workbenchProjectId: 'project-1' },
        );
        expect(harness.requestInWorkbenchContext).not.toHaveBeenCalled();
    });

    it('routes Trash through the Host-owned authorization and native-operation sequence', async () => {
        const harness = fixture();
        const parameters = { sessionId: 'session-1', path: '/project/file.ts' };

        await expect(
            harness.workspaceRequest('files.trash', parameters, {
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
            }),
        ).resolves.toBeNull();
        expect(harness.trash).toHaveBeenCalledWith(parameters, undefined, {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
        });
        expect(harness.requestInWorkbenchContext).not.toHaveBeenCalled();
        expect(harness.open).not.toHaveBeenCalled();
    });

    it('routes Git discard through the Host-owned confirmation and Runtime sequence', async () => {
        const harness = fixture();
        const parameters = { sessionId: 'session-1', repositoryId: 'repo-1' };

        await expect(
            harness.workspaceRequest('git.discard', parameters, {
                sessionId: 'session-1',
                workbenchProjectId: 'project-1',
            }),
        ).resolves.toBeNull();
        expect(harness.discard).toHaveBeenCalledWith(parameters, undefined, {
            sessionId: 'session-1',
            workbenchProjectId: 'project-1',
        });
        expect(harness.requestInWorkbenchContext).not.toHaveBeenCalled();
        expect(harness.open).not.toHaveBeenCalled();
    });

    it('fails closed when a native operation has no authenticated Desktop', async () => {
        const requestInWorkbenchContext = vi.fn(() => Promise.resolve([]));
        const workspaceRequest = createExtensionWorkspaceRequest({
            desktopRouter: () => {},
            runtime: { requestInWorkbenchContext } as unknown as Pick<
                HostRuntimeSupervisor,
                'requestInWorkbenchContext'
            >,
        });

        await expect(
            workspaceRequest(
                'files.trash',
                {
                    path: '/project/file.ts',
                    sessionId: 'session-1',
                },
                { sessionId: 'session-1', workbenchProjectId: 'project-1' },
            ),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        expect(requestInWorkbenchContext).not.toHaveBeenCalled();
    });
});
