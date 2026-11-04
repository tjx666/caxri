import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type {
    DelegationHistoryEntry,
    DelegationHistoryOutcome,
    DelegationHistoryResult,
} from '@caxri/protocol';
import { CaxriError, MAX_DELEGATION_HISTORY_PAGE } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { likeSubstringPattern } from '@caxri/utils';

import type { CaxriDatabase, DelegationHistoryRow, DelegationHistoryScope } from '../../db';
import type { DelegationAuthority } from '../admission';
import { isCaxriBotCaller } from '../admission';
import { isDelegationOwnerPrincipal } from '../ownership';
import { principalHash } from './row';

export interface HistoryParameters {
    query?: string | undefined;
    outcome?: DelegationHistoryOutcome | undefined;
    limit: number;
    after?: string | undefined;
}

interface Cursor {
    v: 1;
    /**
     * Binds the cursor to the query, outcome, and caller it was issued for.
     */
    s: string;
    c: number;
    i: string;
}

/**
 * The reader's row filter, from the same rule `isDelegationOwner` applies to a task: every principal except an Agent or
 * delegation client reads all rows; those two read the rows their exact Terminal and Endpoint generation created, and
 * Caxri Bot reads its Terminal's rows under any generation.
 */
function historyScope(
    database: CaxriDatabase,
    authority: DelegationAuthority,
): DelegationHistoryScope {
    if (isDelegationOwnerPrincipal(authority.principal)) return { kind: 'owner' };
    return {
        kind: 'caller',
        terminalId: authority.callerTerminalId,
        principalHash: principalHash(authority.principal),
        anyPrincipal: isCaxriBotCaller(database, authority),
    };
}

function scopeKey(
    scope: DelegationHistoryScope,
    query: string | undefined,
    outcome: string | undefined,
): string {
    return createHash('sha256')
        .update(JSON.stringify([scope, query ?? null, outcome ?? null]))
        .digest('hex')
        .slice(0, 16);
}

function encodeCursor(cursor: Cursor): string {
    return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(text: string, expectedScope: string): Cursor {
    try {
        const value = JSON.parse(
            Buffer.from(text, 'base64url').toString('utf8'),
        ) as Partial<Cursor>;
        if (
            value.v === 1 &&
            value.s === expectedScope &&
            typeof value.c === 'number' &&
            Number.isSafeInteger(value.c) &&
            typeof value.i === 'string' &&
            value.i.length > 0 &&
            value.i.length <= 256
        )
            return value as Cursor;
    } catch {
        // Falls through to the refusal below.
    }
    throw new CaxriError('VALIDATION', 'The history cursor is not valid for this request', {
        reason: 'history_cursor_invalid',
    });
}

function entry(row: DelegationHistoryRow): DelegationHistoryEntry {
    const hasUsage =
        row.usageScope !== null && row.inputTokens !== null && row.outputTokens !== null;
    return {
        delegationId: row.delegationId,
        rootDelegationId: row.rootDelegationId,
        ...(row.retryOf && { retryOf: row.retryOf }),
        sessionId: row.sessionId,
        outcome: row.outcome as DelegationHistoryOutcome,
        ...(row.failure && { failure: row.failure as DelegationHistoryEntry['failure'] }),
        provider: row.provider,
        ...((row.selectionModel ?? row.selectionEffort) && {
            selection: {
                ...(row.selectionModel && { model: row.selectionModel }),
                ...(row.selectionEffort && {
                    effort: row.selectionEffort as NonNullable<
                        NonNullable<DelegationHistoryEntry['selection']>['effort']
                    >,
                }),
            },
        }),
        ...(row.title && { title: row.title }),
        ...(row.summary && {
            summary: row.summary,
            summarySource: row.summarySource as 'authored' | 'excerpt',
        }),
        createdAt: row.createdAt,
        settledAt: row.settledAt,
        ...(hasUsage && {
            usage: {
                scope: row.usageScope as 'main-thread' | 'provider-task',
                inputTokens: row.inputTokens!,
                outputTokens: row.outputTokens!,
                ...(row.cacheReadTokens !== null && { cacheReadTokens: row.cacheReadTokens }),
                ...(row.cacheWriteTokens !== null && { cacheWriteTokens: row.cacheWriteTokens }),
                ...(row.reasoningTokens !== null && { reasoningTokens: row.reasoningTokens }),
                ...(row.totalTokens !== null && { totalTokens: row.totalTokens }),
            },
        }),
        compacted: row.compactedAt !== null,
    };
}

function queryLengthBucket(length: number): string {
    if (length === 0) return '0';
    if (length <= 8) return '1-8';
    return length <= 32 ? '9-32' : '33+';
}

/**
 * One page of the caller's settled tasks, newest created first. Never reads an answer and never claims one. The log
 * line carries counts and closed values only: not the query, the cursor, a title, a summary, or an ID.
 */
export function readHistory(
    database: CaxriDatabase,
    authority: DelegationAuthority,
    parameters: HistoryParameters,
    logger?: StructuredLogger,
    now: () => number = Date.now,
): DelegationHistoryResult {
    const startedAt = now();
    const { query, outcome, after } = parameters;
    const limit = Math.min(parameters.limit, MAX_DELEGATION_HISTORY_PAGE);
    const scope = historyScope(database, authority);
    const log = (result: 'ok' | 'cursor_invalid', entryCount: number, hasMore: boolean): void =>
        logger?.write('info', logEventCatalog.agentDelegation.historyRead, {
            fields: {
                principalKind: authority.principal.kind,
                outcomeFilter: outcome ?? 'none',
                hasQuery: query !== undefined,
                queryLength: queryLengthBucket(query?.length ?? 0),
                entryCount,
                hasMore,
                durationMs: now() - startedAt,
                result,
            },
        });
    const key = scopeKey(scope, query, outcome);
    let cursor: Cursor | undefined;
    try {
        cursor = after ? decodeCursor(after, key) : undefined;
    } catch (error) {
        log('cursor_invalid', 0, false);
        throw error;
    }
    const rows = database.agentDelegations.history.page({
        scope,
        ...(query && { pattern: likeSubstringPattern(query) }),
        ...(outcome && { outcome }),
        limit,
        ...(cursor && { after: { createdAt: cursor.c, delegationId: cursor.i } }),
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    log('ok', page.length, hasMore);
    return {
        entries: page.map((row) => entry(row)),
        ...(hasMore &&
            last && {
                nextCursor: encodeCursor({ v: 1, s: key, c: last.createdAt, i: last.delegationId }),
            }),
        hasMore,
    };
}
