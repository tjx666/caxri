import { randomUUID } from 'node:crypto';

import type { AgentChatItem, AgentChatPatchOperation, AgentChatUsage } from '@caxri/protocol';

import { clip, isCompactionFailureNotice, isRecord, stringField } from '../../chat-items';
import type { AgentChatSessionHost } from '../../chat-provider';
import { claudeFeedbackItems } from '../../feedback/claude-feedback';

/**
 * Claude Code `system` frames that show as Chat state or notices rather than conversation content: compaction progress
 * and its result, and API retries. Inputs are untrusted JSON.
 */

type Json = Record<string, unknown>;
type AgentChatNoticeCompaction = NonNullable<
    Extract<AgentChatItem, { type: 'notice' }>['compaction']
>;

type Notice = Extract<AgentChatItem, { type: 'notice' }>;
type NoticeHost = Pick<AgentChatSessionHost, 'apply' | 'lifecycle' | 'read'>;
type RetryCause = NonNullable<Extract<AgentChatItem, { type: 'notice' }>['retry']>['cause'];

/**
 * Whether the active turn already shows a failed compaction. A failed `/compact` reports the same error twice, once as
 * the status's `compact_error` and once as the command's output (verified with Claude Code 2.1.312), and the Chat
 * showed both, one under the other.
 */
function hasCompactionFailure(host: Pick<NoticeHost, 'read'>, turnId: string | undefined): boolean {
    // Outside a turn there is nothing to tie the two reports together, and an older failure must not hide a new one.
    if (!turnId) return false;
    return host
        .read()
        .items.some((item) => item.turnId === turnId && isCompactionFailureNotice(item));
}

/**
 * Only explicit feedback belongs in Chat; successful Hook diagnostics remain internal. Returns the notices it added.
 */
export function applyClaudeFeedback(
    host: NoticeHost,
    message: Json,
    scope: 'agent' | 'session' = 'session',
): Notice[] {
    const turnId = host.read().activeTurnId;
    let items = claudeFeedbackItems(message, turnId, scope);
    if (items.some(isCompactionFailureNotice) && hasCompactionFailure(host, turnId))
        items = items.filter((item) => !isCompactionFailureNotice(item));
    if (items.length > 0) host.apply(items.map((item) => ({ op: 'upsertItem', item })));
    return items;
}

function didClearCompacting(host: NoticeHost): boolean {
    if (host.read().operation !== 'compacting') return false;
    host.apply([{ op: 'state', state: { operation: null } }]);
    return true;
}

/**
 * `system/status`: `compacting` while Claude Code summarizes the conversation, then back to `null` (or `requesting`)
 * with the compaction's result. A failed compaction leaves an error notice, since no `compact_boundary` follows it.
 */
export function onClaudeStatus(host: NoticeHost, message: Json): void {
    if (message.status === 'compacting') {
        if (host.read().operation === 'compacting') return;
        host.apply([{ op: 'state', state: { operation: 'compacting' } }]);
        host.lifecycle({ phase: 'compactionStarted' });
        return;
    }
    const wasCompacting = didClearCompacting(host);
    const error = stringField(message.compact_error);
    if (!error && message.compact_result !== 'failed') return;
    const turnId = host.read().activeTurnId;
    if (hasCompactionFailure(host, turnId)) {
        if (wasCompacting) host.lifecycle({ phase: 'compactionFinished' });
        return;
    }
    host.apply([
        {
            op: 'upsertItem',
            item: {
                id: clip(`compact-error:${stringField(message.uuid) ?? randomUUID()}`, 200),
                ...(turnId && { turnId }),
                type: 'notice',
                kind: 'error',
                message: clip(error ?? 'Claude could not compact the conversation', 2_000),
            },
        },
    ]);
    if (wasCompacting) host.lifecycle({ phase: 'compactionFinished' });
}

/**
 * `system/compact_boundary`: the conversation was compacted. Its notice also stands for the `/compact` command, whose
 * own user message the Chat never shows.
 */
