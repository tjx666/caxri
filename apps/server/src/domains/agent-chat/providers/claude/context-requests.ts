import type { AgentChatContextRequest, AgentChatContextTurn } from '@caxri/protocol';
import {
    MAX_AGENT_CHAT_CONTEXT_REQUESTS,
    MAX_AGENT_CHAT_CONTEXT_TURN_TOOLS,
} from '@caxri/protocol';

import { estimateCacheRewriteUsd } from '../../../usage';
import { clip, isRecord, stringField } from '../../chat-items';
import { claudeCacheTtlMinutes } from './context';

/**
 * The main conversation's model requests, oldest first, replayed from a Claude Code transcript (untrusted JSONL).
 *
 * Claude Code writes one assistant record per content block, every one repeating its response's `message.id` and
 * `usage`, so a request is counted once, at its first record. Sidechain records are subagent requests with a prompt of
 * their own, and `<synthetic>` records are local notices that never reached the API; neither says anything about the
 * main conversation's cache. A `compact_boundary` marks the next request as the rewrite compaction causes by design.
 *
 * Each request also gets a `turn`: the content recorded since the previous request (the user's messages, the previous
 * response, tool results by tool name) weighed by length and rescaled to the real growth of the prompt.
 */
export function claudeContextRequests(transcript: string): AgentChatContextRequest[] {
    const requests: AgentChatContextRequest[] = [];
    const seen = new Set<string>();
    const toolNames = new Map<string, string>();
    let isAfterCompaction = false;
    let pending = emptyWeights();
    for (const line of transcript.split('\n')) {
        const record = parseLine(line);
        if (!record) continue;
        if (record.type === 'system' && record.subtype === 'compact_boundary') {
            isAfterCompaction = true;
            continue;
        }
        if (record.isSidechain === true) continue;
        const message = isRecord(record.message) ? record.message : undefined;
        if (record.type === 'user') {
            if (message) addUserWeights(pending, message.content, toolNames);
            continue;
        }
        if (record.type !== 'assistant') continue;
        const id = stringField(message?.id);
        const model = stringField(message?.model);
        if (!message || !id || model === '<synthetic>') continue;
        if (seen.has(id)) {
            // Later content blocks of a response already counted join the growth of the request that follows it.
            addAssistantWeights(pending, message.content, toolNames);
            continue;
        }
        const request = contextRequest(message, record.timestamp, model);
        if (!request) continue;
        seen.add(id);
        if (isAfterCompaction) request.afterCompaction = true;
        else {
            const previous = requests.at(-1);
            const turn = previous && contextTurn(pending, promptOf(request) - promptOf(previous));
            if (turn) request.turn = turn;
        }
        isAfterCompaction = false;
        pending = emptyWeights();
        addAssistantWeights(pending, message.content, toolNames);
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

/**
 * Length-based weights of the content added since the last request, by where it came from. Characters, not tokens:
 * {@link contextTurn} rescales them to the prompt growth the usage reports.
 */
interface TurnWeights {
    user: number;
    modelOutput: number;
    toolResults: number;
    tools: Map<string, number>;
}

/**
 * Tool results the transcript carries without a matching call (a trimmed tail) are named like this.
 */
const UNKNOWN_TOOL = 'unknown';

function emptyWeights(): TurnWeights {
    return { user: 0, modelOutput: 0, toolResults: 0, tools: new Map() };
}

function promptOf(request: AgentChatContextRequest): number {
    return request.input + request.cacheRead + request.cacheWrite;
}

function addAssistantWeights(
    weights: TurnWeights,
    content: unknown,
    toolNames: Map<string, string>,
): void {
    if (!Array.isArray(content)) return;
    for (const block of content) {
        if (isRecord(block)) addAssistantBlock(weights, block, toolNames);
    }
}

function addAssistantBlock(
    weights: TurnWeights,
    block: Record<string, unknown>,
    toolNames: Map<string, string>,
): void {
    switch (block.type) {
        case 'text': {
            weights.modelOutput += textLength(block.text);
            return;
        }
        case 'thinking': {
            weights.modelOutput += textLength(block.thinking);
            return;
        }
        case 'tool_use': {
            const name = stringField(block.name);
            const id = stringField(block.id);
            if (id && name) toolNames.set(id, name);
            weights.modelOutput += (name?.length ?? 0) + jsonLength(block.input);
            return;
        }
        default: {
            return;
        }
    }
}

function addUserWeights(
    weights: TurnWeights,
    content: unknown,
    toolNames: Map<string, string>,
): void {
    if (typeof content === 'string') {
        weights.user += content.length;
        return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === 'text') weights.user += textLength(block.text);
        else if (block.type === 'tool_result') {
            const length = resultLength(block.content);
            const name = toolNames.get(stringField(block.tool_use_id) ?? '') ?? UNKNOWN_TOOL;
            weights.toolResults += length;
            weights.tools.set(name, (weights.tools.get(name) ?? 0) + length);
        }
    }
}

function textLength(value: unknown): number {
    return typeof value === 'string' ? value.length : 0;
}

function jsonLength(value: unknown): number {
    try {
        // `undefined` (a tool call without input) stringifies to nothing.
        return (JSON.stringify(value) as string | undefined)?.length ?? 0;
    } catch {
        return 0;
    }
}

function resultLength(content: unknown): number {
    if (typeof content === 'string') return content.length;
    if (!Array.isArray(content)) return 0;
    return content.reduce<number>(
        (sum, part) => sum + (isRecord(part) ? textLength(part.text) : 0),
        0,
    );
}

/**
 * Splits the real growth of the prompt across the collected weights, so the three parts always add up to `growth`
 * (largest remainder), and names the heaviest tools. Undefined when the prompt did not grow or nothing was collected.
 */
function contextTurn(weights: TurnWeights, growth: number): AgentChatContextTurn | undefined {
    const total = weights.user + weights.modelOutput + weights.toolResults;
    if (growth <= 0 || total <= 0) return undefined;
    const [user, modelOutput, toolResults] = apportion(
        [weights.user, weights.modelOutput, weights.toolResults],
        growth,
    );
    const tools = [...weights.tools]
        .map(([name, weight]) => ({
            name: clip(name, 200),
            tokens: Math.round((weight / weights.toolResults) * toolResults),
        }))
        .filter((tool) => tool.tokens > 0)
        .toSorted((a, b) => b.tokens - a.tokens)
        .slice(0, MAX_AGENT_CHAT_CONTEXT_TURN_TOOLS);
    return { user, modelOutput, toolResults, tools };
}

/**
 * Integer shares of `amount` proportional to `weights`, summing to exactly `amount`.
 */
function apportion(weights: readonly number[], amount: number): number[] {
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const exact = weights.map((weight) => (weight / total) * amount);
    const shares = exact.map(Math.floor);
    let rest = amount - shares.reduce((sum, share) => sum + share, 0);
    const order = exact
        .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
        .toSorted((a, b) => b.fraction - a.fraction);
    for (const { index } of order) {
        if (rest <= 0) break;
        shares[index] += 1;
        rest -= 1;
    }
    return shares;
}

function parseLine(line: string): Record<string, unknown> | undefined {
    // Cheap pre-filter: a transcript tail is mostly tool output, and only these record kinds matter here.
    if (
        !line.includes('"assistant"') &&
        !line.includes('"user"') &&
        !line.includes('compact_boundary')
    )
        return undefined;
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
