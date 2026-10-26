import type { BootstrapState } from '@caxri/protocol';

import { takeSessionToSkip } from './render-crash-recovery';

interface RecoveringSnapshotDependencies {
    now: () => number;
    readSnapshot: () => Promise<BootstrapState>;
    selectSession: (sessionId: string) => Promise<{ ownerWindowKey?: string }>;
    storage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;
}

/**
 * Bounds the fallback attempts so a Server that keeps redirecting never stalls startup.
 */
const MAX_FALLBACK_ATTEMPTS = 5;

/**
 * Picks the Session to land on instead of the crashing one: the first visible Session in sidebar order. Windows own at
 * most one Session each, so a candidate may belong to another window; the caller tries the next one then.
 */
function fallbackSessionCandidates(
    snapshot: Pick<BootstrapState, 'sessions'>,
    skipSessionId: string,
): string[] {
    return snapshot.sessions
        .filter((session) => session.id !== skipSessionId && session.archivedAt === undefined)
        .map((session) => session.id)
        .slice(0, MAX_FALLBACK_ATTEMPTS);
}

/**
 * Selects the first candidate this window may open. Sequential on purpose: each accepted select moves the window, so
 * only the first one may run. A rejected or redirected candidate falls through to the next.
 */
async function didSelectFirstAvailable(
    candidates: readonly string[],
    selectSession: RecoveringSnapshotDependencies['selectSession'],
): Promise<boolean> {
    if (candidates.length === 0) return false;
    const [candidate, ...rest] = candidates;
    let isAccepted = false;
    try {
        isAccepted = (await selectSession(candidate)).ownerWindowKey === undefined;
    } catch {
        // Fall through to the next candidate.
    }
    return isAccepted || didSelectFirstAvailable(rest, selectSession);
}

/**
 * Wraps the Workbench snapshot read for the first load after a render crash loop. When the previous crashes named the
 * Session the Server would restore, it selects another Session first and re-reads, so the Workbench never mounts the
 * crashing one. Any failure falls back to the plain snapshot: recovery must not make startup worse. Only the first read
 * consults the crash record, so later refreshes are plain reads.
 */
export function createRecoveringSnapshotSource(
    dependencies: RecoveringSnapshotDependencies,
): () => Promise<BootstrapState> {
    let isFirstRead = true;
    return async () => {
        const snapshot = await dependencies.readSnapshot();
        if (!isFirstRead) return snapshot;
        isFirstRead = false;
        const skipSessionId = takeSessionToSkip(dependencies.storage, dependencies.now());
        if (skipSessionId === undefined || snapshot.selectedSessionId !== skipSessionId) {
            return snapshot;
        }
        const selected = await didSelectFirstAvailable(
            fallbackSessionCandidates(snapshot, skipSessionId),
            dependencies.selectSession,
        );
        return selected ? dependencies.readSnapshot() : snapshot;
    };
}
