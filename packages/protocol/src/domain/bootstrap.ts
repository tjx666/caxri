import { z } from 'zod';

import { MAX_KEYBINDINGS } from '../configuration/configuration-contract.js';
import { appSettingsSchema } from '../configuration/settings-schema.js';
import {
    keybindingConflictSchema,
    keybindingSchema,
    projectRecordSchema,
    runtimeStatusSchema,
    sessionRecordSchema,
    themeTokensSchema,
} from './domain.js';
import { identifierSchema } from './identifiers.js';
import { lowCostSandboxFailureReasonSchema } from './low-cost-generation.js';
import { sessionStateSchema } from './session.js';
import { terminalRecordSchema } from './terminal-record.js';
import { windowKeyParameter } from './window-presence-contract.js';

/**
 * One automatic-naming suppression that is still in force.
 *
 * The Server sends the live `agent.automaticNamingUnavailable` event when the failure happens, but that event is
 * transient: with the last macOS window closed there is no Renderer to deliver it to, and the user would come back to a
 * Session that silently kept its placeholder name. Replaying the still-applicable notices in the bootstrap snapshot is
 * what makes the reason survive until a window exists again. `launchId` is the deduplication key a client uses so a
 * notice it already showed is not repeated when it merely reconnects.
 */
export const automaticNamingNoticeSchema = z.object({
    launchId: identifierSchema,
    reason: lowCostSandboxFailureReasonSchema,
    sessionId: identifierSchema,
});
export type AutomaticNamingNotice = z.infer<typeof automaticNamingNoticeSchema>;

/**
 * `app.bootstrap` for one window: Desktop Main supplies the key and the result carries that window's selection and Open
 * Sessions. Internal callers omit it.
 */
export const bootstrapParameters = z.object(windowKeyParameter).default({});

export const bootstrapStateSchema = z.object({
    /**
     * Suppressed automatic-naming launches that are still in force, newest last. Absent when nothing is blocked, the
     * same way `configurationErrors` is.
     */
    automaticNamingUnavailable: z.array(automaticNamingNoticeSchema).optional(),
    projects: z.array(projectRecordSchema),
    sessions: z.array(sessionRecordSchema),
    terminals: z.array(terminalRecordSchema),
    selectedProjectId: z.string().optional(),
    /**
     * The requesting window's active Session. Per window, not global: two windows each show their own Session.
     */
    selectedSessionId: z.string().optional(),
    /**
     * The requesting window's Open Sessions in strip order. A working set that readers must never treat as a source of
     * truth for existence; the Server already drops archived, deleted, and hidden Sessions. Absent means none.
     */
    openSessionIds: z.array(z.string()).optional(),
    /**
     * The requesting window's Preview entry (one of `openSessionIds`): the tab a plain sidebar click replaces. Absent
     * means every entry is kept.
     */
    previewSessionId: z.string().optional(),
    /**
     * Sessions that are Open Sessions of another window, so the sidebar can mark them "open in another window". A
     * Session is open in at most one window, so this never overlaps `openSessionIds`. Absent means none.
     */
    otherWindowOpenSessionIds: z.array(z.string()).optional(),
    sessionStates: z.array(sessionStateSchema),
    settings: appSettingsSchema,
    keybindings: z.array(keybindingSchema).max(MAX_KEYBINDINGS),
    keybindingConflicts: z.array(keybindingConflictSchema).max(MAX_KEYBINDINGS),
    configurationErrors: z.array(z.string()).optional(),
    theme: themeTokensSchema,
    runtime: z.object({
        status: runtimeStatusSchema,
        restartCount: z.number(),
    }),
});
export type BootstrapState = z.infer<typeof bootstrapStateSchema>;
