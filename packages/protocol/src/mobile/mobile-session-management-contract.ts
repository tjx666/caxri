import { z } from 'zod';

import { identifierSchema } from '../domain/identifiers.js';
import { sessionRenameTitleSchema } from '../domain/session.js';
import { sessionConversationReferenceResultSchema } from '../domain/session-conversation-reference.js';
import { terminalKindSchema } from '../domain/terminal-record.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';

/**
 * An archived Session as the phone's Archived Sessions list shows it. Archived Sessions have no live Terminal, so only
 * the primary Agent's kind is projected, for the row's avatar.
 */
const mobileArchivedSessionSchema = z.strictObject({
    id: identifierSchema,
    projectId: identifierSchema,
    title: z.string().min(1).max(100),
    projectTitle: z.string().min(1).max(100),
    archivedAt: z.number().int().nonnegative(),
    agentKind: terminalKindSchema.optional(),
});

export const MOBILE_ARCHIVED_SESSIONS_MAX = 64;

const mobileArchivedSessionsResultSchema = z.strictObject({
    sessions: z.array(mobileArchivedSessionSchema).max(MOBILE_ARCHIVED_SESSIONS_MAX),
    total: z.number().int().nonnegative().max(4_096),
    truncated: z.boolean(),
});

/**
 * Session management from a phone returns only the affected identity; the dashboard subscription carries the new state.
 */
const mobileSessionMutationResultSchema = z.strictObject({ sessionId: identifierSchema });

/**
 * A phone's Session menu: rename, archive, restore, pin, delete, and Rename with AI, each forwarded to Desktop's own
 * `session.*` method, plus the Archived Sessions list and the Chat `@` Session reference.
 */
export const mobileSessionManagementMethods = {
    'mobile.session.rename': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({
            sessionId: identifierSchema,
            title: sessionRenameTitleSchema,
        }),
        result: mobileSessionMutationResultSchema,
    },
    'mobile.session.archive': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: mobileSessionMutationResultSchema,
    },
    'mobile.session.restore': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: mobileSessionMutationResultSchema,
    },
    /**
     * Pins or unpins a Session through Desktop's own `session.setPinned`, so the Pinned group is one list on both.
     */
    'mobile.session.setPinned': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({ sessionId: identifierSchema, pinned: z.boolean() }),
        result: mobileSessionMutationResultSchema,
    },
    /**
     * Deletes a Session's metadata through Desktop's own `session.delete`; the Project folder and user files stay. The
     * phone asks for confirmation itself, since Desktop's native dialog would open on the computer.
     */
    'mobile.session.delete': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: mobileSessionMutationResultSchema,
    },
    /**
     * Rename with AI: a title from the Session's Agent conversation through `session.suggestTitle`, not applied. The
     * phone fills its rename field with it and commits through `mobile.session.rename`.
     */
    'mobile.session.suggestTitle': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: z.strictObject({ title: sessionRenameTitleSchema }),
    },
    /**
     * Desktop's `session.conversationReference` for a Session granted to the device, so the phone's Chat `@` can cite
     * another Session's conversation. The Server writes the condensed file; the conversation never reaches the phone.
     */
    'mobile.session.conversationReference': {
        ...commandPolicy('server', 'control', ['sessions.read']),
        idempotency: 'none',
        params: z.strictObject({ sessionId: identifierSchema }),
        result: sessionConversationReferenceResultSchema,
    },
    'mobile.session.archived': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.strictObject({}),
        result: mobileArchivedSessionsResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type MobileArchivedSessionsResult = z.infer<typeof mobileArchivedSessionsResultSchema>;
