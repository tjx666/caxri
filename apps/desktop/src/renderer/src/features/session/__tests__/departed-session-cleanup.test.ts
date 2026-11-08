import type { SessionRecord } from '@caxri/protocol';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ClientModule from '../../../queries/client';
import { caxriQueryKey } from '../../../queries/client';
import { useSessionViewStore } from '../../../stores/session-view';
import { closedItems } from '../../closed-items/stack';
import {
    cleanupDepartedSessions,
    departedSessionIds,
    reconcileSessionCleanup,
} from '../departed-session-cleanup';

const mocks = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock('../../../queries/client', async (importOriginal) => {
    const original = await importOriginal<typeof ClientModule>();
    return {
        ...original,
        get queryClient() {
            return mocks.client;
        },
    };
});

/**
 * Ids of the Sessions a bootstrap lists. An archived Session is a listed Session with `archivedAt` set.
 */
function listedIds(
    sessions: ReadonlyArray<Pick<SessionRecord, 'id'>>,
    environmentId?: string,
): Map<string, string | undefined> {
    return new Map(sessions.map(({ id }) => [id, environmentId]));
}

const isEveryHostListed = (): boolean => true;

function seedSession(queryClient: QueryClient, sessionId: string): void {
    useSessionViewStore.getState().cacheDocument(sessionId, {
        content: 'draft',
        path: '/outside/notes.md',
    } as never);
    closedItems.push([{ kind: 'session', sessionId }]);
    queryClient.setQueryData(caxriQueryKey('git.summary', { sessionId }), {});
}

function isHeld(queryClient: QueryClient, sessionId: string): boolean {
    return (
        Object.hasOwn(useSessionViewStore.getState().documents, sessionId) ||
        closedItems.snapshot().some((item) => item.sessionId === sessionId) ||
        queryClient.getQueryData(caxriQueryKey('git.summary', { sessionId })) !== undefined
    );
}

describe('departedSessionIds', () => {
    it('names the known Sessions the live list no longer holds', () => {
        expect(departedSessionIds(new Set(['a', 'b', 'c']), new Set(['a', 'c', 'd']))).toEqual([
            'b',
        ]);
    });

    it('does not count a newly listed Session', () => {
        expect(departedSessionIds(new Set(['a']), new Set(['a', 'b']))).toEqual([]);
    });
});

describe('reconcileSessionCleanup', () => {
    it('records the first list as a baseline without cleaning anything', () => {
        const cleanup = vi.fn();
        const next = reconcileSessionCleanup(
            undefined,
            listedIds([{ id: 'a' }]),
            isEveryHostListed,
            cleanup,
        );
        expect(cleanup).not.toHaveBeenCalled();
        expect(next.keys().toArray()).toEqual(['a']);
    });
});

describe('Session list driven cleanup', () => {
    let queryClient: QueryClient;

    beforeEach(() => {
        queryClient = new QueryClient();
        mocks.client = queryClient;
        useSessionViewStore.setState({ documents: {}, recentDocuments: {} });
        closedItems.forgetSessions(closedItems.snapshot().map((item) => item.sessionId));
    });

    it('clears documents, closed items, and queries of a Session that left the list, with no command issued', () => {
        seedSession(queryClient, 'deleted-elsewhere');
        seedSession(queryClient, 'kept');
        const before = listedIds([{ id: 'deleted-elsewhere' }, { id: 'kept' }]);

        reconcileSessionCleanup(before, listedIds([{ id: 'kept' }]), isEveryHostListed);

        expect(isHeld(queryClient, 'deleted-elsewhere')).toBe(false);
        expect(isHeld(queryClient, 'kept')).toBe(true);
    });

    it('leaves an archived Session untouched, since it stays listed with archivedAt set', () => {
        seedSession(queryClient, 'archived');
        const before = listedIds([{ id: 'archived' }]);
        const archivedList: Array<Pick<SessionRecord, 'archivedAt' | 'id'>> = [
            { id: 'archived', archivedAt: 1_700 },
        ];

        reconcileSessionCleanup(before, listedIds(archivedList), isEveryHostListed);

        expect(isHeld(queryClient, 'archived')).toBe(true);
    });

    it('keeps the Sessions of an SSH Host the user disconnected, so unsaved edits survive a reconnect', () => {
        seedSession(queryClient, 'remote');
        seedSession(queryClient, 'remote-deleted');
        const before = listedIds([{ id: 'remote' }, { id: 'remote-deleted' }], 'host-a');

        reconcileSessionCleanup(before, listedIds([{ id: 'remote' }], 'host-a'), isEveryHostListed);
        expect(isHeld(queryClient, 'remote-deleted')).toBe(false);

        reconcileSessionCleanup(listedIds([{ id: 'remote' }], 'host-a'), new Map(), () => false);
        expect(isHeld(queryClient, 'remote')).toBe(true);
    });

    it('does nothing for an empty batch', () => {
        seedSession(queryClient, 'kept');
        cleanupDepartedSessions([]);
        expect(isHeld(queryClient, 'kept')).toBe(true);
    });
});
