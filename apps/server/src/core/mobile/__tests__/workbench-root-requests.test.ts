// oxlint-disable typescript/require-await -- Async domain fakes preserve the production Promise boundary.
import type { Principal, WorkbenchRootOption } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';
import { listMobileWorkbenchRoots, selectMobileWorkbenchRoot } from '../workbench-root-requests';

const principal: Extract<Principal, { kind: 'paired-device' }> = {
    kind: 'paired-device',
    id: 'paired-device:device-1',
    deviceId: 'device-1',
    generation: 1,
    role: 'control',
    projectIds: ['project-main'],
};

const roots: WorkbenchRootOption[] = [
    {
        projectId: 'project-main',
        worktreeId: 'worktree-main',
        authorization: 'authorized',
        rootPath: '/projects/widget',
        isMain: true,
        title: 'widget',
        branch: 'main',
        owner: true,
    },
    {
        projectId: 'project-linked',
        worktreeId: 'worktree-linked',
        authorization: 'authorized',
        rootPath: '/projects/widget-feature',
        isMain: false,
        title: 'widget-feature',
        branch: 'feature/phone',
        owner: false,
    },
    {
        worktreeId: 'worktree-new',
        authorization: 'required',
        rootPath: '/projects/widget-new',
        isMain: false,
        title: 'widget-new',
        branch: 'feature/new',
        owner: false,
    },
];

function domainFixture(
    sessions: unknown[] = [{ id: 'session-1', workbenchRootProjectId: 'project-linked' }],
) {
    const request = vi.fn<(method: string, parameters?: unknown) => Promise<unknown>>(
        async (method) => {
            if (method === 'session.queryForPrincipal') return { sessions };
            if (method === 'session.workbenchRoots') return roots;
            if (method === 'session.selectWorkbenchRoot') return {};
            throw new Error(`Unexpected ${method}`);
        },
    );
    return { domainService: { request } as unknown as ServerDomainService, request };
}

describe('mobile Workbench Root requests', () => {
    it('lists worktrees without folder paths and marks the one the Session shows', async () => {
        const { domainService } = domainFixture();
        const result = await listMobileWorkbenchRoots(domainService, principal, {
            method: 'mobile.workbenchRoot.list',
            params: { sessionId: 'session-1' },
        });
        expect(result.roots).toEqual([
            {
                projectId: 'project-main',
                title: 'widget',
                branch: 'main',
                isMain: true,
                isCurrent: false,
            },
            {
                projectId: 'project-linked',
                title: 'widget-feature',
                branch: 'feature/phone',
                isMain: false,
                isCurrent: true,
            },
            { title: 'widget-new', branch: 'feature/new', isMain: false, isCurrent: false },
        ]);
        expect(JSON.stringify(result)).not.toContain('/projects');
    });

    it('switches through Desktop’s selection among the listed authorized worktrees', async () => {
        const { domainService, request } = domainFixture();
        await selectMobileWorkbenchRoot(domainService, principal, {
            method: 'mobile.workbenchRoot.select',
            params: { sessionId: 'session-1', projectId: 'project-main' },
        });
        expect(request).toHaveBeenCalledWith('session.selectWorkbenchRoot', {
            sessionId: 'session-1',
            projectId: 'project-main',
        });
    });

    it('refuses a Project that is not one of the Session’s worktrees', async () => {
        const { domainService, request } = domainFixture();
        await expect(
            selectMobileWorkbenchRoot(domainService, principal, {
                method: 'mobile.workbenchRoot.select',
                params: { sessionId: 'session-1', projectId: 'project-elsewhere' },
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(request).not.toHaveBeenCalledWith('session.selectWorkbenchRoot', expect.anything());
    });

    it('refuses a Session the device may not see before reading its worktrees', async () => {
        const { domainService, request } = domainFixture([]);
        await expect(
            listMobileWorkbenchRoots(domainService, principal, {
                method: 'mobile.workbenchRoot.list',
                params: { sessionId: 'session-1' },
            }),
        ).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(request).not.toHaveBeenCalledWith('session.workbenchRoots', expect.anything());
    });

    it('lets every role list worktrees and only a control device switch them', () => {
        for (const role of ['view', 'reply', 'control'] as const)
            expect(isMobileGatewayMethodAllowedForRole(role, 'mobile.workbenchRoot.list')).toBe(
                true,
            );
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.workbenchRoot.select')).toBe(
            false,
        );
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.workbenchRoot.select')).toBe(
            true,
        );
    });
});
