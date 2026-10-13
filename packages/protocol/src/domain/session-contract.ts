import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { bootstrapStateSchema } from './bootstrap.js';
import {
    canceledResultSchema,
    permissionAutoAllowStatusSchema,
    sessionRecordSchema,
    sessionReorderParametersSchema,
} from './domain.js';
import { identifierSchema } from './identifiers.js';
import {
    sessionRenameTitleSchema,
    sessionRestorePlacementSchema,
    sessionStateSchema,
} from './session.js';
import { sessionCompactionResultSchema } from './session-compaction.js';
import {
    sessionConversationReferenceParametersSchema,
    sessionConversationReferenceResultSchema,
} from './session-conversation-reference.js';
import {
    sessionImportConversationParametersSchema,
    sessionImportConversationResultSchema,
    sessionSearchParametersSchema,
    sessionSearchResultSchema,
} from './session-search.js';
import { terminalKindSchema, terminalRecordSchema } from './terminal-record.js';
import { terminalSurfaceSchema } from './terminal-surface.js';

const serverWrite = commandPolicy('server', 'write');
const desktopWrite = commandPolicy('desktop', 'write');

/**
 * Bulk Session operations are bounded so one request cannot hold the mutation queue for an unbounded archive.
 */
const sessionIdBatchSchema = z.array(identifierSchema).min(1).max(200);
const sessionIdWrite = {
    ...serverWrite,
    params: z.object({ sessionId: identifierSchema }),
    result: sessionRecordSchema,
};
const sessionAttentionReadResult = z.object({
    acknowledged: z.boolean(),
    sessionId: identifierSchema,
    attentionEpoch: z.number().int().nonnegative(),
    hasUnread: z.boolean(),
});
export const sessionMethods = {
    'session.compactWarm': {
        ...commandPolicy('server', 'control'),
        params: z.object({}),
        result: sessionCompactionResultSchema,
    },
    /**
     * Finds Agent conversations across every provider's history on this machine, open, archived, or never in Caxri, by
     * title, conversation or Session ID, folder, and user or Agent message text. Owner-only: the results quote
     * conversation content.
     */
    'session.search': {
        ...commandPolicy('server', 'read'),
        params: sessionSearchParametersSchema,
        result: sessionSearchResultSchema,
    },
    /**
     * Adds a conversation found only in a provider's own history as a new Session with a parked Agent Terminal, in the
     * Project containing its folder (added when none does). Opening the Session resumes the conversation.
     */
    'session.importConversation': {
        ...serverWrite,
        params: sessionImportConversationParametersSchema,
        result: sessionImportConversationResultSchema,
    },
    /**
     * Condenses another Session's Agent conversation into a Caxri-owned Markdown file and returns its path, so a
     * composer can cite it as `@<path>`. The Server reads the transcript; the conversation never crosses the bridge.
     */
    'session.conversationReference': {
        ...commandPolicy('server', 'control'),
        idempotency: 'none',
        params: sessionConversationReferenceParametersSchema,
        result: sessionConversationReferenceResultSchema,
    },
    'session.reorder': {
        ...serverWrite,
        params: sessionReorderParametersSchema,
        result: z.null(),
    },
    'session.create': {
        ...serverWrite,
        params: z.object({
            projectId: identifierSchema,
            defaultAgent: terminalKindSchema.nullable(),
            /**
             * `chat` starts `defaultAgent` as an Agent Chat; it requires a provider whose catalog entry declares
             * `capabilities.chat`. Defaults to a PTY.
             */
            surface: terminalSurfaceSchema.optional(),
        }),
        result: z.object({
            session: sessionRecordSchema,
            terminal: terminalRecordSchema.nullable(),
        }),
    },
    'session.delete': {
        ...desktopWrite,
        params: z.object({ sessionId: identifierSchema }),
        result: z.union([canceledResultSchema, bootstrapStateSchema]),
    },
    /**
     * Bulk variant used by the Archived Sessions manager: one native confirmation covers every listed Session.
     */
    'session.deleteMany': {
        ...desktopWrite,
        params: z.object({ sessionIds: sessionIdBatchSchema }),
        result: z.union([canceledResultSchema, bootstrapStateSchema]),
    },
    'session.select': {
        ...serverWrite,
        params: z.object({ sessionId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.markRead': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.object({
            sessionId: identifierSchema,
            attentionEpoch: z.number().int().nonnegative(),
        }),
        result: sessionAttentionReadResult,
    },
    'session.rename': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            displayTitle: sessionRenameTitleSchema,
        }),
        result: sessionRecordSchema,
    },
    /**
     * Asks the Session's primary Agent provider for a title derived from its conversation, without applying it. The
     * caller commits the suggestion through `session.rename`, so it carries the same manual ownership as a typed name.
     */
    'session.suggestTitle': {
        ...commandPolicy('server', 'read'),
        params: z.object({ sessionId: identifierSchema }),
        result: z.object({ displayTitle: sessionRenameTitleSchema }),
    },
    /**
     * Pinning is a durable user choice, not activity: it never touches `sidebarOrder` or the Session Activity clock, so
     * a pinned Session keeps its place inside its own Project group.
     */
    'session.setPinned': {
        ...serverWrite,
        params: z.object({ sessionId: identifierSchema, pinned: z.boolean() }),
        result: sessionRecordSchema,
    },
    /**
     * Reorders the Pinned group. Shares `session.reorder`'s drag shape because it is the same gesture on a second list;
     * the two write different columns and never see each other's rows.
     */
    'session.reorderPinned': {
        ...serverWrite,
        params: sessionReorderParametersSchema,
        result: z.null(),
    },
    'session.archive': sessionIdWrite,
    'session.unarchive': {
        ...serverWrite,
        params: z.object({
            sessionId: identifierSchema,
            placement: sessionRestorePlacementSchema,
        }),
        result: sessionRecordSchema,
    },
    'session.unarchiveMany': {
        ...serverWrite,
        params: z.object({
            sessionIds: sessionIdBatchSchema,
            placement: sessionRestorePlacementSchema,
        }),
        result: z.array(sessionRecordSchema),
    },
    'session.detach': sessionIdWrite,
    'session.resume': sessionIdWrite,
    /**
     * Desktop-visible read of the in-memory "Always allow in this Session" grant (issue caxri#1295). Never durable, so
     * this is its own command rather than a `sessionRecordSchema` field; see `permissionAutoAllowStatusSchema`.
     */
    'session.permissionAutoAllowStatus': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: z.object({ sessionId: identifierSchema }),
        result: permissionAutoAllowStatusSchema,
    },
    /**
     * Desktop's revoke entry point for the same grant. Only mobile's `mobile.attention.answer` can enable it (a
     * `control`-role paired device); Desktop only ever observes and revokes.
     */
    'session.revokePermissionAutoAllow': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.object({ sessionId: identifierSchema }),
        result: permissionAutoAllowStatusSchema,
    },
    'session.updateState': {
        ...serverWrite,
        params: sessionStateSchema,
        result: sessionStateSchema,
    },
} as const satisfies Record<string, MethodSpec>;
