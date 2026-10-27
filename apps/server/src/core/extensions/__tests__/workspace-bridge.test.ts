import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../../core/domain-service';
import type { ServerDesktopRouter } from '../../desktop-router';
import { createExtensionWorkspaceRequest } from '../workspace-bridge';

function fixture() {
    const discard = vi.fn(() => Promise.resolve(null));
    const requestInWorkbenchContext = vi.fn(() => Promise.resolve([]));
    const desktopRouter = { discard } as unknown as ServerDesktopRouter;
    return {
        desktopRouter,
        discard,
        requestInWorkbenchContext,
        workspaceRequest: createExtensionWorkspaceRequest({
            desktopRouter: () => desktopRouter,
            domainService: { requestInWorkbenchContext } as unknown as Pick<
                ServerDomainService,
                'requestInWorkbenchContext'
            >,
        }),
    };
}

describe('Extension workspace bridge', () => {
    it('routes allowlisted workspace reads to Runtime authority', async () => {
        const harness = fixture();
        const parameters = { refresh: 0, sessionId: 'session-1' };

        const context = { sessionId: 'session-1', workbenchRootProjectId: 'project-1' };
        await expect(harness.workspaceRequest('git.summary', parameters, context)).resolves.toEqual(
            [],
        );
        expect(harness.requestInWorkbenchContext).toHaveBeenCalledWith(
            'git.summary',
            parameters,
            context,
        );
        expect(harness.discard).not.toHaveBeenCalled();
    });

    it('routes Git discard through the Server-owned confirmation and Git domain sequence', async () => {
        const harness = fixture();
        const parameters = { sessionId: 'session-1', repositoryId: 'repo-1' };

        await expect(
            harness.workspaceRequest('git.discard', parameters, {
                sessionId: 'session-1',
                workbenchRootProjectId: 'project-1',
            }),
        ).resolves.toBeNull();
        expect(harness.discard).toHaveBeenCalledWith(parameters, undefined, {
            sessionId: 'session-1',
            workbenchRootProjectId: 'project-1',
        });
        expect(harness.requestInWorkbenchContext).not.toHaveBeenCalled();
    });

    it('fails closed when a native operation has no authenticated Desktop', async () => {
        const requestInWorkbenchContext = vi.fn(() => Promise.resolve([]));
        const workspaceRequest = createExtensionWorkspaceRequest({
            desktopRouter: () => {},
            domainService: { requestInWorkbenchContext } as unknown as Pick<
                ServerDomainService,
                'requestInWorkbenchContext'
            >,
        });

        await expect(
            workspaceRequest(
                'git.discard',
                {
                    repositoryId: 'repository-1',
                    scope: { kind: 'all' },
                    sessionId: 'session-1',
                },
                { sessionId: 'session-1', workbenchRootProjectId: 'project-1' },
            ),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        expect(requestInWorkbenchContext).not.toHaveBeenCalled();
    });
});
