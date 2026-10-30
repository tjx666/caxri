import { z } from 'zod';

import { agentEndpointRefSchema as agentEndpointReferenceSchema } from '../agent/agent-endpoint-contract.js';
import { sessionRecordSchema } from '../domain/domain.js';
import { identifierSchema } from '../domain/identifiers.js';
import { sessionPullRequestSchema } from '../domain/session-pull-request.js';
import { terminalRecordSchema } from '../domain/terminal-record.js';

export const mobileDashboardSessionSchema = z.strictObject({
    id: identifierSchema,
    projectId: identifierSchema,
    title: z.string().min(1).max(100),
    projectTitle: z.string().min(1).max(100),
    lastVisitedAt: sessionRecordSchema.shape.lastVisitedAt,
    /**
     * The Session's work clock, which orders rows inside a group on both Desktop and the phone.
     */
    sessionActivityAt: sessionRecordSchema.shape.sessionActivityAt,
    pinnedAt: sessionRecordSchema.shape.pinnedAt,
    pinnedOrder: sessionRecordSchema.shape.pinnedOrder,
    agentActivityState: sessionRecordSchema.shape.agentActivityState,
    primaryAgentTerminalId: identifierSchema.optional(),
    primaryAgentEndpoint: agentEndpointReferenceSchema.optional(),
    attentionGeneration: sessionRecordSchema.shape.attentionGeneration,
    hasUnread: sessionRecordSchema.shape.hasUnread,
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
             * `chat` tells the phone to open the Agent Chat projection instead of attaching to a PTY that does not
             * exist; see `docs/agent-chat.md`.
             */
            surface: true,
        })
        .optional(),
});
