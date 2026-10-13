/**
 * The fake Grok ACP agent's recorded conversation and the `session/load` replay built from it. Live turns record every
 * frame they send; the replay sends what Grok Build 1.0.50 sends instead, one merged `tool_call` frame per tool call.
 */

export interface StoredFrame {
    method: string;
    update: Record<string, unknown>;
    /**
     * When the frame was emitted, replayed as `_meta.agentTimestampMs` like Grok Build's own records.
     */
    at?: number;
}

/**
 * The tool call fields a merged replay frame keeps, each taken from the latest frame that carries it. `rawOutput` is
 * left out: Grok Build 1.0.50 does not replay it.
 */
const MERGED_TOOL_CALL_FIELDS = [
    'title',
    'kind',
    'status',
    'content',
    'rawInput',
    '_meta',
] as const;

function isToolCallFrame(frame: StoredFrame): boolean {
    const kind = frame.update.sessionUpdate;
    return (
        frame.method === 'session/update' &&
        (kind === 'tool_call' || kind === 'tool_call_update') &&
        typeof frame.update.toolCallId === 'string'
    );
}

/**
 * The frames `session/load` replays: every non-tool frame unchanged and in order, and each tool call folded into one
 * `tool_call` frame at its first frame's position, carrying the call's final `status`, `title`, `kind`, `content`, and
 * `rawInput`. Grok Build 1.0.50 replays a rejected shell call as exactly such a frame, `status: "failed"` with the
 * rejection text, and no later `tool_call_update`.
 */
export function replayFrames(frames: readonly StoredFrame[]): StoredFrame[] {
    const merged = new Map<string, StoredFrame>();
    const replay: StoredFrame[] = [];
    for (const frame of frames) {
        if (!isToolCallFrame(frame)) {
            replay.push(frame);
            continue;
        }
        const toolCallId = frame.update.toolCallId as string;
        let call = merged.get(toolCallId);
        if (!call) {
            call = {
                method: frame.method,
                update: { sessionUpdate: 'tool_call', toolCallId },
                ...(frame.at !== undefined && { at: frame.at }),
            };
            merged.set(toolCallId, call);
            replay.push(call);
        }
        for (const field of MERGED_TOOL_CALL_FIELDS)
            if (frame.update[field] !== undefined) call.update[field] = frame.update[field];
    }
    return replay;
}
