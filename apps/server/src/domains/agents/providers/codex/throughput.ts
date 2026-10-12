import type { AgentThroughputSpeed } from '@caxri/protocol';

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
 *
 * Each `turn_context` names the turn's model. The speed tier is known only from the thread's first
 * `thread_settings_applied` on: Codex writes that event when the thread's settings change (`/fast`), not for the
 * configured tier a thread starts with, so earlier responses carry no tier rather than a guessed one.
 */
export function createCodexThroughputScanner(): ThroughputLineScanner {
    let requestStartedAt: number | undefined;
    let lastOutputAt: number | undefined;
    let model: string | undefined;
    let speed: AgentThroughputSpeed | undefined;
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
                        case 'thread_settings_applied': {
                            const settings = throughputRecord(payload.thread_settings);
                            if (typeof settings.model === 'string' && settings.model)
                                model = settings.model;
                            const tier = settings.service_tier;
                            if (typeof tier === 'string')
                                speed =
                                    tier === 'priority' || tier === 'fast'
                                        ? 'fast'
                                        : tier === 'flex'
                                          ? 'flex'
                                          : 'standard';

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
                case 'turn_context': {
                    if (typeof payload.model === 'string' && payload.model) model = payload.model;
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
                            ...(model !== undefined && { model }),
                            ...(speed !== undefined && { speed }),
                        });
                    resetRequest();
                    return;
                }
                default:
            }
        },
    };
}
