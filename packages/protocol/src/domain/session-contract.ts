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
import {
    sessionAgentHistoryResultSchema,
    sessionReopenConversationParametersSchema,
    sessionReopenConversationResultSchema,
} from './session-agent-history.js';
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
import {
    openSessionIdsSchema,
    sessionPlacementSchema,
    windowKeyParameter,
    windowKeySchema,
    windowOpenSessionsSchema,
} from './window-presence-contract.js';

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
/**
 * A Session operation that also moves the requesting window's active Session.
 */
const windowSessionParameters = z.object({ sessionId: identifierSchema, ...windowKeyParameter });
/**
 * The Session a window asked to open, plus the window that owns it when the request was redirected. A Session is an
 * Open Session of at most one window, so asking another window to select it leaves the requester unchanged and
 * activates it in the owner, which `ownerWindowKey` names so Desktop Main can raise that window.
 */
const windowSessionResultSchema = sessionRecordSchema.extend({
    ownerWindowKey: windowKeySchema.optional(),
});
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
     * Every Agent conversation the Session's Terminals have been bound to, from the usage ledger, so the Session hover
     * card can bring back one whose Terminal was closed or reused. Owner-only: titles quote conversation content.
     */
    'session.agentHistory': {
        ...commandPolicy('server', 'read'),
        params: z.object({ sessionId: identifierSchema }),
        result: sessionAgentHistoryResultSchema,
    },
    /**
     * Brings back a conversation from `session.agentHistory` as a parked Agent Terminal in the same Session; revealing
     * it resumes the conversation. A conversation one of the Session's Terminals still holds returns that Terminal.
     */
    'session.reopenConversation': {
        ...serverWrite,
        params: sessionReopenConversationParametersSchema,
        result: sessionReopenConversationResultSchema,
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
            /**
             * The window that becomes active on the new Session. Supplied by Desktop Main.
             */
            ...windowKeyParameter,
            /**
             * `newTab` appends the new Session to the window's Open Sessions; omitted, creation replaces the active
             * entry like a plain select.
             */
            placement: sessionPlacementSchema.optional(),
        }),
        result: z.object({
            session: sessionRecordSchema,
            terminal: terminalRecordSchema.nullable(),
        }),
    },
    'session.delete': {
        ...desktopWrite,
        params: windowSessionParameters,
        result: z.union([canceledResultSchema, bootstrapStateSchema]),
    },
    /**
     * Bulk variant used by the Archived Sessions manager: one native confirmation covers every listed Session.
     */
    'session.deleteMany': {
        ...desktopWrite,
        params: z.object({
            sessionIds: sessionIdBatchSchema,
            ...windowKeyParameter,
        }),
        result: z.union([canceledResultSchema, bootstrapStateSchema]),
    },
    /**
     * Makes `sessionId` the requesting window's active Session, adds it to that window's Open Sessions, and touches its
     * recency. `windowKey` is supplied by Desktop Main from the trusted sender, never by a Renderer.
     */
    'session.select': {
        ...serverWrite,
        params: windowSessionParameters,
        result: windowSessionResultSchema,
    },
    /**
     * Replaces the requesting window's Open Sessions strip with the ordered IDs. It never carries the active Session:
     * that changes only through `session.select`, so a delayed strip save cannot overwrite a newer selection. The
     * Server drops unknown, archived, and hidden Sessions; when the active entry is no longer listed it moves to that
     * entry's neighbor in the previous strip. It answers with the strip and active Session it stored. Navigating to a
     * Session goes through `session.select`; this method adds an entry without selecting it, reorders, and closes.
     */
    'window.openSessions.set': {
        ...serverWrite,
        params: z.object({
            ...windowKeyParameter,
            openSessionIds: openSessionIdsSchema,
        }),
        result: windowOpenSessionsSchema,
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
    'session.resume': {
        ...sessionIdWrite,
        params: windowSessionParameters,
        result: windowSessionResultSchema,
    },
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
