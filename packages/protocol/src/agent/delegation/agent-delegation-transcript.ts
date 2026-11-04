import { z } from 'zod';

import { identifierSchema } from '../../domain/identifiers.js';
import { agentChatItemStatusSchema } from '../agent-chat-contract.js';

/**
 * Most rows one `agent.delegation.transcript` page returns.
 */
export const MAX_DELEGATION_TRANSCRIPT_ROWS = 100;

/**
 * Most characters of row text one page returns, summed over its rows. A page stops before the row that would pass it,
 * but always holds at least one row.
 */
export const MAX_DELEGATION_TRANSCRIPT_PAGE_TEXT = 64 * 1024;

/**
 * Longest text one row field carries, in characters; a longer field is clipped to its tail for command output and to
 * its head otherwise, and the row is marked `truncated`.
 */
export const MAX_DELEGATION_TRANSCRIPT_ROW_TEXT = 8 * 1024;

/**
 * Most changed paths one file-change row lists.
 */
export const MAX_DELEGATION_TRANSCRIPT_PATHS = 50;

/**
 * Why a delegated task's conversation cannot be read, as a closed set the reader acts on:
 *
 * - `disabled`: the owner turned `agents.delegation.readChildChat` off.
 * - `not_started`: the task has no Agent yet.
 * - `not_chat`: the task runs in a Terminal, whose output is not a typed conversation; read its answer instead.
 * - `projection_lost`: the Chat is not loaded in this Server Core (closed, or Server Core restarted). The read never
 *   starts the Agent to rebuild it.
 * - `boundary_unproven`: the Chat no longer shows where the task began (its start scrolled out of the kept window, or the
 *   conversation was replaced), so no row can be proven to be the task's.
 * - `cursor_invalid`: `after` came from another task or an earlier version of the conversation; read again without it.
 */
const delegationTranscriptUnavailableSchema = z.enum([
    'disabled',
    'not_started',
    'not_chat',
    'projection_lost',
    'boundary_unproven',
    'cursor_invalid',
]);
export type DelegationTranscriptUnavailable = z.infer<typeof delegationTranscriptUnavailableSchema>;

const rowText = z.string().max(MAX_DELEGATION_TRANSCRIPT_ROW_TEXT * 2);
const rowBase = {
    id: z.string().min(1).max(200),
    /**
     * Set when a field of this row was clipped to `MAX_DELEGATION_TRANSCRIPT_ROW_TEXT`.
     */
    truncated: z.literal(true).optional(),
};

const changedPath = z.strictObject({
    path: z.string().max(4_096),
    change: z.enum(['add', 'delete', 'update']),
});

/**
 * One step of a delegated Chat, reduced to what tells the delegating Agent what happened. Diffs, images, and tool
 * arguments are left out; the prompt is not repeated, only marked by the `task` row that starts the conversation.
 */
const delegationTranscriptRowSchema = z.discriminatedUnion('kind', [
    z.strictObject({ ...rowBase, kind: z.literal('task') }),
    z.strictObject({
        ...rowBase,
        kind: z.literal('agentMessage'),
        text: rowText,
        /**
         * True while the Agent is still writing this message; a later read returns it again in full.
         */
        streaming: z.literal(true).optional(),
    }),
    z.strictObject({
        ...rowBase,
        kind: z.literal('reasoning'),
        text: rowText,
        streaming: z.literal(true).optional(),
    }),
    z.strictObject({
        ...rowBase,
        kind: z.literal('command'),
        command: rowText,
        status: agentChatItemStatusSchema,
        exitCode: z.number().int().optional(),
        /**
         * The tail of the command's output.
         */
        output: rowText,
    }),
    z.strictObject({
        ...rowBase,
        kind: z.literal('fileChange'),
        status: agentChatItemStatusSchema,
        paths: z.array(changedPath).max(MAX_DELEGATION_TRANSCRIPT_PATHS),
    }),
    z.strictObject({
        ...rowBase,
        kind: z.literal('toolCall'),
        name: z.string().max(200),
        status: agentChatItemStatusSchema,
        summary: z.string().max(1_000).optional(),
    }),
    z.strictObject({
        ...rowBase,
        kind: z.literal('notice'),
        notice: z.enum(['error', 'warning', 'compacted', 'retrying', 'answered', 'output']),
        message: z.string().max(2_000).optional(),
    }),
]);

export type DelegationTranscriptRow = z.infer<typeof delegationTranscriptRowSchema>;

export const delegationTranscriptParametersSchema = z.strictObject({
    delegationId: identifierSchema,
    /**
     * The `next` of the previous page; rows after it are returned.
     */
    after: z.string().min(1).max(512).optional(),
});

/**
 * A page of a delegated task's own conversation: from the message that started the task up to the next message anyone
 * sent the Chat (the next task, or the user's first message after taking it over), or the end of the conversation.
 *
 * - `next` resumes after this page's rows; pass it as `after` to read only newer rows. While the task runs, a row that
 *   can still change (`streaming`, or `status: 'running'`) and every row after it are returned again by the next read,
 *   unless the page starts at that row and is full. It is absent when no row before such a row exists.
 * - `hasMore` is true when rows beyond this page already exist and none holds the page; read on with `next` now.
 * - `settled` is true when the Agent is no longer working on this task, so no further rows will follow.
 */
export type AgentDelegationTranscript =
    | {
          status: 'available';
          rows: DelegationTranscriptRow[];
          hasMore: boolean;
          settled: boolean;
          next?: string;
      }
    | { status: 'unavailable'; reason: DelegationTranscriptUnavailable };

/**
 * Annotated rather than inferred, like the receipt, so the method registry's inferred type stays within the compiler's
 * serialization limit.
 */
export const agentDelegationTranscriptSchema: z.ZodType<AgentDelegationTranscript> =
    z.discriminatedUnion('status', [
        z.strictObject({
            status: z.literal('available'),
            rows: z.array(delegationTranscriptRowSchema).max(MAX_DELEGATION_TRANSCRIPT_ROWS),
            hasMore: z.boolean(),
            settled: z.boolean(),
            next: z.string().min(1).max(512).optional(),
        }),
        z.strictObject({
            status: z.literal('unavailable'),
            reason: delegationTranscriptUnavailableSchema,
        }),
    ]);
