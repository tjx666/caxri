import { environmentOfProject, environmentOfSession } from '../../../lib/environment-routing';
import { createSharedLocalState } from '../../../lib/local-storage';
import { storageScopeOf } from '../../../stores/environment';
import type { PortalItems } from './portal-items';

/**
 * Device-local key for every Session's Portal items. Presentation state of this window profile, like the Portal's
 * width, so it lives in `localStorage` and never reaches Server Core. Every window of the profile shares it
 * (docs/client-local-data.md), so the entry is a record keyed by Session id and each write patches only the Sessions it
 * changed. The `v2` suffix marks the keyed-record shape; the earlier single-blob entry is simply no longer read.
 */
export const PORTAL_STORAGE_KEY = 'caxri.agentChatPortal.v2';

/**
 * Bounds so a profile that opened Portals in many Sessions never grows the entry without limit: the newest Sessions
 * win.
 */
const MAX_PERSISTED_PORTAL_SESSIONS = 100;
const MAX_PERSISTED_PORTAL_ITEMS = 16;

/**
 * A Session's Portal items and the machine that owns the Session (`storageScopeOf`: `local` or `ssh:<host identity>`).
 * The owner is what lets a window prune only Sessions it can positively judge: a window that does not list a machine's
 * Sessions must not read their absence as deletion.
 */
export interface PortalEntry {
    items: PortalItems;
    scope: string;
}

/**
 * The stored form of one Session's entry. Each item path names its owning Chat (`besideChatTabTerminalId`), so
 * restoring the paths restores the owner too.
 */
export function serializePortalEntry({ items, scope }: PortalEntry): unknown {
    return { paths: items.paths, activePath: items.activePath, scope };
}

/**
 * Reads a stored record back into entries, dropping anything malformed (a non-string path, an empty list) instead of
 * failing: a corrupt entry only means those Portals start closed. An entry without a scope belongs to this Mac.
 */
export function parsePortalEntries(raw: unknown): Record<string, PortalEntry> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    const result: Record<string, PortalEntry> = {};
    for (const [sessionId, value] of Object.entries(raw)) {
        if (typeof value !== 'object' || value === null) continue;
        const { activePath, paths, scope } = value as {
            activePath?: unknown;
            paths?: unknown;
            scope?: unknown;
        };
        if (!Array.isArray(paths)) continue;
        const unique = [
            ...new Set(
                paths.filter((path): path is string => typeof path === 'string' && path.length > 0),
            ),
        ].slice(0, MAX_PERSISTED_PORTAL_ITEMS);
        if (unique.length === 0) continue;
        result[sessionId] = {
            items: {
                paths: unique,
                activePath:
                    typeof activePath === 'string' && unique.includes(activePath)
                        ? activePath
                        : unique[0],
            },
            scope: typeof scope === 'string' && scope.length > 0 ? scope : 'local',
        };
    }
    return result;
}

const sharedPortalEntries = createSharedLocalState(PORTAL_STORAGE_KEY, parsePortalEntries);

export const readPortalEntries = sharedPortalEntries.read;
export const subscribePortalEntries = sharedPortalEntries.subscribe;

/**
 * Writes the changed Sessions into the shared record (`undefined` removes one) and returns the merged record, which
 * includes Sessions other windows saved. Past the bound the oldest Sessions (first in the record) are dropped.
 */
export function persistPortalEntries(
    changes: Readonly<Record<string, PortalEntry | undefined>>,
): Record<string, PortalEntry> {
    const merged = sharedPortalEntries.patch(
        Object.fromEntries(
            Object.entries(changes).map(([sessionId, entry]) => [
                sessionId,
                entry && serializePortalEntry(entry),
            ]),
        ),
    );
    const excess = Object.keys(merged).slice(0, -MAX_PERSISTED_PORTAL_SESSIONS);
    if (excess.length === 0) return merged;
    return sharedPortalEntries.patch(
        Object.fromEntries(excess.map((sessionId) => [sessionId, undefined])),
    );
}

/**
 * Answers `pruneSessions` for one window's workbench snapshot: a stored Portal entry is deleted only when its owning
 * machine is one this window lists (it holds a Project or Session of that machine) and the Session is not among the
 * snapshot's Sessions.
 *
 * Every window shares the stored entries, but a window lists only the machines it is connected to, so judging absence
 * against its own list alone would wipe the Portal items of Sessions it simply cannot see (an SSH Host window deleting
 * this Mac's, or the reverse). A machine with no Project in the snapshot stays unjudged and its entries survive.
 */
export function portalSessionDeletion(snapshot: {
    projects: ReadonlyArray<{ id: string }>;
    sessions: ReadonlyArray<{ id: string }>;
}): (sessionId: string, scope: string) => boolean {
    const liveSessionIds = new Set(snapshot.sessions.map((session) => session.id));
    const listedScopes = new Set([
        ...snapshot.projects.map((project) => storageScopeOf(environmentOfProject(project.id))),
        ...snapshot.sessions.map((session) => storageScopeOf(environmentOfSession(session.id))),
    ]);
    return (sessionId, scope) => listedScopes.has(scope) && !liveSessionIds.has(sessionId);
}
