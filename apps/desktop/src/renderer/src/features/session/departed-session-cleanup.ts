import { useEffect, useRef } from 'react';

import { environmentOfSession } from '../../lib/environment-routing';
import { queryClient } from '../../queries/client';
import { removeSessionQueries } from '../../queries/session-queries';
import { findHost } from '../../stores/environment';
import { useSessionViewStore } from '../../stores/session-view';
import { useWorkbenchStore } from '../../stores/workbench';
import { forgetDeletedSessions } from '../closed-items/recording';

/**
 * Ids in `known` that are absent from `live`: Sessions that left the Session list since it was last reconciled.
 * "Departed" means the Server stopped listing the Session at all (deleted, or its Project removed or hidden). An
 * archived Session is still listed, with `archivedAt` set, and stays resumable, so it never counts as departed.
 */
export function departedSessionIds(
    known: ReadonlySet<string>,
    live: ReadonlySet<string>,
): string[] {
    return [...known.difference(live)];
}

/**
 * Releases everything this window holds for Sessions the Server no longer lists: their session-view documents
 * (including dirty external-document copies), their entries in the closed-items history, and their cached queries. The
 * one way Renderer per-Session state is released, whichever client deleted the Session.
 */
export function cleanupDepartedSessions(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0) return;
    useSessionViewStore.getState().dropSessions(sessionIds);
    forgetDeletedSessions(sessionIds);
    removeSessionQueries(queryClient, sessionIds);
}

/**
 * The Sessions a window last saw, each with the SSH Host that owned it (`undefined` for this Mac).
 */
export type KnownSessions = ReadonlyMap<string, string | undefined>;

/**
 * Cleans up the Sessions that left the list between `known` and `live`, and returns `live` as the next `known`. The
 * first call has no `known` baseline and only records it, so a window never cleans up for a Session it never saw.
 *
 * A Session whose SSH Host is no longer listed left because the user disconnected that Host, not because it was
 * deleted; its documents (possibly dirty) stay until reload, as they did before this reconciliation existed, so a
 * reconnect does not find unsaved edits gone.
 */
export function reconcileSessionCleanup(
    known: KnownSessions | undefined,
    live: KnownSessions,
    isEnvironmentListed: (environmentId: string) => boolean,
    cleanup: (sessionIds: readonly string[]) => void = cleanupDepartedSessions,
): KnownSessions {
    if (known) {
        const departed = departedSessionIds(new Set(known.keys()), new Set(live.keys())).filter(
            (sessionId) => {
                const environmentId = known.get(sessionId);
                return environmentId === undefined || isEnvironmentListed(environmentId);
            },
        );
        cleanup(departed);
    }
    return live;
}

const ID_SEPARATOR = '\u{0}';

function isListedHost(environmentId: string): boolean {
    return findHost(environmentId) !== undefined;
}

/**
 * Prunes Renderer per-Session state when a Session disappears from the live bootstrap list, so a Session deleted from
 * the phone, another window, the CLI, or automatic cleanup is released like one this window deleted, instead of
 * lingering until reload. Like `pruneKeepAliveSessions`, it is driven by the list rather than by this window's own
 * delete commands. Nothing runs before the first bootstrap arrives, since an empty list there means "not loaded yet".
 */
export function useDepartedSessionCleanup(): void {
    const liveSessionKey = useWorkbenchStore((state) =>
        state.bootstrap
            ? state.bootstrap.sessions.map(({ id }) => id).join(ID_SEPARATOR)
            : undefined,
    );
    const known = useRef<KnownSessions | undefined>(undefined);
    useEffect(() => {
        if (liveSessionKey === undefined) return;
        const live = new Map(
            (liveSessionKey ? liveSessionKey.split(ID_SEPARATOR) : []).map((sessionId) => [
                sessionId,
                environmentOfSession(sessionId),
            ]),
        );
        known.current = reconcileSessionCleanup(known.current, live, isListedHost);
    }, [liveSessionKey]);
}