export function onClaudeCompactBoundary(host: NoticeHost, message: Json): void {
    didClearCompacting(host);
    const { activeTurnId: turnId, usage } = host.read();
    const id = clip(`compact:${stringField(message.uuid) ?? randomUUID()}`, 200);
    const compaction = claudeCompaction(message);
    const operations: AgentChatPatchOperation[] = [
        {
            op: 'upsertItem',
            item: {
                id,
                ...(turnId && { turnId }),
                type: 'notice',
                kind: 'compacted',
                ...(compaction && { compaction }),
            },
        },
    ];
    if (usage)
        operations.push({ op: 'state', state: { usage: compactedUsage(usage, compaction) } });
    host.apply(operations);
    host.lifecycle({ phase: 'compactionFinished' });
}

/**
 * The context sizes a compaction reports. The live SDK frame spells them `compact_metadata.pre_tokens`; the transcript
 * Claude Code persists spells them `compactMetadata.preTokens` (verified with Claude Code 2.1.302).
 */
export function claudeCompaction(message: Json): AgentChatNoticeCompaction | undefined {
    const live = isRecord(message.compact_metadata) ? message.compact_metadata : undefined;
    const saved = isRecord(message.compactMetadata) ? message.compactMetadata : undefined;
    const beforeTokens = tokenCount(live?.pre_tokens ?? saved?.preTokens);
    const afterTokens = tokenCount(live?.post_tokens ?? saved?.postTokens);
    const trigger = live?.trigger ?? saved?.trigger;
    const compaction: AgentChatNoticeCompaction = {
        ...(beforeTokens !== undefined && { beforeTokens }),
        ...(afterTokens !== undefined && { afterTokens }),
        ...((trigger === 'manual' || trigger === 'auto') && { trigger }),
    };
    return Object.keys(compaction).length > 0 ? compaction : undefined;
}

/**
 * The usage right after a compaction. The context is now the summary, so the old total would keep suggesting another
 * compaction, and the prompt cache it was written to no longer matches: both cache notices would price a re-read of a
 * conversation that is gone. Without a reported size the total stays until the next response replaces it.
 */
function compactedUsage(
    usage: AgentChatUsage,
    compaction: AgentChatNoticeCompaction | undefined,
): AgentChatUsage {
    const next: AgentChatUsage = { ...usage };
    delete next.cacheRewriteUsd;
    delete next.lastResponseAt;
    if (compaction?.afterTokens !== undefined) {
        next.totalTokens = compaction.afterTokens;
        // The rows described the context before the summary replaced it.
        delete next.breakdown;
    }
    return next;
}

function tokenCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? value
        : undefined;
}

/**
 * Why Claude Code retries: `error_status` is null when the request got no response at all (a dropped connection, a
 * timeout), else its `error` category names the failure.
 */
function claudeRetryCause(message: Json): RetryCause {
    if (message.error_status === null) return 'connection';
    switch (message.error) {
        case 'rate_limit': {
            return 'rateLimit';
        }
        case 'overloaded': {
            return 'overloaded';
        }
        case 'server_error': {
            return 'server';
        }
        default: {
            return 'other';
        }
    }
}

function positiveCount(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;
}

/**
 * `system/api_retry`: one notice per turn, updated with the latest attempt and its cause.
 */
export function onClaudeApiRetry(host: NoticeHost, message: Json): void {
    const turnId = host.read().activeTurnId;
    if (!turnId) return;
    const attempt = positiveCount(message.attempt);
    const maxAttempts = positiveCount(message.max_retries);
    host.apply([
        {
            op: 'upsertItem',
            item: {
                id: clip(`${turnId}:retry`, 200),
                turnId,
                type: 'notice',
                kind: 'retrying',
                retry: {
                    cause: claudeRetryCause(message),
                    ...(attempt !== undefined && { attempt }),
                    ...(maxAttempts !== undefined && { maxAttempts }),
                },
            },
        },
    ]);
}
