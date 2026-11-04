import { createHash } from 'node:crypto';

import type {
    AgentChatSnapshot,
    AgentDelegationTranscript,
    DelegationTranscriptRow,
    DelegationTranscriptUnavailable,
} from '@caxri/protocol';
import {
    isDelegationActive,
    logEventCatalog,
    MAX_DELEGATION_TRANSCRIPT_PAGE_TEXT,
    MAX_DELEGATION_TRANSCRIPT_ROWS,
    parseDelegatedRedirect,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { StoredAgentDelegation } from '../db';
import {
    delegationDirectionRow,
    delegationTranscriptRow,
    delegationTranscriptRowLength,
    isDelegationTranscriptRowFinished,
} from './transcript-rows';

/**
 * The part of a Chat's projection snapshot the transcript reads.
 */
export type DelegationTranscriptSnapshot = Pick<AgentChatSnapshot, 'items' | 'historyId'>;

/**
 * What reading a delegated task's Chat needs from Server Core. Every read is of the projection already in memory:
 * nothing here opens a Chat or starts its Agent.
 */
export interface DelegationTranscriptSource {
    readChildChat(): boolean;
    isChatTerminal(terminalId: string): boolean;
    snapshot(terminalId: string): DelegationTranscriptSnapshot | undefined;
    logger?: StructuredLogger;
}

/**
 * Binds a cursor to the task, the Chat history it was read from (a reset conversation starts a new one), and the row it
 * points at, in a fixed length whatever those IDs hold.
 */
function cursorDigest(delegationId: string, historyId: string, rowId: string): string {
    return createHash('sha256')
        .update(`${delegationId}\0${historyId}\0${rowId}`)
        .digest('base64url')
        .slice(0, 22);
}

/**
 * The cursor resuming after row `index` of the task's rows: its position and the digest that proves the row there is
 * still the same one.
 */
function encodeCursor(slice: AvailableSlice, delegationId: string, index: number): string {
    return `1.${index}.${cursorDigest(delegationId, slice.historyId, slice.rows[index].id)}`;
}

/**
 * The index of the row a cursor points at, or `undefined` when it belongs to another task, an earlier history, or a row
 * no longer at that position.
 */
function cursorIndex(
    slice: AvailableSlice,
    delegationId: string,
    value: string,
): number | undefined {
    const match = /^1\.(\d{1,6})\.([\w-]{22})$/u.exec(value);
    if (!match) return undefined;
    const index = Number(match[1]);
    const row = slice.rows.at(index);
    return row && cursorDigest(delegationId, slice.historyId, row.id) === match[2]
        ? index
        : undefined;
}

interface AvailableSlice {
    status: 'available';
    rows: DelegationTranscriptRow[];
    historyId: string;
}

type Slice = AvailableSlice | { status: 'unavailable'; reason: DelegationTranscriptUnavailable };

/**
 * The text of a user message that is a redirect of this task sitting in the conversation, or `undefined`. It must parse
 * as this task's redirect, match a claim of any state by operation ID and text digest, and not still wait for the
 * Agent. A claim that stays `pending` or `unknown` is included on purpose: refusing it tells the reader to look here to
 * learn whether the direction arrived, and a cut at the message would read as "not delivered". Claude Code holds a
 * steered message (`isAwaitingAgent`) out of order until its next model request, so a row built from it now would move
 * under a cursor already issued past it.
 */
function ownRedirectText(
    record: StoredAgentDelegation,
    item: Extract<AgentChatSnapshot['items'][number], { type: 'userMessage' }>,
): string | undefined {
    if (item.isAwaitingAgent) return undefined;
    const redirect = parseDelegatedRedirect(item.text);
    if (redirect?.delegationId !== record.receipt.delegationId) return undefined;
    const claim = record.redirects?.find((entry) => entry.operationId === redirect.operationId);
    return claim && claim.digest === createHash('sha256').update(redirect.text).digest('hex')
        ? redirect.text
        : undefined;
}

/**
 * The rows of the task's own conversation: from the message that started it (its task pointer) up to, not including,
 * the next message anyone sent the Chat. That next message is a later task or the user taking over, and either way what
 * follows is no longer this task's work, so the cut is structural and never by time. The one exception is this task's
 * own redirect, whatever its claim state, which continues the same turn and reads as a `direction` row.
 */
function taskSlice(source: DelegationTranscriptSource, record: StoredAgentDelegation): Slice {
    const terminalId = record.receipt.terminalId;
    if (!terminalId) return { status: 'unavailable', reason: 'not_started' };
    if (!source.isChatTerminal(terminalId)) return { status: 'unavailable', reason: 'not_chat' };
    const snapshot = source.snapshot(terminalId);
    if (!snapshot) return { status: 'unavailable', reason: 'projection_lost' };
    const { items } = snapshot;
    const start = items.findIndex(
        (item) =>
            item.type === 'userMessage' &&
            item.delegatedTask?.delegationId === record.receipt.delegationId,
    );
    if (start === -1) return { status: 'unavailable', reason: 'boundary_unproven' };
    const rows: DelegationTranscriptRow[] = [{ id: items[start].id, kind: 'task' }];
    const following = items.slice(start + 1);
    for (const item of following) {
        if (item.type === 'userMessage') {
            const direction = ownRedirectText(record, item);
            if (direction === undefined) break;
            rows.push(delegationDirectionRow(item.id, direction));
            continue;
        }
        const row = delegationTranscriptRow(item);
        if (row) rows.push(row);
    }
    return { status: 'available', rows, historyId: snapshot.historyId ?? '' };
}

/**
 * One page of the task's rows after `after`, within the row and text caps; see `AgentDelegationTranscript`.
 */
function page(
    record: StoredAgentDelegation,
    slice: AvailableSlice,
    after: string | undefined,
): AgentDelegationTranscript {
    const delegationId = record.receipt.delegationId;
    let from = 0;
    if (after !== undefined) {
        const index = cursorIndex(slice, delegationId, after);
        if (index === undefined) return { status: 'unavailable', reason: 'cursor_invalid' };
        from = index + 1;
    }
    const rows: DelegationTranscriptRow[] = [];
    let text = 0;
    for (const row of slice.rows.slice(from)) {
        if (rows.length === MAX_DELEGATION_TRANSCRIPT_ROWS) break;
        const length = delegationTranscriptRowLength(row);
        if (rows.length > 0 && text + length > MAX_DELEGATION_TRANSCRIPT_PAGE_TEXT) break;
        rows.push(row);
        text += length;
    }
    /**
     * A row still changing (text being written, a step still running) is returned but not resumed after, so the next
     * read returns it, and every row after it, again; while one holds the page it does not report `hasMore`, since
     * reading on at once would only return the same rows. Two cases never hold, so every row stays reachable:
     *
     * - A settled task: a background command can keep `running` after the Agent finished, and waiting on it would hide
     *   the rows after it for good.
     * - A page that starts at the open row and is full: holding would return the same page forever, so it moves on.
     */
    const isSettled = !isDelegationActive(record.receipt);
    const open = isSettled ? -1 : rows.findIndex((row) => !isDelegationTranscriptRowFinished(row));
    const hasRest = from + rows.length < slice.rows.length;
    const isHolds = open > 0 || (open === 0 && !hasRest);
    const resumeAt = from + (isHolds ? open : rows.length) - 1;
    return {
        status: 'available',
        rows,
        hasMore: !isHolds && hasRest,
        settled: isSettled,
        ...(resumeAt >= 0 && { next: encodeCursor(slice, delegationId, resumeAt) }),
    };
}

/**
 * Reads a page of what a delegated task's Chat did, for the Agent that delegated it. The caller has already proven it
 * owns the task; this never marks the answer read (the answer is `result`'s) and never starts the Agent: a Chat that is
 * not loaded reads as `projection_lost`.
 */
export function readDelegationChatPage(
    source: DelegationTranscriptSource,
    record: StoredAgentDelegation,
    after: string | undefined,
): AgentDelegationTranscript {
    const startedAt = performance.now();
    const slice: Slice = source.readChildChat()
        ? taskSlice(source, record)
        : { status: 'unavailable', reason: 'disabled' };
    const result = slice.status === 'available' ? page(record, slice, after) : slice;
    const rows = result.status === 'available' ? result.rows : [];
    source.logger?.write('info', logEventCatalog.agentDelegation.transcriptRead, {
        fields: {
            provider: record.receipt.provider,
            outcome: result.status,
            reason: result.status === 'unavailable' ? result.reason : null,
            isResumed: after !== undefined,
            rowCount: rows.length,
            textLength: rows.reduce((total, row) => total + delegationTranscriptRowLength(row), 0),
            isTruncated: rows.some((row) => row.truncated),
            hasMore: result.status === 'available' && result.hasMore,
            durationMs: Math.round(performance.now() - startedAt),
        },
    });
    return result;
}
