import { mobileAgentDisplayName } from './agent-display-name';
import type { MobileSessionItem } from './session-model';

export const sessionAgentLabel = (session: MobileSessionItem): string => {
    const kind = session.primaryTerminal?.kind;
    return kind ? mobileAgentDisplayName(kind) : 'No Agent';
};

export const sessionAgeLabel = (lastOpenedAt: number, now: number): string => {
    const minutes = Math.max(0, Math.floor((now - lastOpenedAt) / 60_000));
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
};

export const archivedAgeLabel = (archivedAt: number, now: number): string => {
    const age = sessionAgeLabel(archivedAt, now);
    return age === 'now' ? 'archived just now' : `archived ${age} ago`;
};

/**
 * How old a saved copy shown in place of a live read is, as in `Showing Sessions saved 5m ago.`
 */
export const savedAgeLabel = (savedAt: number, now: number): string => {
    const age = sessionAgeLabel(savedAt, now);
    return age === 'now' ? 'saved just now' : `saved ${age} ago`;
};

/**
 * A Session's state for the screen reader. On a saved copy it says how old that state is, because a Session shown as
 * working may have finished since (`Working, as of 5m ago`).
 */
export const sessionStateLabel = (
    stateLabel: string,
    savedAt: number | null,
    now: number,
): string => {
    if (savedAt === null) return stateLabel;
    const age = sessionAgeLabel(savedAt, now);
    return `${stateLabel}, as of ${age === 'now' ? 'just now' : `${age} ago`}`;
};

/**
 * Which mark the Session status slot shows. A saved copy cannot know a Session is still running, so it never spins:
 * `running-saved` is a still glyph.
 */
export const sessionStatusGlyphKind = (
    session: Pick<MobileSessionItem, 'hasUnread' | 'lastActivityState'>,
    isSaved: boolean,
): 'attention' | 'running' | 'running-saved' | 'failed' | null => {
    if (session.hasUnread) return 'attention';
    if (session.lastActivityState === 'running') return isSaved ? 'running-saved' : 'running';
    if (session.lastActivityState === 'failed') return 'failed';
    return null;
};
