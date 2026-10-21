import { z } from 'zod';

import { commandPolicy } from '../transport/method-spec.js';
import { identifierSchema } from './identifiers.js';

const serverWrite = commandPolicy('server', 'write');

/**
 * Stable identity of one Desktop Workbench window below its Client ID. One Desktop Main shares a single lease and
 * connection across every window, so the Server can only tell windows apart by this key. Desktop Main mints it and
 * injects it from the trusted `event.sender`; a Renderer never supplies its own.
 */
export const windowKeySchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[\w-]+$/);
export type WindowKey = z.infer<typeof windowKeySchema>;

/**
 * The optional window a request acts for: Desktop Main supplies it for the calling Renderer, and the Server fills the
 * result (`selectedSessionId`, `openSessionIds`, the fallback after a delete) from that window's record. Internal
 * callers and CLI clients omit it.
 */
export const windowKeyParameter = { windowKey: windowKeySchema.optional() };

/**
 * Where a Session created for a window lands in its Open Sessions. Creation behaves like a plain select by default (an
 * open Session is activated, otherwise the active entry is replaced), so creating a Session never grows the strip on
 * its own. `newTab` is the explicit opt-in used by the tab strip's `+` button, which appends the new Session.
 */
export const sessionPlacementSchema = z.enum(['newTab']);
export type SessionPlacement = z.infer<typeof sessionPlacementSchema>;

/**
 * Requests that act for one Desktop window. Desktop Main injects the sender's {@link WindowKey} into exactly these
 * (overwriting anything a Renderer supplied), so a Renderer can never act as another window. A caller without a window,
 * such as the CLI, omits the key and gets no per-window effect.
 */
export const windowScopedMethods = [
    'app.bootstrap',
    'project.delete',
    'project.hide',
    'session.create',
    'session.delete',
    'session.deleteMany',
    'session.resume',
    'session.select',
    'terminal.moveToNewSession',
    'window.openSessions.set',
] as const;
export type WindowScopedMethod = (typeof windowScopedMethods)[number];

const windowScopedMethodSet: ReadonlySet<string> = new Set(windowScopedMethods);

export function isWindowScopedMethod(method: string): method is WindowScopedMethod {
    return windowScopedMethodSet.has(method);
}

/**
 * Upper bound on the Open Sessions of one window. Open Sessions are a working set, not a source of truth for existence,
 * so the bound only protects the persisted cell and the strip from unbounded growth.
 */
export const MAX_OPEN_SESSIONS_PER_WINDOW = 100;

export const openSessionIdsSchema = z.array(identifierSchema).max(MAX_OPEN_SESSIONS_PER_WINDOW);

/**
 * One window's Open Session working set: the ordered strip and which entry the window currently shows.
 */
export const windowOpenSessionsSchema = z.object({
    openSessionIds: openSessionIdsSchema,
    activeSessionId: identifierSchema.nullable(),
});
export type WindowOpenSessions = z.infer<typeof windowOpenSessionsSchema>;

/**
 * What one window reports about itself. In memory on the Server only: it is never persisted, and Desktop Main reseeds
 * it after a reconnect.
 */
export const windowPresenceReportSchema = z.object({
    windowKey: windowKeySchema,
    /**
     * The Session the window currently renders, or `null` when it shows none.
     */
    viewingSessionId: identifierSchema.nullable(),
    /**
     * Native keyboard focus, owned by Main rather than the DOM so a minimized or occluded window cannot claim it.
     */
    focused: z.boolean(),
    /**
     * False while the window is hidden or minimized; its viewed Session then does not count as visible.
     */
    visible: z.boolean(),
});
export type WindowPresenceReport = z.infer<typeof windowPresenceReportSchema>;

/**
 * Every live window of one connection as a single atomic snapshot. Main sends it while it re-attaches, before the
 * connection serves any Renderer request, so the Server never acts on a half-seeded or empty view after a reconnect.
 * `focusedAt` keeps the focus history (epoch milliseconds, `0` when the window never had focus), so "the most recently
 * focused window" survives the restart.
 */
const seededWindowSchema = windowPresenceReportSchema.extend({
    focusedAt: z.number().int().nonnegative(),
});
export const windowPresenceSeedSchema = z.object({ windows: z.array(seededWindowSchema).max(64) });
export type WindowPresenceSeed = z.infer<typeof windowPresenceSeedSchema>;

/**
 * One torn-off window's persisted strip, keyed by the window key Main minted for it.
 */
export const tearOffWindowSchema = windowOpenSessionsSchema.extend({ windowKey: windowKeySchema });
export type TearOffWindow = z.infer<typeof tearOffWindowSchema>;

/**
 * Per-window presence, sent only by Desktop Main (never reachable from a Renderer).
 */
export const windowPresenceInternalMethods = {
    'window.reportPresence': {
        ...serverWrite,
        params: windowPresenceReportSchema,
        result: z.null(),
    },
    /**
     * Replaces every window row of the calling connection at once and marks presence as reported.
     */
    'window.seedPresence': {
        ...serverWrite,
        params: windowPresenceSeedSchema,
        result: z.null(),
    },
    /**
     * Forgets a window that closed. A connection loss drops every row of that connection on its own.
     */
    'window.closePresence': {
        ...serverWrite,
        params: z.object({ windowKey: windowKeySchema }),
        result: z.null(),
    },
    /**
     * Moves one Open Session out of a window's strip into a new window's strip in a single transaction, so a Session is
     * never in zero or two windows. Main mints `targetWindowKey` (a Renderer cannot), and the Server rejects the move
     * when the Session is not open in the source, is its last tab, or the target already has a strip.
     */
    'window.openSessions.moveToWindow': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            windowKey: windowKeySchema,
            targetWindowKey: windowKeySchema,
        }),
        result: z.object({
            source: windowOpenSessionsSchema,
            target: windowOpenSessionsSchema,
        }),
    },
    /**
     * Forgets the strip of a torn-off window the user closed, which frees its Sessions for any window to open. The
     * primary window's record is never released.
     */
    'window.openSessions.release': {
        ...serverWrite,
        params: z.object({ windowKey: windowKeySchema }),
        result: z.null(),
    },
    /**
     * The persisted strips of every window other than the primary, so Main can reopen torn-off windows on launch.
     */
    'window.openSessions.listTearOffs': {
        ...commandPolicy('server', 'read'),
        params: z.object({}),
        result: z.array(tearOffWindowSchema),
    },
} as const;
