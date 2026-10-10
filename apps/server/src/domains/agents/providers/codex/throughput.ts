import type { ThroughputLineScanner, ThroughputSink } from '../../throughput';
import {
    parseThroughputLine,
    positiveTokens,
    throughputRecord,
    throughputTimestamp,
} from '../../throughput';

/**
 * Rollout items the model generated. Each is written when the item finishes streaming.
 */
const MODEL_OUTPUT_ITEMS = new Set([
    'custom_tool_call',
    'function_call',
    'image_generation_call',
    'local_shell_call',
    'reasoning',
    'web_search_call',
]);
/**
 * Rollout items that become input to the next request: tool results and messages from other Agents.
 */
const REQUEST_INPUT_ITEMS = new Set([
    'agent_message',
    'custom_tool_call_output',
    'function_call_output',
    'local_shell_call_output',
]);

/**
 * Measures each Codex model response from its rollout. Codex writes one `token_usage_record` per response, keyed by
 * `response_id` and carrying that response's own `usage.output_tokens` (reasoning included).
 *
 * The request starts at the last input recorded before the response produced anything (`task_started`, a user or
 * developer message, or a tool result) and ends at the last generated item before the usage record. The usage record
 * itself is not the end: Codex may already be running a streamed tool call when it writes the record. Inputs recorded
 * after the response began generating are tool results from parallel calls that finished mid-stream, so they do not
 * restart the clock. A response with no recorded start (a resumed rollout, a compaction request) is skipped rather than
 * estimated.
 */
export function createCodexThroughputScanner(): ThroughputLineScanner {
    let requestStartedAt: number | undefined;
    let lastOutputAt: number | undefined;
    const resetRequest = () => {
        requestStartedAt = undefined;
        lastOutputAt = undefined;
    };
    return {
        scanLine(line: string, sink: ThroughputSink): void {
            const entry = parseThroughputLine(line);
            if (!entry) return;
            const at = throughputTimestamp(entry.timestamp);
            if (at === undefined) return;
            const payload = throughputRecord(entry.payload);
            switch (entry.type) {
                case 'event_msg': {
                    switch (payload.type) {
                        case 'task_started': {
                            requestStartedAt = at;
                            lastOutputAt = undefined;
                            sink.turnStarted();

                            break;
                        }
                        case 'turn_aborted':
                        case 'context_compacted': {
                            resetRequest();

                            break;
                        }
                        case 'task_complete': {
                            const firstToken = payload.time_to_first_token_ms;
                            if (typeof firstToken === 'number' && firstToken >= 0)
                                sink.turnTimeToFirstToken(firstToken);

                            break;
                        }
                        // No default
                    }
                    return;
                }
                case 'compacted': {
                    resetRequest();
                    return;
                }
                case 'response_item': {
                    const itemType = typeof payload.type === 'string' ? payload.type : '';
                    const isOutput =
                        MODEL_OUTPUT_ITEMS.has(itemType) ||
                        (itemType === 'message' && payload.role === 'assistant');
                    const isInput =
                        REQUEST_INPUT_ITEMS.has(itemType) ||
                        (itemType === 'message' &&
                            (payload.role === 'user' || payload.role === 'developer'));
                    if (isOutput) lastOutputAt = at;
                    else if (isInput && lastOutputAt === undefined) requestStartedAt = at;
                    return;
                }
                case 'token_usage_record': {
                    const outputTokens = positiveTokens(
                        throughputRecord(payload.usage).output_tokens,
                    );
                    const key = payload.response_id;
                    if (
                        outputTokens !== undefined &&
                        typeof key === 'string' &&
                        requestStartedAt !== undefined &&
                        lastOutputAt !== undefined &&
                        lastOutputAt > requestStartedAt
                    )
                        sink.response({
                            completedAt: lastOutputAt,
                            durationMs: lastOutputAt - requestStartedAt,
                            key,
                            outputTokens,
                        });
                    resetRequest();
                    return;
                }
                default:
            }
        },
    };
}
