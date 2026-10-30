import type { ServerEvent } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import { createExtensionEventRouter } from '../event-router';
import type { ExtensionService } from '../service';

const gitChangedEvent: ServerEvent = {
    event: 'git.changed',
    payload: {
        sessionIds: ['session-window', 'session-phone', 'session-idle'],
        repositoryIds: [],
        scope: 'status',
    },
};

const setup = (visible: ReadonlySet<string> | undefined, isStopping = false) => {
    const gitChanged = vi.fn();
    const write = vi.fn();
    const router = createExtensionEventRouter({
        domainService: {
            visibleSessionIds: () => visible,
            request: (_method: string, parameters: { sessionId: string }) =>
                Promise.resolve({
                    ownerProjectId: 'project-1',
                    projectIds: ['project-1'],
                    sessionId: parameters.sessionId,
                    workbenchRootProjectId: 'root-1',
                }),
        } as unknown as ServerDomainService,
        extensionService: () => ({ gitChanged }) as unknown as ExtensionService,
        isStopping: () => isStopping,
        logger: { write } as unknown as StructuredLogger,
        watchesExtensionViews: (sessionId) => sessionId === 'session-phone',
    });
    return { gitChanged, router, write };
};

const refreshedSessions = (gitChanged: ReturnType<typeof vi.fn>): string[] =>
    (gitChanged.mock.calls as Array<[{ sessionId: string }]>)
        .map(([context]) => context.sessionId)
        .toSorted((left, right) => left.localeCompare(right));

describe('extension event router', () => {
    it('refreshes the Sessions a window shows or a phone follows and logs the saved fan-out', async () => {
        const { gitChanged, router, write } = setup(new Set(['session-window']));

        router.domainEvent(gitChangedEvent);

        await vi.waitFor(() =>
            expect(refreshedSessions(gitChanged)).toEqual(['session-phone', 'session-window']),
        );
        expect(write).toHaveBeenCalledWith('debug', 'extension_host.git_refresh_fanout', {
            fields: { named: 3, notified: 2, skipped: 1 },
        });
    });

    it('refreshes every named Session while Desktop has not reported its windows', async () => {
        const { gitChanged, router } = setup(undefined);

        router.domainEvent(gitChangedEvent);

        await vi.waitFor(() => expect(gitChanged).toHaveBeenCalledTimes(3));
    });

    it('sends nothing once Server Core is stopping', () => {
        const { gitChanged, router, write } = setup(undefined, true);

        router.domainEvent(gitChangedEvent);

        expect(gitChanged).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });
});
