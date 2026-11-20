import { z } from 'zod';

import { agentEndpointRefSchema as agentEndpointReferenceSchema } from '../agent/agent-endpoint-contract.js';
import { sessionRecordSchema } from '../domain/domain.js';
import { identifierSchema } from '../domain/identifiers.js';
import { SESSION_ACTIVITY_GROUP_ORDER } from '../domain/session/session-activity-group.js';
import { sessionPullRequestSchema } from '../domain/session-pull-request.js';
import { terminalRecordSchema } from '../domain/terminal-record.js';

export const mobileDashboardSessionSchema = z.strictObject({
    id: identifierSchema,
    projectId: identifierSchema,
    title: z.string().min(1).max(100),
    projectTitle: z.string().min(1).max(100),
    /**
     * When the Session was created, with `createdBySessionId` what lets the phone find the Session a `/new-session`
     * hand-off created (`agentChatSessionHandoffTarget`).
     */
    createdAt: sessionRecordSchema.shape.createdAt.optional(),
    createdBySessionId: sessionRecordSchema.shape.createdBySessionId,
    /**
     * How the creating Session started this one. The home list leaves out a `consult` or `delegated` Session whose
     * creator it lists, since that work belongs to the creator rather than to the user.
     */
    createdByRelation: sessionRecordSchema.shape.createdByRelation,
    /**
     * Set when the creating Session is archived. The home list then gives a `consult` Session no row, the way Desktop's
     * Projects tree retires it (`retiredConsults`): an archived creator is absent from the list for the same reason as
     * a deleted one, and only this flag tells them apart.
     */
    createdBySessionArchived: z.literal(true).optional(),
    lastVisitedAt: sessionRecordSchema.shape.lastVisitedAt,
    /**
     * The Session's work clock, which orders rows inside a group on both Desktop and the phone.
     */
    sessionActivityAt: sessionRecordSchema.shape.sessionActivityAt,
    /**
     * When the latest turn started, which orders rows inside Running on both Desktop and the phone.
     */
    turnStartedAt: sessionRecordSchema.shape.turnStartedAt,
    pinnedAt: sessionRecordSchema.shape.pinnedAt,
    pinnedOrder: sessionRecordSchema.shape.pinnedOrder,
    agentActivityState: sessionRecordSchema.shape.agentActivityState,
    primaryAgentTerminalId: identifierSchema.optional(),
    primaryAgentEndpoint: agentEndpointReferenceSchema.optional(),
    attentionGeneration: sessionRecordSchema.shape.attentionGeneration,
    hasUnread: sessionRecordSchema.shape.hasUnread,
    hasPendingAttention: sessionRecordSchema.shape.hasPendingAttention,
    attentionResolvedAt: sessionRecordSchema.shape.attentionResolvedAt,
    /**
     * What the unread attention is about, so the row draws Desktop's shape: a question mark when the Agent waits on the
     * user, a dot for a result.
     */
    lastAttentionKind: sessionRecordSchema.shape.lastAttentionKind,
    /**
     * The Session's pull request as the row marks it (Desktop's sidebar glyph), read from the same cache as Desktop;
     * absent when none was discovered or the lookup failed.
     */
    pullRequest: sessionPullRequestSchema
        .pick({ number: true, state: true, deployment: true })
        .optional(),
    /**
     * The title of the linked worktree Project the Session works in, absent for the ordinary case.
     */
    worktreeTitle: z.string().min(1).max(100).optional(),
    primaryTerminal: terminalRecordSchema
        .pick({
            id: true,
            sessionId: true,
            kind: true,
            provider: true,
            lastProcessState: true,
            failureReason: true,
            usageLimitWaitAt: true,
            /**
             * `background` lets the row show Desktop's slow dotted ring while the Agent only waits on its own
             * background work, instead of the spinner of a live turn.
             */
            agentOperation: true,
            /**
             * `chat` tells the phone to open the Agent Chat projection instead of attaching to a PTY that does not
             * exist; see `docs/agent-chat.md`.
             */
            surface: true,
        })
        .optional(),
});

/**
 * The phone's home list groups, in list order: Pinned, then the status groups Desktop's Activity view uses. A pinned
 * Session belongs to Pinned only, so the groups partition the home rows and each has its own total and page.
 */
export const MOBILE_DASHBOARD_GROUPS = ['pinned', ...SESSION_ACTIVITY_GROUP_ORDER] as const;
const mobileDashboardGroupSchema = z.enum(MOBILE_DASHBOARD_GROUPS);
export type MobileDashboardGroup = z.infer<typeof mobileDashboardGroupSchema>;

/**
 * How many rows of each group a first read answers. The phone shows the first five of a windowed group and its first
 * reveal steps ten more, so one page covers that without another request.
 */
export const MOBILE_DASHBOARD_GROUP_PAGE_SIZE = 15;
/**
 * The most rows one `page` read answers; the reply byte budget may stop it sooner.
 */
export const MOBILE_DASHBOARD_PAGE_MAX = 50;
/**
 * The most Sessions one reply carries: a first read's four group pages, or one `page` read.
 */
export const MOBILE_DASHBOARD_SESSIONS_MAX =
    MOBILE_DASHBOARD_GROUPS.length * MOBILE_DASHBOARD_GROUP_PAGE_SIZE;

export const mobileDashboardParametersSchema = z
    .strictObject({
        /**
         * Lists only this Project's Sessions. `projects` still lists every Project the device may see.
         */
        projectId: identifierSchema.optional(),
        /**
         * Reads more of one group, from `offset` in its list order, instead of the first page of every group. The phone
         * asks for it when the reader reveals past the rows it holds.
         */
        page: z
            .strictObject({
                group: mobileDashboardGroupSchema,
                offset: z.number().int().nonnegative().max(4_096),
            })
            .optional(),
    })
    .default({});
export type MobileDashboardParameters = z.input<typeof mobileDashboardParametersSchema>;
