import type { RuntimeEvent } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { routeExtensionRuntimeEvent } from '../runtime-events';
import type { ExtensionService } from '../service';

describe('generic extension runtime event routing', () => {
    it('delivers no-session context changes without fabricating a Session scope', async () => {
        const activeContext = vi
            .fn()
            .mockResolvedValue({ sessions: [], selectedSessionId: undefined });
        const activeContextChanged = vi.fn();
        const service = { activeContextChanged } as unknown as ExtensionService;
        const event = {
            event: 'state.changed',
            payload: { kind: 'full', reason: 'session.select' },
        } satisfies RuntimeEvent;

        await routeExtensionRuntimeEvent(service, { request: activeContext }, event);

        expect(activeContextChanged).toHaveBeenCalledWith({ kind: 'no-session' });
    });

    it('does not refresh the active Git or Status view for an unrelated Session', async () => {
        const activeContext = vi.fn().mockResolvedValue({
            selectedSessionId: 'session-current',
            sessions: [
                {
                    id: 'session-current',
                    projectId: 'project-1',
                    workbenchProjectId: 'root-1',
                },
            ],
        });
        const gitChanged = vi.fn();
        const projectStatusChanged = vi.fn();
        const service = { gitChanged, projectStatusChanged } as unknown as ExtensionService;

        await routeExtensionRuntimeEvent(
            service,
            { request: activeContext },
            {
                event: 'git.changed',
                payload: { sessionIds: ['session-other'], repositoryIds: [], scope: 'status' },
            },
        );
        await routeExtensionRuntimeEvent(
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

        await routeExtensionRuntimeEvent(
            service,
            { request: activeContext },
            {
                event: 'settings.changed',
                payload: { source: 'user' },
            },
        );

        expect(activeContext).not.toHaveBeenCalled();
    });
});
