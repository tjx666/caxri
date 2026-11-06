import type { PortalItems } from './portal-items';

/**
 * Device-local key for every Session's Portal items. Presentation state of this window profile, like the Portal's
 * width, so it lives in `localStorage` and never reaches Server Core.
 */
export const PORTAL_STORAGE_KEY = 'caxri.agentChatPortal';

const PORTAL_STORAGE_VERSION = 1;
/**
 * Bounds so a profile that opened Portals in many Sessions never grows the entry without limit: the newest Sessions
 * win.
 */
const MAX_PERSISTED_PORTAL_SESSIONS = 100;
const MAX_PERSISTED_PORTAL_ITEMS = 16;

export type PortalItemsBySession = Readonly<Record<string, PortalItems>>;

/**
 * The stored form of `bySession`. Each item path names its owning Chat (`besideChatTabTerminalId`), so restoring the
 * paths restores the owner too.
 */
export function serializePortalItems(bySession: PortalItemsBySession): unknown {
    const entries = Object.entries(bySession).slice(-MAX_PERSISTED_PORTAL_SESSIONS);
    return {
        version: PORTAL_STORAGE_VERSION,
        sessions: Object.fromEntries(
            entries.map(([sessionId, items]) => [
                sessionId,
                { paths: items.paths, activePath: items.activePath },
            ]),
        ),
    };
}

/**
 * Reads a stored value back into `bySession`, dropping anything malformed (another version, a non-string path, an empty
 * list) instead of failing: a corrupt entry only means the Portals start closed.
 */
export function parsePortalItems(raw: unknown): Record<string, PortalItems> {
    if (typeof raw !== 'object' || raw === null) return {};
    const { sessions, version } = raw as { sessions?: unknown; version?: unknown };
    if (version !== PORTAL_STORAGE_VERSION || typeof sessions !== 'object' || sessions === null)
        return {};
    const result: Record<string, PortalItems> = {};
    const stored = Object.entries(sessions).slice(-MAX_PERSISTED_PORTAL_SESSIONS);
    for (const [sessionId, value] of stored) {
        if (typeof value !== 'object' || value === null) continue;
        const { activePath, paths } = value as { activePath?: unknown; paths?: unknown };
        if (!Array.isArray(paths)) continue;
        const unique = [
            ...new Set(
                paths.filter((path): path is string => typeof path === 'string' && path.length > 0),
            ),
        ].slice(0, MAX_PERSISTED_PORTAL_ITEMS);
        if (unique.length === 0) continue;
        result[sessionId] = {
            paths: unique,
            activePath:
                typeof activePath === 'string' && unique.includes(activePath)
                    ? activePath
                    : unique[0],
        };
    }
    return result;
}
