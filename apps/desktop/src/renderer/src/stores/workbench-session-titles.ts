import type { SessionRecord } from '@caxri/protocol';

interface PendingSessionTitle {
    attempt: number;
    /**
     * The newest title a Server snapshot reported while this rename was in flight; a failed rename falls back to it.
     */
    confirmedTitle: string;
    title: string;
}

/**
 * Manual renames the Renderer already shows but the Server has not committed yet. A Claude rename waits for the
 * provider CLI for seconds, and without this overlay every snapshot read during that window would put the old name
 * back.
 */
const pendingSessionTitles = new Map<string, PendingSessionTitle>();
const renameAttempts = { current: 0 };

export function beginPendingSessionTitle(
    sessionId: string,
    title: string,
    currentTitle: string,
): number {
    renameAttempts.current += 1;
    pendingSessionTitles.set(sessionId, {
        attempt: renameAttempts.current,
        confirmedTitle: pendingSessionTitles.get(sessionId)?.confirmedTitle ?? currentTitle,
        title,
    });
    return renameAttempts.current;
}

/**
 * Ends one rename attempt. Returns the title to restore when the newest attempt failed; an attempt a later rename has
 * already superseded changes nothing.
 */
export function settlePendingSessionTitle(
    sessionId: string,
    attempt: number,
    isCommitted: boolean,
): string | undefined {
    const pending = pendingSessionTitles.get(sessionId);
    if (pending?.attempt !== attempt) return undefined;
    pendingSessionTitles.delete(sessionId);
    return isCommitted ? undefined : pending.confirmedTitle;
}

export function withPendingSessionTitles(sessions: SessionRecord[]): SessionRecord[] {
    if (pendingSessionTitles.size === 0) return sessions;
    return sessions.map((session) => {
        const pending = pendingSessionTitles.get(session.id);
        if (!pending) return session;
        if (session.displayTitle !== pending.title) pending.confirmedTitle = session.displayTitle;
        return session.displayTitle === pending.title
            ? session
            : { ...session, displayTitle: pending.title };
    });
}
