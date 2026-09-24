import type { ServerEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { routeExtensionDomainEvent } from '../domain-events';
import type { ExtensionService } from '../service';

describe('generic extension runtime event routing', () => {
    it('delivers no-session context changes without fabricating a Session scope', async () => {
        const activeContext = vi.fn().mockResolvedValue({ projectIds: [] });
        const activeContextChanged = vi.fn();
        const service = { activeContextChanged } as unknown as ExtensionService;
        const event = {
            event: 'state.changed',
            payload: { kind: 'full', reason: 'session.select' },
        } satisfies ServerEvent;

        await routeExtensionDomainEvent(service, { request: activeContext }, event);

        expect(activeContextChanged).toHaveBeenCalledWith({ kind: 'no-session' });
    });

    it('does not refresh the active Git or Status view for an unrelated Session', async () => {
        const activeContext = vi.fn().mockResolvedValue({
            ownerProjectId: 'project-1',
            projectIds: ['project-1'],
            sessionId: 'session-current',
            workbenchProjectId: 'root-1',
        });
        const gitChanged = vi.fn();
        const projectStatusChanged = vi.fn();
        const service = { gitChanged, projectStatusChanged } as unknown as ExtensionService;

        await routeExtensionDomainEvent(
            service,
            { request: activeContext },
            {
                event: 'git.changed',
                payload: { sessionIds: ['session-other'], repositoryIds: [], scope: 'status' },
            },
        );
        await routeExtensionDomainEvent(
            service,
            { request: activeContext },
            {
                event: 'projectStatus.changed',
                payload: { sessionId: 'session-other' },
            },
        );

        expect(gitChanged).not.toHaveBeenCalled();
        expect(projectStatusChanged).not.toHaveBeenCalled();
        expect(activeContext).toHaveBeenCalledTimes(2);
    });

    it('does not read active context for unrelated Runtime events', async () => {
        const activeContext = vi.fn();
        const service = { activeContextChanged: vi.fn() } as unknown as ExtensionService;

        await routeExtensionDomainEvent(
            service,
            { request: activeContext },
            {
                event: 'settings.changed',
                payload: { source: 'user' },
            },
        );

        expect(activeContext).not.toHaveBeenCalled();
    });

    it('reads active context only for a full change that can move the selection', async () => {
        const activeContext = vi.fn().mockResolvedValue({ projectIds: [] });
        const activeContextChanged = vi.fn();
        const service = { activeContextChanged } as unknown as ExtensionService;

        await Promise.all(
            (
                [
                    {
                        event: 'state.changed',
                        payload: { kind: 'records', sessionIds: ['session-1'], terminalIds: [] },
                    },
                    {
                        event: 'state.changed',
                        payload: { kind: 'full', reason: 'terminal.create' },
                    },
                ] satisfies ServerEvent[]
            ).map((event) => routeExtensionDomainEvent(service, { request: activeContext }, event)),
        );

        expect(activeContext).not.toHaveBeenCalled();
        expect(activeContextChanged).not.toHaveBeenCalled();
    });
});
