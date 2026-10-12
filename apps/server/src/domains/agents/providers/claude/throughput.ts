import type { AgentThroughputSpeed } from '@caxri/protocol';

import type { ThroughputLineScanner, ThroughputSink } from '../../throughput';
import {
    parseThroughputLine,
    positiveTokens,
    throughputRecord,
    throughputTimestamp,
} from '../../throughput';

interface OpenResponse {
    id: string;
    /**
     * Absent when the response has no recorded start; its lines are still tracked so they are not mistaken for a new
     * response, but it is never reported.
     */
    startedAt?: number;
    endedAt: number;
    outputTokens: number;
    model?: string;
    speed?: AgentThroughputSpeed;
}

/**
 * A real prompt starts a turn; tool results and harness-injected meta lines are only input to the next request.
 */
function isPromptLine(entry: Record<string, unknown>): boolean {
    if (entry.isMeta === true || entry.isCompactSummary === true) return false;
    const content = throughputRecord(entry.message).content;
    if (typeof content === 'string') return true;
    return (
        Array.isArray(content) &&
        content.every((block) => throughputRecord(block).type !== 'tool_result')
    );
}

/**
 * Measures each Claude Code model response from its transcript. Claude Code writes one line per finished content block,
 * each carrying the API message `id` and the response's usage, so a response is the run of lines sharing an `id`.
 *
 * The request starts at the last `user` line before the response's first line (the prompt or the final tool result) and
 * ends at the response's last line. Claude Code starts a streamed tool call before the response finishes, so its
 * `tool_result` can appear between two lines of the same response; that does not split the response. A response whose
 * last input precedes the end of the previous response has no recorded start and is skipped rather than estimated.
 * Sidechain (subagent) lines belong to other conversations and are ignored. Each response carries its `message.model`
 * and `usage.speed` (`fast` while `/fast` is on).
 */
export function createClaudeThroughputScanner(): ThroughputLineScanner {
    let lastInputAt: number | undefined;
    let previousEndedAt: number | undefined;
    let open: OpenResponse | undefined;
    const report = (sink: ThroughputSink) => {
        if (open?.startedAt === undefined || open.endedAt <= open.startedAt) return;
        sink.response({
            completedAt: open.endedAt,
            durationMs: open.endedAt - open.startedAt,
            key: open.id,
            outputTokens: open.outputTokens,
            ...(open.model !== undefined && { model: open.model }),
            ...(open.speed !== undefined && { speed: open.speed }),
        });
    };
    const close = () => {
        if (open) previousEndedAt = open.endedAt;
        open = undefined;
    };
    return {
        scanLine(line: string, sink: ThroughputSink): void {
            const entry = parseThroughputLine(line);
            if (!entry || entry.isSidechain === true) return;
            const at = throughputTimestamp(entry.timestamp);
            if (at === undefined) return;
            if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
                close();
                lastInputAt = undefined;
                return;
            }
            if (entry.type === 'user') {
                if (isPromptLine(entry)) {
                    close();
                    sink.turnStarted();
                }
                lastInputAt = at;
                return;
            }
            if (entry.type !== 'assistant' || entry.isApiErrorMessage === true) return;
            const message = throughputRecord(entry.message);
            if (typeof message.id !== 'string' || message.model === '<synthetic>') return;
            const usage = throughputRecord(message.usage);
            const outputTokens = positiveTokens(usage.output_tokens);
            if (open?.id === message.id) {
                open.endedAt = at;
                if (outputTokens !== undefined && outputTokens > open.outputTokens)
                    open.outputTokens = outputTokens;
                if (open.outputTokens > 0) report(sink);
                return;
            }
            close();
            const hasRecordedStart =
                lastInputAt !== undefined &&
                (previousEndedAt === undefined || lastInputAt >= previousEndedAt);
            open = {
                endedAt: at,
                id: message.id,
                outputTokens: outputTokens ?? 0,
                ...(typeof message.model === 'string' && message.model && { model: message.model }),
                ...(typeof usage.speed === 'string' && {
                    speed: usage.speed === 'fast' ? 'fast' : 'standard',
                }),
                ...(hasRecordedStart && { startedAt: lastInputAt }),
            };
            if (open.outputTokens > 0) report(sink);
        },
    };
}
