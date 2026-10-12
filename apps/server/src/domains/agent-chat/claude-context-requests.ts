import type { AgentChatContextRequest } from '@caxri/protocol';
import { MAX_AGENT_CHAT_CONTEXT_REQUESTS } from '@caxri/protocol';

import { estimateCacheRewriteUsd } from '../usage';
import { clip, isRecord, stringField } from './chat-items';
import { claudeCacheTtlMinutes } from './claude-context';

/**
 * The main conversation's model requests, oldest first, replayed from a Claude Code transcript (untrusted JSONL).
 *
 * Claude Code writes one assistant record per content block, every one repeating its response's `message.id` and
 * `usage`, so a request is counted once, at its first record. Sidechain records are subagent requests with a prompt of
 * their own, and `<synthetic>` records are local notices that never reached the API; neither says anything about the
 * main conversation's cache. A `compact_boundary` marks the next request as the rewrite compaction causes by design.
 */
export function claudeContextRequests(transcript: string): AgentChatContextRequest[] {
    const requests: AgentChatContextRequest[] = [];
    const seen = new Set<string>();
    let isAfterCompaction = false;
    for (const line of transcript.split('\n')) {
        const record = parseLine(line);
        if (!record) continue;
        if (record.type === 'system' && record.subtype === 'compact_boundary') {
            isAfterCompaction = true;
            continue;
        }
        if (record.type !== 'assistant' || record.isSidechain === true) continue;
        const message = isRecord(record.message) ? record.message : undefined;
        const id = stringField(message?.id);
        const model = stringField(message?.model);
        if (!message || !id || model === '<synthetic>' || seen.has(id)) continue;
        const request = contextRequest(message, record.timestamp, model);
        if (!request) continue;
        seen.add(id);
        if (isAfterCompaction) request.afterCompaction = true;
        isAfterCompaction = false;
        requests.push(request);
    }
    return requests.slice(-MAX_AGENT_CHAT_CONTEXT_REQUESTS);
}

function contextRequest(
    message: Record<string, unknown>,
    timestamp: unknown,
    model: string | undefined,
): AgentChatContextRequest | undefined {
    const { usage } = message;
    const at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    if (!isRecord(usage) || typeof usage.input_tokens !== 'number' || !(at >= 0)) return undefined;
    const cacheWrite = count(usage.cache_creation_input_tokens);
    const cacheTtlMinutes = claudeCacheTtlMinutes(usage);
    const cacheWriteUsd =
        model && cacheWrite > 0
            ? estimateCacheRewriteUsd(cacheWrite, model, cacheTtlMinutes ?? 5)
            : undefined;
    return {
        at,
        ...(model && { model: clip(model, 200) }),
        input: count(usage.input_tokens),
        cacheRead: count(usage.cache_read_input_tokens),
        cacheWrite,
        output: count(usage.output_tokens),
        ...(cacheTtlMinutes && { cacheTtlMinutes }),
        ...(cacheWriteUsd !== undefined && { cacheWriteUsd }),
    };
}

function parseLine(line: string): Record<string, unknown> | undefined {
    // Cheap pre-filter: a transcript tail is mostly tool output, and only these two record kinds matter here.
    if (!line.includes('"assistant"') && !line.includes('compact_boundary')) return undefined;
    try {
        const record: unknown = JSON.parse(line);
        return isRecord(record) ? record : undefined;
    } catch {
        return undefined;
    }
}

function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}
