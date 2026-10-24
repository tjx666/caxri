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

    it('refreshes Git and Status views for every Session the change names, focused or not', async () => {
        const sessions: Record<string, string> = {
            'session-focused': 'root-1',
            'session-other': 'root-2',
        };
        const request = vi.fn((_method: string, parameters: { sessionId: string }) =>
            Promise.resolve(
                sessions[parameters.sessionId]
                    ? {
                          ownerProjectId: 'project-1',
                          projectIds: ['project-1'],
                          sessionId: parameters.sessionId,
                          workbenchProjectId: sessions[parameters.sessionId],
                      }
                    : { projectIds: ['project-1'] },
            ),
        );
        const gitChanged = vi.fn();
        const projectStatusChanged = vi.fn();
        const service = { gitChanged, projectStatusChanged } as unknown as ExtensionService;

        await routeExtensionDomainEvent(service, { request } as never, {
            event: 'git.changed',
            payload: {
                sessionIds: ['session-focused', 'session-other', 'session-deleted'],
                repositoryIds: [],
                scope: 'status',
            },
        });
        await routeExtensionDomainEvent(service, { request } as never, {
            event: 'projectStatus.changed',
            payload: { sessionId: 'session-other' },
        });

        expect(gitChanged.mock.calls).toEqual([
            [{ kind: 'session', sessionId: 'session-focused', workbenchProjectId: 'root-1' }],
            [{ kind: 'session', sessionId: 'session-other', workbenchProjectId: 'root-2' }],
        ]);
        expect(projectStatusChanged).toHaveBeenCalledExactlyOnceWith({
            kind: 'session',
            sessionId: 'session-other',
            workbenchProjectId: 'root-2',
        });
        expect(request).toHaveBeenCalledWith('app.sessionContext', {
            sessionId: 'session-deleted',
        });
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
