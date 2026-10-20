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
 * Per-window presence, sent only by Desktop Main (never reachable from a Renderer).
 */
export const windowPresenceInternalMethods = {
    'window.reportPresence': {
        ...serverWrite,
        params: windowPresenceReportSchema,
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
} as const;
