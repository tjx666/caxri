import { z } from 'zod';

import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy, ownerOnlyCommandPolicy } from '../transport/method-spec.js';
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
import { airplaneModeStateSchema } from './session/session-airplane-mode.js';
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
import { windowKeyParameter, windowKeySchema } from './window-presence-contract.js';

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
    attentionGeneration: z.number().int().nonnegative(),
    hasUnread: z.boolean(),
});
export const sessionMethods = {
    'session.compactWarm': {
        ...commandPolicy('server', 'control'),
        params: z.object({}),
        result: sessionCompactionResultSchema,
    },
    /**
     * Airplane Mode (docs/airplane-mode.md): interrupts running turns and compacts eligible Sessions, then stops every
     * Agent until the user resumes. Entering returns at once with the `compacting` phase; progress arrives as
     * `session.airplaneModeChanged`.
     */
    'session.enterAirplaneMode': {
        ...commandPolicy('server', 'control'),
        params: z.object({}),
        result: airplaneModeStateSchema,
    },
    /**
     * Stops waiting for the submitted compactions and parks every Agent now.
     */
    'session.skipAirplaneModeCompaction': {
        ...commandPolicy('server', 'control'),
        params: z.object({}),
        result: airplaneModeStateSchema,
    },
    /**
     * Leaves Airplane Mode and relaunches the Agents of `sessionIds`, which must be among the parked Sessions. The rest
     * stay detached and resume individually through `session.resume`.
     */
    'session.exitAirplaneMode': {
        ...commandPolicy('server', 'control'),
        params: z.object({ sessionIds: z.array(identifierSchema).max(1_000) }),
        result: airplaneModeStateSchema,
    },
    'session.airplaneModeStatus': {
        ...commandPolicy('server', 'read'),
        params: z.object({}),
        result: airplaneModeStateSchema,
    },
    /**
     * Finds Agent conversations across every provider's history on this machine, open, archived, or never in Caxri, by
     * title, conversation or Session ID, folder, and user or Agent message text. Owner-only: the results quote
     * conversation content.
     */
    'session.search': {
        ...ownerOnlyCommandPolicy('server', 'read', ['sessions.read']),
        params: sessionSearchParametersSchema,
        result: sessionSearchResultSchema,
    },
    /**
     * Adds a conversation found only in a provider's own history as a new Session with a parked Agent Terminal, in the
     * Project containing its folder (added when none does). Opening the Session resumes the conversation. Owner-only,
     * like `session.search` that finds the conversation.
     */
    'session.importConversation': {
        ...ownerOnlyCommandPolicy('server', 'write', ['sessions.write', 'projects.write']),
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
     * Makes `sessionId` the Session the requesting window shows (its only Open Session) and touches its recency. A
     * Session open in another window brings that window forward instead. `windowKey` is supplied by Desktop Main from
     * the trusted sender, never by a Renderer.
     */
    'session.select': {
        ...serverWrite,
        params: windowSessionParameters,
        result: windowSessionResultSchema,
    },
    'session.markRead': {
        ...commandPolicy('server', 'write', ['sessions.write']),
        params: z.object({
            sessionId: identifierSchema,
            attentionGeneration: z.number().int().nonnegative(),
        }),
        result: sessionAttentionReadResult,
    },
    /**
     * Owner-only: a title is the user's own naming, so neither an Agent Endpoint nor a paired phone sets it.
     */
    'session.rename': {
        ...ownerOnlyCommandPolicy('server', 'write', ['sessions.write']),
        params: z.object({
            sessionId: identifierSchema,
            title: sessionRenameTitleSchema,
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
        result: z.object({ title: sessionRenameTitleSchema }),
    },
    /**
     * Pinning is a durable user choice, not activity: it never touches `sidebarOrder` or the Session Activity clock, so
     * a pinned Session keeps its place inside its own Project group.
     */
    'session.setPinned': {
        ...ownerOnlyCommandPolicy('server', 'write', ['sessions.write']),
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
        ...ownerOnlyCommandPolicy('server', 'read', ['sessions.read']),
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
