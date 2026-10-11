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
